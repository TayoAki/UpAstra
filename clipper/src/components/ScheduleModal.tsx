import { useEffect, useState } from "react";
import { CalendarClock, Send } from "lucide-react";
import { PLATFORM_LABEL, type Clip } from "../../shared/types";
import { api } from "../api";
import { go, useApp } from "../store";
import { Modal } from "./ui";

const PRIVACY_LABEL: Record<string, string> = { PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input, an hour from now. */
const inAnHour = () => {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Post a rendered clip now or schedule it, to one or more connected accounts. */
export function ScheduleModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const { state, run, busy, toast } = useApp();
  const accounts = (state?.accounts ?? []).filter((a) => a.outstandId && !a.needsReconnect);
  const [picked, setPicked] = useState<string[]>(accounts.slice(0, 1).map((a) => a.id));
  const [when, setWhen] = useState<"now" | "later">("later");
  const [at, setAt] = useState(inAnHour());
  const [caption, setCaption] = useState(`${clip.caption}${clip.hashtags.length ? `\n\n${clip.hashtags.join(" ")}` : ""}`.trim());
  const [ttMode, setTtMode] = useState<"inbox" | "direct">("inbox");
  const [ttPrivacy, setTtPrivacy] = useState("");
  const [ttOptions, setTtOptions] = useState<string[]>();
  const [ytTitle, setYtTitle] = useState(clip.title.slice(0, 100));
  const chosen = accounts.filter((a) => picked.includes(a.id));
  const tiktok = chosen.find((a) => a.platform === "tiktok");
  const youtube = chosen.some((a) => a.platform === "youtube");

  // Direct TikTok posts must use a visibility the creator's account allows.
  useEffect(() => {
    if (ttMode !== "direct" || !tiktok || ttOptions) return;
    api.tiktokPrivacy(tiktok.id).then(
      (r) => (setTtOptions(r.options), setTtPrivacy(r.options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : r.options[0] ?? "")),
      (e: Error) => (toast(e.message, true), setTtMode("inbox")),
    );
  }, [ttMode, tiktok, ttOptions, toast]);

  if (!state?.status.publishing)
    return (
      <Modal title="Post or schedule" onClose={onClose}>
        <p className="small muted">Publishing isn't connected on this server yet (it needs an Outstand API key).</p>
      </Modal>
    );
  if (!accounts.length)
    return (
      <Modal title="Post or schedule" onClose={onClose}>
        <p className="small muted">Connect a TikTok, Instagram or YouTube account first.</p>
        <button className="btn primary" onClick={() => (onClose(), go("/settings/accounts"))}>
          Connect accounts
        </button>
      </Modal>
    );

  const submit = async () => {
    const iso = when === "later" ? new Date(at).toISOString() : undefined;
    const r = await run(
      () => api.scheduleClip(clip.id, { accountIds: picked, at: iso, caption, tiktok: tiktok ? { mode: ttMode, privacy: ttMode === "direct" ? ttPrivacy : undefined } : undefined, youtube: youtube ? { title: ytTitle } : undefined }),
      when === "later" ? `Scheduled for ${new Date(at).toLocaleString()}` : "Posting now",
    );
    if (r) onClose();
  };

  return (
    <Modal title="Post or schedule" onClose={onClose}>
      <div className="field">
        Post to
        <div className="col" style={{ gap: 4 }}>
          {accounts.map((a) => (
            <label key={a.id} className="row">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
              {a.avatarUrl && <img src={a.avatarUrl} alt="" className="avatar-sm" />}
              <span>
                @{a.handle} <span className="faint small">{PLATFORM_LABEL[a.platform]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="row wrap mt">
        <label className="row">
          <input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Now
        </label>
        <label className="row">
          <input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> Later
        </label>
        {when === "later" && <input className="input" style={{ width: "auto" }} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        {when === "later" && <span className="small faint">your time · up to 30 days ahead</span>}
      </div>

      <label className="field mt">
        Caption
        <textarea className="input" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </label>

      {tiktok && (
        <div className="field mt">
          TikTok
          <select className="select" value={ttMode} onChange={(e) => setTtMode(e.target.value as "inbox" | "direct")}>
            <option value="inbox">Send to my TikTok inbox as a draft (I publish it in the app)</option>
            <option value="direct">Post directly to the profile</option>
          </select>
          {ttMode === "direct" && (
            <select className="select" value={ttPrivacy} onChange={(e) => setTtPrivacy(e.target.value)} disabled={!ttOptions}>
              {!ttOptions && <option>Loading…</option>}
              {ttOptions?.map((o) => (
                <option key={o} value={o}>
                  Who can see it: {PRIVACY_LABEL[o] ?? o}
                </option>
              ))}
            </select>
          )}
          <span className="small faint">
            {ttMode === "inbox" ? "Drafts don't count as posted until you publish them in TikTok — views are tracked after that." : "Marked as AI-generated content, as TikTok requires for AI voiceovers."}
          </span>
        </div>
      )}

      {youtube && (
        <label className="field mt">
          YouTube Shorts title
          <input className="input" maxLength={100} value={ytTitle} onChange={(e) => setYtTitle(e.target.value)} />
        </label>
      )}

      <button className="btn primary mt" disabled={busy || !picked.length || (when === "later" && !at) || (ttMode === "direct" && !!tiktok && !ttPrivacy)} onClick={submit}>
        {when === "now" ? <Send size={14} /> : <CalendarClock size={14} />} {when === "now" ? "Post now" : "Schedule"}
      </button>
    </Modal>
  );
}
