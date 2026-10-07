import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileRef } from "../shared/types";
import { HttpError } from "./store";

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
