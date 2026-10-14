import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HttpError } from "./db";

// Rendered videos: an S3-compatible bucket in production (S3_BUCKET), local
// disk otherwise. Keys start with "<workspaceId>/" so a workspace's files can
// be removed together. Reads support byte ranges so videos can be scrubbed.

export interface Ranged {
  stream: Readable;
  size: number;
  type: string;
  start: number;
  end: number;
}

interface Store {
  put(key: string, file: string, type: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Something ffmpeg can open with seeking: a local path or a short-lived signed URL. */
  readUrl(key: string): Promise<string>;
  read(key: string, range?: { start: number; end?: number }): Promise<Ranged>;
  deletePrefix(prefix: string): Promise<void>;
}

class DiskStore implements Store {
  constructor(private dir: string) {}
  private file(key: string) {
    const f = path.resolve(this.dir, key);
    if (!f.startsWith(path.resolve(this.dir) + path.sep)) throw new HttpError(400, "Bad key");
    return f;
  }
  async put(key: string, file: string) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(file, f);
  }
  /** Move instead of copy when the source is a temp file (saves gigabytes for footage). */
  async move(key: string, file: string) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      fs.renameSync(file, f);
    } catch {
      fs.copyFileSync(file, f);
      fs.rmSync(file, { force: true });
    }
  }
  async exists(key: string) {
    return fs.existsSync(this.file(key));
  }
  async readUrl(key: string) {
    return this.file(key);
  }
  async read(key: string, range?: { start: number; end?: number }) {
    const f = this.file(key);
    if (!fs.existsSync(f)) throw new HttpError(404, "Video not found");
    const size = fs.statSync(f).size;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    return { stream: fs.createReadStream(f, { start, end }), size, type: "video/mp4", start, end };
  }
  async deletePrefix(prefix: string) {
    fs.rmSync(this.file(prefix.replace(/\/$/, "")), { recursive: true, force: true });
  }
}

class S3Store implements Store {
  private client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : undefined,
  });
  // Shares the bucket with other apps: everything lives under this prefix.
  private prefix = (process.env.S3_PREFIX ?? "clip-operator/").replace(/^\/+/, "");
  constructor(private bucket: string) {}
  async put(key: string, file: string, type: string) {
    // Streamed: footage files can be gigabytes.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefix + key, Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size, ContentType: type }));
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
      return true;
    } catch {
      return false;
    }
  }
  async readUrl(key: string) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }), { expiresIn: 3 * 3600 });
  }
  async read(key: string, range?: { start: number; end?: number }) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
      const size = head.ContentLength ?? 0;
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? size - 1, size - 1);
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key, Range: `bytes=${start}-${end}` }));
      return { stream: r.Body as Readable, size, type: head.ContentType ?? "video/mp4", start, end };
    } catch {
      throw new HttpError(404, "Video not found");
    }
  }
  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix + prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

let store: Store | null = null;
export function videoStore(): Store {
  if (!store) store = process.env.S3_BUCKET ? new S3Store(process.env.S3_BUCKET) : new DiskStore(path.join(process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"), "videos"));
  return store;
}

export const storageKind = () => (process.env.S3_BUCKET ? "bucket" : "disk");
export { Readable };
