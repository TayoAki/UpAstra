import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FootageFile, LinkRef } from "../shared/types";
import { HttpError, newId } from "./db";

// Reading briefs and footage from where campaigns publish them: Google Docs,
// public Google Drive folders, or any public web page.

const UA = "Mozilla/5.0 (compatible; UGCMediaClips/1.0)";

function privateIP(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return privateIP(l.slice(7));
    return l === "::1" || l === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(l);
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Fetch a public URL, refusing anything that resolves to a private network (also after redirects). */
export async function safeFetch(url: string, init: RequestInit = {}, hops = 4): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only http(s) links can be read");
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(422, `Couldn't find ${u.hostname}`);
  // Tests serve footage from localhost; nothing else may reach private networks.
  if (addrs.some((a) => privateIP(a.address)) && process.env.ALLOW_PRIVATE_FETCH !== "1") throw new HttpError(400, "That address can't be fetched");
  const res = await fetch(u, { ...init, redirect: "manual", headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    if (hops <= 0) throw new HttpError(422, "Too many redirects");
    return safeFetch(new URL(res.headers.get("location")!, u).toString(), init, hops - 1);
  }
  return res;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

/** Links in an HTML page, unwrapping Google's /url?q= redirects. */
export function htmlLinks(html: string): LinkRef[] {
  const out: LinkRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = decode(m[1]);
    const q = href.match(/^https?:\/\/(?:www\.)?google\.com\/url\?q=([^&]+)/);
    if (q) href = decodeURIComponent(q[1]);
    if (!/^https?:\/\//.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ label: decode(m[2].replace(/<[^>]+>/g, "")).trim().slice(0, 120) || href, url: href });
  }
  return out;
}

export const htmlText = (html: string) =>
  decode(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n* ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/** Drive's own thumbnail links expire within hours; this endpoint doesn't (for public files). */
export const driveThumb = (fileId: string) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w480`;

export const googleDocId = (url: string) => url.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/)?.[1];
export const driveFolderId = (url: string) => url.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)([\w-]{20,})/)?.[1];
export const driveFileId = (url: string) => url.match(/drive\.google\.com\/file\/d\/([\w-]{20,})/)?.[1];

/** Brief text plus every link in it, from a Google Doc (shared "anyone with the link") or a public page. */
export async function readBriefUrl(url: string): Promise<{ kind: "gdoc" | "url"; text: string; links: LinkRef[] }> {
  const docId = googleDocId(url);
  if (docId) {
    const base = `https://docs.google.com/document/d/${docId}/export?format=`;
    const [txt, html] = await Promise.all([fetch(`${base}txt`, { headers: { "User-Agent": UA } }), fetch(`${base}html`, { headers: { "User-Agent": UA } })]);
    if (!txt.ok || !(txt.headers.get("content-type") ?? "").includes("text/plain"))
      throw new HttpError(422, "Couldn't open that Google Doc. Set sharing to “Anyone with the link can view”, or paste the brief text.");
    const text = (await txt.text()).replace(/^﻿/, "").trim();
    const links = html.ok ? htmlLinks(await html.text()) : [];
    // The plain-text export drops link targets; put them next to their labels so extraction sees them.
    return { kind: "gdoc", text: withLinks(text, links), links };
  }
  const res = await safeFetch(url);
  if (!res.ok) throw new HttpError(422, `That page returned ${res.status}. Paste the brief text instead.`);
  const html = (await res.text()).slice(0, 3_000_000);
  const text = htmlText(html);
  if (text.length < 80) throw new HttpError(422, "That page had no readable brief. Paste the text instead.");
  return { kind: "url", text: text.slice(0, 40_000), links: htmlLinks(html) };
}

function withLinks(text: string, links: LinkRef[]): string {
  let out = text;
  for (const l of links) {
    // Only annotate labels that appear once — "Backup" could be anywhere.
    if (!l.label || l.label === l.url || l.label.length < 4 || out.split(l.label).length !== 2) continue;
    const i = out.indexOf(l.label);
    if (i >= 0 && !out.slice(i, i + l.label.length + 200).includes(l.url)) out = `${out.slice(0, i + l.label.length)} (${l.url})${out.slice(i + l.label.length)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Footage

const kindOf = (mime: string | undefined, name: string): FootageFile["kind"] =>
  mime?.includes("folder") ? "folder" : mime?.startsWith("video") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(name) ? "video" : mime?.startsWith("image") || /\.(png|jpe?g|webp|gif)$/i.test(name) ? "image" : "other";

/** Files in a public Google Drive folder (one level). */
export async function listDriveFolder(link: LinkRef): Promise<FootageFile[]> {
  const id = driveFolderId(link.url);
  if (!id) throw new HttpError(400, "Not a Google Drive folder link");
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new HttpError(422, `Drive folder "${link.label}" isn't public (${res.status})`);
  const html = await res.text();
  const files: FootageFile[] = [];
  for (const chunk of html.split('<div class="flip-entry" id="entry-').slice(1)) {
    const sourceId = chunk.match(/^([\w-]+)"/)?.[1];
    const href = chunk.match(/<a href="([^"]+)"/)?.[1];
    const name = decode(chunk.match(/flip-entry-title">([^<]*)</)?.[1] ?? "").trim();
    if (!sourceId || !href || !name) continue;
    const thumb = chunk.match(/class="flip-entry-thumb"><img src="([^"]+)"/)?.[1];
    const mime = chunk.match(/\/type\/([\w.+-]+\/[\w.+-]+)"/)?.[1] ?? (/\/folders\//.test(href) ? "application/vnd.google-apps.folder" : undefined);
    files.push({
      id: newId("ftg"),
      sourceId,
      name,
      kind: kindOf(mime, name),
      mime,
      viewUrl: decode(href),
      thumbUrl: thumb ? driveThumb(sourceId) : undefined,
      folderUrl: link.url,
      folderLabel: link.label,
    });
  }
  return files;
}

/** Footage behind every footage link: Drive folders are listed, single files and other links kept as-is. */
export async function resolveFootage(links: LinkRef[]): Promise<{ files: FootageFile[]; errors: string[] }> {
  const files: FootageFile[] = [];
  const errors: string[] = [];
  for (const link of links) {
    try {
      if (driveFolderId(link.url)) files.push(...(await listDriveFolder(link)));
      else {
        const fileId = driveFileId(link.url);
        const pathName = (() => {
          try {
            return new URL(link.url).pathname;
          } catch {
            return "";
          }
        })();
        files.push({ id: newId("ftg"), sourceId: fileId ?? link.url, name: link.label, kind: kindOf(undefined, pathName), viewUrl: link.url, folderUrl: link.url, folderLabel: link.label });
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  // The same file often sits in a main and a backup folder; keep the first copy.
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    const key = f.name.replace(/^copy of /i, "").replace(/\.\w{2,4}$/, "").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { files: unique, errors };
}
