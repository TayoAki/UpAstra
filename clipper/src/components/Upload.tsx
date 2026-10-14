import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { State } from "../api";
import { useApp } from "../store";

/** Upload a video with progress (footage can be gigabytes, so it streams with XHR). */
export function UploadFootage({ campaignId, replace, label, small }: { campaignId: string; replace?: string; label: string; small?: boolean }) {
  const { setState, toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);

  const send = (file: File) =>
    new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/campaigns/${campaignId}/footage/upload${replace ? `?replace=${encodeURIComponent(replace)}` : ""}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && setPct(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 300) toast(body.error ?? "Upload failed", true);
          else {
            setState(body as State);
            toast(`Uploaded ${file.name}`);
          }
        } catch {
          toast("Upload failed", true);
        }
        resolve();
      };
      xhr.onerror = () => (toast("Upload failed — check your connection", true), resolve());
      xhr.send(file);
    });

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
