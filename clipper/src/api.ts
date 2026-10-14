import type { Activity, Campaign, CampaignBrief, CampaignStats, Clip, Me, Post, ServiceStatus, SocialAccount } from "../shared/types";

export type CampaignWithStats = Campaign & { stats: CampaignStats };
export interface State {
  campaigns: CampaignWithStats[];
  clips: Clip[];
  posts: Post[];
  accounts: SocialAccount[];
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
  logout: () => req<{ ok: true }>("/auth/logout", "POST", {}),
  deleteAccount: (password: string) => req<{ ok: true }>("/auth/account", "DELETE", { password }),
  renameWorkspace: (name: string) => req<Me>("/workspace", "PUT", { name }),

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
  analyzeFootage: (campaignId: string, footageId: string) => req<State>(`/campaigns/${campaignId}/footage/${footageId}/analyze`, "POST", {}),
  addPost: (b: Partial<Post> & { campaignId: string }) => req<State>("/posts", "POST", b),
  updatePost: (id: string, b: Partial<Omit<Post, "metrics" | "paidAmount">> & { metrics?: Partial<Post["metrics"]>; paidAmount?: number | null }) => req<State>(`/posts/${id}`, "PUT", b),
  deletePost: (id: string) => req<State>(`/posts/${id}`, "DELETE"),
  addAccount: (b: Partial<SocialAccount>) => req<State>("/accounts", "POST", b),
  deleteAccount2: (id: string) => req<State>(`/accounts/${id}`, "DELETE"),
};
