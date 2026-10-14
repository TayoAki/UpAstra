import fs from "node:fs";
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileRef, Job } from "../shared/types";
import { HttpError, currentWorkspaceId } from "./store";
import { signingSecret } from "./auth";

// File storage for client uploads. An S3-compatible bucket in production
// (Railway buckets, S3, R2 — set S3_BUCKET + credentials), local disk in dev.
// Keys always start with the workspace id, and reads are authorized by the
// caller before they reach this module.

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024;

const ALLOWED = /^(image\/(png|jpe?g|webp|gif|svg\+xml)|video\/(mp4|quicktime|webm)|application\/(pdf|zip|vnd\.openxmlformats-officedocument\.[\w.]+|msword|vnd\.ms-excel)|text\/(plain|csv|markdown))$/;

interface Store {
  kind: "s3" | "disk";
  put(key: string, body: Buffer, type: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; type: string }>;
  /** Delete every object under a prefix (a whole workspace's uploads). */
  deletePrefix(prefix: string): Promise<number>;
}

class DiskStore implements Store {
  kind = "disk" as const;
  constructor(private dir: string) {}
  private file(key: string) {
    const f = path.resolve(this.dir, key);
    if (!f.startsWith(path.resolve(this.dir) + path.sep)) throw new HttpError(400, "Bad file key");
    return f;
  }
  async put(key: string, body: Buffer, type: string) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    fs.writeFileSync(`${f}.type`, type);
  }
  async get(key: string) {
    const f = this.file(key);
    if (!fs.existsSync(f)) throw new HttpError(404, "File not found");
    return { body: fs.readFileSync(f), type: fs.existsSync(`${f}.type`) ? fs.readFileSync(`${f}.type`, "utf8") : "application/octet-stream" };
  }
  async deletePrefix(prefix: string) {
    const dir = this.file(prefix.replace(/\/$/, ""));
    if (!fs.existsSync(dir)) return 0;
    const n = fs.readdirSync(dir).filter((f) => !f.endsWith(".type")).length;
    fs.rmSync(dir, { recursive: true, force: true });
    return n;
  }
}

class S3Store implements Store {
  kind = "s3" as const;
  private client: S3Client;
  constructor(private bucket: string) {
    this.client = new S3Client({
      region: process.env.S3_REGION ?? "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials:
        process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, body: Buffer, type: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: type }));
  }
  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: Buffer.from(await r.Body!.transformToByteArray()), type: r.ContentType ?? "application/octet-stream" };
    } catch {
      throw new HttpError(404, "File not found");
    }
  }
  async deletePrefix(prefix: string) {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

let store: Store | null = null;
export function fileStore(): Store {
  if (!store) store = process.env.S3_BUCKET ? new S3Store(process.env.S3_BUCKET) : new DiskStore(path.join(process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"), "uploads"));
  return store;
}

export async function saveUpload(workspaceId: string, name: string, type: string, body: Buffer): Promise<FileRef> {
  if (!body.length) throw new HttpError(400, "Empty file");
  if (body.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `Files must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  const clean = type.split(";")[0].trim().toLowerCase();
  if (!ALLOWED.test(clean)) throw new HttpError(415, `That file type (${clean || "unknown"}) isn't accepted`);
  const safeName = name.replace(/[^\w.\- ]+/g, "_").slice(-100) || "file";
  const key = `${workspaceId}/${randomUUID()}-${safeName.replace(/\s+/g, "_")}`;
  await fileStore().put(key, body, clean);
  return { key, name: safeName, size: body.length, type: clean };
}

export const keyBelongsTo = (key: string, workspaceId: string) => key.startsWith(`${workspaceId}/`) && !key.includes("..");

// ---------------------------------------------------------------------------
// Generated outputs. Real renders are megabytes, so they live in the store
// (never in the workspace document); the generation keeps a "file:<key>"
// pointer and the browser gets short-lived signed links.

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Move a base64 image output into the store. Small SVG proofs stay inline. */
export async function persistOutput(workspaceId: string, name: string, url: string | undefined): Promise<string | undefined> {
  const m = url?.match(/^data:(image\/[\w+.-]+);base64,(.*)$/s);
  if (!m || m[1] === "image/svg+xml") return url;
  const key = `${workspaceId}/gen/${name}.${EXT[m[1]] ?? "bin"}`;
  await fileStore().put(key, Buffer.from(m[2], "base64"), m[1]);
  return `file:${key}`;
}

/** An image a model can look at: http(s) as-is, stored files inlined. SVG and other tenants' files are refused. */
export async function toDataUrl(url: string): Promise<string | null> {
  if (/^https?:\/\//.test(url)) return url;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/.test(url)) return url;
  if (!url.startsWith("file:")) return null;
  const key = url.slice(5);
  const ws = currentWorkspaceId();
  if (!ws || !keyBelongsTo(key, ws)) return null;
  try {
    const f = await fileStore().get(key);
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type) || f.body.length > 8 * 1024 * 1024) return null;
    return `data:${f.type};base64,${f.body.toString("base64")}`;
  } catch {
    return null;
  }
}

const LINK_TTL_S = 6 * 3600;
const sign = (exp: number, key: string) => createHmac("sha256", signingSecret()).update(`file:${exp}:${key}`).digest("base64url");

/** Browser-safe link for a stored output; data/http URLs pass through. Expiry is
 *  rounded up to the hour so the link stays stable across polls (no image flicker). */
export function viewUrl(url: string | undefined, absolute = false): string | undefined {
  if (!url?.startsWith("file:")) return url;
  const key = url.slice(5);
  const exp = Math.ceil((Date.now() / 1000 + LINK_TTL_S) / 3600) * 3600;
  const path = `/f/${exp}/${sign(exp, key)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return absolute ? `${(process.env.APP_URL ?? "").replace(/\/$/, "")}${path}` : path;
}

export function verifyFileLink(exp: string, sig: string, key: string): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(e, key));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A job's visual references: client photos from the portal brief first, then linked URLs. */
export function referenceImages(job: Pick<Job, "portal" | "referenceAssets">): string[] {
  return [
    ...(job.portal?.files ?? []).filter((f) => /^image\/(png|jpe?g|webp|gif)$/.test(f.type)).map((f) => `file:${f.key}`),
    ...job.referenceAssets.filter((a) => /^https?:/.test(a)),
  ];
}
