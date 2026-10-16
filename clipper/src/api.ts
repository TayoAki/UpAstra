import type { BrandKit, CaptionOverrides } from "../shared/caption-styles";
import type { AdminUsage, CaptionJob, UsageReport } from "../shared/types";
import type { Activity, Campaign, CampaignBrief, CampaignStats, Clip, Insights, LearningReport, Me, Post, ServiceStatus, SocialAccount } from "../shared/types";

export type CampaignWithStats = Campaign & { stats: CampaignStats };
export interface State {
  campaigns: CampaignWithStats[];
  clips: Clip[];
  posts: Post[];
  accounts: SocialAccount[];
  insights: Record<string, Insights>;
  brand: BrandKit;
  captionJobs: (Omit<CaptionJob, "words"> & { wordCount: number })[];
  agentRuns: { id: string; title: string; status: string; updatedAt: string; pending: boolean }[];
  activity: Activity[];
  status: ServiceStatus;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function req<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  me: () => req<Me>("/auth/me"),
  signup: (b: { email: string; password: string; name: string; workspaceName?: string }) => req<Me>("/auth/signup", "POST", b),
  login: (email: string, password: string) => req<Me>("/auth/login", "POST", { email, password }),
  forgot: (email: string) => req<{ ok: true }>("/auth/forgot", "POST", { email }),
  reset: (token: string, password: string) => req<Me>("/auth/reset", "POST", { token, password }),
  verifyEmail: (token: string) => req<{ ok: true; email: string }>("/auth/verify", "POST", { token }),
  resendVerification: () => req<{ ok: true }>("/auth/resend-verification", "POST", {}),
  changePassword: (current: string, password: string) => req<Me>("/auth/password", "POST", { current, password }),
  logoutEverywhere: () => req<{ ok: true }>("/auth/logout-everywhere", "POST", {}),
  logout: () => req<{ ok: true }>("/auth/logout", "POST", {}),
  deleteAccount: (password: string) => req<{ ok: true }>("/auth/account", "DELETE", { password }),
  renameWorkspace: (name: string) => req<Me>("/workspace", "PUT", { name }),
  updateBrand: (b: Partial<Record<keyof BrandKit, unknown>>) => req<State>("/brand", "PUT", b),
  deleteBrandFont: (id: string) => req<State>(`/brand/fonts/${id}`, "DELETE"),
  setCampaignCaptions: (id: string, captions: CaptionOverrides | null) => req<State>(`/campaigns/${id}`, "PUT", { captions }),
  captionJob: (id: string) => req<CaptionJob>(`/captions/${id}`),
  captionFromUrl: (b: { url: string; language?: string; glossary?: string }) => req<{ job: CaptionJob; state: State }>("/captions/from-url", "POST", b),
  updateCaptionJob: (id: string, b: { name?: string; captions?: CaptionOverrides; edits?: { index: number; count: number; text: string }[] }) => req<CaptionJob>(`/captions/${id}`, "PUT", b),
  retranscribe: (id: string, language: string) => req<State>(`/captions/${id}/transcribe`, "POST", { language }),
  renderCaptions: (id: string, captions?: CaptionOverrides) => req<State>(`/captions/${id}/render`, "POST", { captions }),
  deleteCaptionJob: (id: string) => req<State>(`/captions/${id}`, "DELETE"),
  captionVideoUrl: (id: string, which: "source" | "output", v?: string, download = false) => `/api/captions/${id}/video?which=${which}${v ? `&v=${encodeURIComponent(v.slice(-20))}` : ""}${download ? "&download=1" : ""}`,
  connectSocial: (network: string) => req<{ url: string }>("/social/connect", "POST", { network }),
  syncSocial: () => req<State>("/social/sync", "POST", {}),
  pendingPages: (session: string) => req<{ pages: { id: string; name: string; network?: string; picture?: string }[] }>(`/social/pending/${encodeURIComponent(session)}`),
  finalizePages: (session: string, pageIds: string[]) => req<State>(`/social/pending/${encodeURIComponent(session)}`, "POST", { pageIds }),
  disconnectSocial: (id: string) => req<State>(`/social/accounts/${id}`, "DELETE"),
  tiktokPrivacy: (accountId: string) => req<{ options: string[] }>(`/social/accounts/${accountId}/tiktok-privacy`),
  scheduleClip: (id: string, b: { accountIds: string[]; at?: string; caption: string; tiktok?: { mode: "inbox" | "direct"; privacy?: string }; youtube?: { title?: string; privacy?: string } }) =>
    req<{ posts: string[]; state: State }>(`/clips/${id}/schedule`, "POST", b),
  cancelPost: (id: string) => req<State>(`/posts/${id}/cancel`, "POST", {}),
  usage: () => req<UsageReport>("/usage"),
  adminUsage: (month?: string) => req<AdminUsage>(`/admin/usage${month ? `?month=${month}` : ""}`),
  syncMetrics: () => req<{ updated: number; state: State }>("/social/sync-metrics", "POST", {}),
  deleteAgentRun: (id: string) => req<State>(`/agent/runs/${id}`, "DELETE"),
  createAgentKey: () => req<{ key: string; me: Me }>("/workspace/agent-key", "POST", {}),
  revokeAgentKey: () => req<Me>("/workspace/agent-key", "DELETE"),

  state: () => req<State>("/state"),
  createCampaign: (b: { text?: string; url?: string }) => req<{ campaign: Campaign; state: State }>("/campaigns", "POST", b),
  updateCampaign: (id: string, b: Partial<{ name: string; status: Campaign["status"]; notes: string; brief: CampaignBrief }>) => req<State>(`/campaigns/${id}`, "PUT", b),
  deleteCampaign: (id: string) => req<State>(`/campaigns/${id}`, "DELETE"),
  reextract: (id: string) => req<State>(`/campaigns/${id}/reextract`, "POST", {}),
  refreshFootage: (id: string) => req<State>(`/campaigns/${id}/footage/refresh`, "POST", {}),
  planClips: (id: string, count: number) => req<State>(`/campaigns/${id}/clips`, "POST", { count }),
  updateClip: (id: string, b: Partial<Clip> & { override?: boolean }) => req<State>(`/clips/${id}`, "PUT", b),
  deleteClip: (id: string) => req<State>(`/clips/${id}`, "DELETE"),
  renderClip: (id: string, voice: string, override?: boolean) => req<State>(`/clips/${id}/render`, "POST", { voice, override }),
  videoUrl: (id: string, key: string, download = false) => `/api/clips/${id}/video?v=${encodeURIComponent(key.slice(-24))}${download ? "&download=1" : ""}`,
  editorUrl: (id: string) => `/editor/?co_clip=${encodeURIComponent(id)}#/new?width=1080&height=1920&fps=30`,
  analyzeFootage: (campaignId: string, footageId: string) => req<State>(`/campaigns/${campaignId}/footage/${footageId}/analyze`, "POST", {}),
  addPost: (b: Partial<Post> & { campaignId: string }) => req<State>("/posts", "POST", b),
  updatePost: (id: string, b: Partial<Omit<Post, "metrics" | "paidAmount">> & { metrics?: Partial<Post["metrics"]>; paidAmount?: number | null }) => req<State>(`/posts/${id}`, "PUT", b),
  deletePost: (id: string) => req<State>(`/posts/${id}`, "DELETE"),
  addAccount: (b: Partial<SocialAccount>) => req<State>("/accounts", "POST", b),
  writeInsights: (scope: string) => req<{ report: LearningReport; insights: Insights }>("/learning/insights", "POST", { scope }),
  deleteAccount2: (id: string) => req<State>(`/accounts/${id}`, "DELETE"),
};
