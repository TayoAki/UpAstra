import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { State } from "../api";
import { useApp } from "../store";

/** POST a file with progress; resolves with the server's JSON (fresh state for most routes). */
export function uploadFile<T = State>(url: string, file: File, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 300) reject(new Error(body.error ?? "Upload failed"));
      else resolve(body as T);
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
    xhr.send(file);
  });
}

/** Upload a video with progress (footage can be gigabytes, so it streams with XHR). */
export function UploadFootage({ campaignId, replace, label, small }: { campaignId: string; replace?: string; label: string; small?: boolean }) {
  const { setState, toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);

  const send = (file: File) =>
    uploadFile(`/api/campaigns/${campaignId}/footage/upload${replace ? `?replace=${encodeURIComponent(replace)}` : ""}`, file, setPct).then(
      (st) => (setState(st), toast(`Uploaded ${file.name}`)),
      (e: Error) => toast(e.message, true),
    );

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setPct(0);
      await send(f);
    }
    setPct(null);
    if (input.current) input.current.value = "";
  };

  return (
    <>
      <input ref={input} type="file" accept="video/*" multiple={!replace} hidden onChange={(e) => pick(e.target.files)} />
      <button className={`btn ${small ? "sm" : ""}`} disabled={pct !== null} onClick={() => input.current?.click()}>
        <Upload size={14} /> {pct !== null ? `Uploading ${pct}%` : label}
      </button>
    </>
  );
}
