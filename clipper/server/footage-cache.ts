import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FootageFile } from "../shared/types";
import { driveDownloadUrl } from "./media";
import { safeFetch } from "./sources";
import { videoStore } from "./storage";

// Footage is downloaded from its source (usually a public Google Drive file)
// once, then kept in our own storage. Drive limits how often a public file can
// be downloaded in full ("Quota exceeded"), and campaign footage is pulled by
// every clipper on the campaign, so reading it from the source on every render
// would fail. The copy is shared by every workspace that uses the same file.

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const maxBytes = () => Number(process.env.MAX_FOOTAGE_MB ?? 4096) * 1024 * 1024;
const inflight = new Map<string, Promise<void>>();

const isDrive = (f: FootageFile) => /drive\.google\.com/.test(f.viewUrl) && !/\/folders\//.test(f.viewUrl);
export const cacheKey = (f: FootageFile) => `_footage/${isDrive(f) ? "gd" : "url"}-${f.sourceId.replace(/[^\w-]/g, "_").slice(0, 120)}`;
const sourceUrl = (f: FootageFile) => (isDrive(f) ? driveDownloadUrl(f.sourceId) : f.viewUrl);

async function download(f: FootageFile, key: string) {
  // Guarded fetch: footage links come from briefs, so they must not reach private networks.
  const res = await safeFetch(sourceUrl(f), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30 * 60_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body) throw new Error(`the source returned ${res.status}`);
  if (/text\/html/.test(type)) {
    const html = (await res.text()).slice(0, 5000);
    if (/quota exceeded|too many users/i.test(html))
      throw new Error("Google Drive's download limit for this file has been reached (many people download campaign footage). Download it in your browser and upload it on the Footage tab, or try again tomorrow.");
    if (/sign in|accounts\.google/i.test(html)) throw new Error("the file isn't public (Drive asked for a sign-in)");
    throw new Error("the link returned a web page instead of a video");
  }
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > maxBytes()) throw new Error(`the file is ${Math.round(size / 1e6)} MB, over the ${Math.round(maxBytes() / 1e6)} MB limit`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ftg-")), "src");
  try {
    let seen = 0;
    const limited = Readable.fromWeb(res.body as never).on("data", (c: Buffer) => {
      seen += c.length;
      if (seen > maxBytes()) limited.destroy(new Error("file too large"));
    });
    await pipeline(limited, fs.createWriteStream(tmp));
    const store = videoStore() as ReturnType<typeof videoStore> & { move?: (k: string, f: string) => Promise<void> };
    if (store.move) await store.move(key, tmp);
    else await store.put(key, tmp, type || "video/mp4");
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

/** A path or signed URL ffmpeg can seek in, downloading the source first if needed. */
export async function footageSource(f: FootageFile): Promise<string> {
  const store = videoStore();
  if (f.storageKey) return store.readUrl(f.storageKey);
  const key = cacheKey(f);
  if (!(await store.exists(key))) {
    let p = inflight.get(key);
    if (!p) {
      p = download(f, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await p;
  }
  return store.readUrl(key);
}

export const isCached = (f: FootageFile) => videoStore().exists(f.storageKey ?? cacheKey(f));

/** Stream an upload to a local file, enforcing the size limit. Returns its size. */
export async function saveTo(file: string, body: NodeJS.ReadableStream): Promise<number> {
  let seen = 0;
  const counter = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > maxBytes() ? new Error(`Files must be under ${Math.round(maxBytes() / 1e6)} MB`) : null, chunk);
    },
  });
  await pipeline(body, counter, fs.createWriteStream(file));
  if (seen < 1000) throw new Error("The upload was empty");
  return seen;
}

/** Stream an upload into storage under `key`, enforcing the size limit. */
export async function saveStream(key: string, body: NodeJS.ReadableStream, type = "video/mp4"): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
  const tmp = path.join(dir, "src");
  try {
    const seen = await saveTo(tmp, body);
    const store = videoStore() as ReturnType<typeof videoStore> & { move?: (k: string, f: string) => Promise<void> };
    if (store.move) await store.move(key, tmp);
    else await store.put(key, tmp, type);
    return seen;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Stream an uploaded footage file into storage. Returns its key and size. */
export async function saveUpload(workspaceId: string, name: string, body: NodeJS.ReadableStream): Promise<{ key: string; size: number }> {
  const safe = name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(-80) || "footage.mp4";
  const key = `${workspaceId}/footage/${Date.now().toString(36)}-${safe}`;
  return { key, size: await saveStream(key, body) };
}
