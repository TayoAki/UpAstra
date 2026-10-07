import type {
  AuditEntry,
  AutonomyPolicy,
  ClientMemory,
  Economics,
  FirmStats,
  Generation,
  Job,
  JobStage,
  Lesson,
  ModelSpec,
  ProviderStatus,
  ServiceTemplate,
  Channel,
  FirmProfile,
  Lead,
  PublicUser,
  RadarState,
  Role,
  SavedSearch,
  WorkspaceSummary,
} from "../shared/types";

export interface JobSummary {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  channel: Channel;
  stage: JobStage;
  templateName: string;
  price: number;
  running: boolean;
  openCheckpoints: number;
  economics: Economics;
  thumb?: string;
  updatedAt: string;
  createdAt: string;
}

export interface JobDetail {
  job: Job;
  economics: Economics;
  generations: Generation[];
  audit: AuditEntry[];
  client?: ClientMemory;
  template: ServiceTemplate;
}

export interface Bootstrap {
  catalog: ModelSpec[];
  templates: ServiceTemplate[];
  policy: AutonomyPolicy;
  providers: ProviderStatus & { ai: string; apify: "live" | "simulated" };
  workspaceId: string;
  role: Role;
}

export interface Me {
  user: PublicUser;
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  role: Role;
  hasAgentToken: boolean;
  members: { userId: string; email: string; name: string; role: Role }[];
  profile: FirmProfile;
}

// The active workspace travels with every request; the server checks membership.
const WS_KEY = "so.workspace";
export function getWorkspaceId(): string {
  try {
    return localStorage.getItem(WS_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setWorkspaceId(id: string) {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    /* private mode: falls back to the first workspace */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const ws = getWorkspaceId();
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  if (ws) headers["X-Workspace-Id"] = ws;
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("so:signed-out"));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  bootstrap: () => req<Bootstrap>("/bootstrap"),
  stats: () => req<FirmStats>("/stats"),
  jobs: () => req<JobSummary[]>("/jobs"),
  job: (id: string) => req<JobDetail>(`/jobs/${id}`),
  createJob: (body: unknown) => req<JobDetail>("/jobs", { method: "POST", json: body }),
  accept: (id: string) => req<JobDetail>(`/jobs/${id}/accept`, { method: "POST", json: {} }),
  start: (id: string) => req<JobDetail>(`/jobs/${id}/start`, { method: "POST", json: {} }),
  route: (id: string, stepId: string, modelId: string | null) => req<JobDetail>(`/jobs/${id}/route`, { method: "POST", json: { stepId, modelId } }),
  price: (id: string, price: number) => req<JobDetail>(`/jobs/${id}/price`, { method: "POST", json: { price } }),
  resolve: (id: string, cpId: string, decision: "approved" | "rejected", note?: string) =>
    req<JobDetail>(`/jobs/${id}/checkpoints/${cpId}`, { method: "POST", json: { decision, note } }),
  message: (id: string, body: string) => req<JobDetail>(`/jobs/${id}/messages`, { method: "POST", json: { body } }),
  policy: () => req<AutonomyPolicy>("/policy"),
  savePolicy: (p: Partial<AutonomyPolicy>) => req<AutonomyPolicy>("/policy", { method: "PUT", json: p }),
  resetPolicy: () => req<AutonomyPolicy>("/policy/reset", { method: "POST", json: {} }),
  clients: () => req<ClientMemory[]>("/clients"),
  createClient: (c: Partial<ClientMemory>) => req<ClientMemory>("/clients", { method: "POST", json: c }),
  saveClient: (c: ClientMemory) => req<ClientMemory>(`/clients/${c.id}`, { method: "PUT", json: c }),
  lessons: () => req<Lesson[]>("/lessons"),
  audit: () => req<AuditEntry[]>("/audit"),

  // accounts
  me: () => req<Me>("/auth/me"),
  signup: (b: { email: string; password: string; name?: string; workspaceName?: string; demo?: boolean; invite?: string }) => req<Me>("/auth/signup", { method: "POST", json: b }),
  login: (email: string, password: string) => req<Me>("/auth/login", { method: "POST", json: { email, password } }),
  logout: () => req<{ ok: true }>("/auth/logout", { method: "POST", json: {} }),
  join: (code: string) => req<Me>("/auth/join", { method: "POST", json: { code } }),
  createWorkspace: (name: string, demo: boolean) => req<Me & { workspace: { id: string } }>("/workspaces", { method: "POST", json: { name, demo } }),

  // workspace settings
  workspace: () => req<WorkspaceInfo>("/workspace"),
  renameWorkspace: (name: string) => req<{ ok: true }>("/workspace", { method: "PUT", json: { name } }),
  saveProfile: (p: FirmProfile) => req<FirmProfile>("/profile", { method: "PUT", json: p }),
  invite: (role: "member" | "admin") => req<{ code: string; role: Role; expiresInDays: number }>("/workspace/invites", { method: "POST", json: { role } }),
  removeMember: (userId: string) => req<{ ok: true }>(`/workspace/members/${userId}`, { method: "DELETE" }),
  createAgentToken: () => req<{ token: string }>("/workspace/agent-token", { method: "POST", json: {} }),
  revokeAgentToken: () => req<{ ok: true }>("/workspace/agent-token", { method: "DELETE" }),

  // job radar
  radar: () => req<RadarState>("/radar"),
  createSearch: (s: Partial<SavedSearch>) => req<SavedSearch>("/radar/searches", { method: "POST", json: s }),
  updateSearch: (id: string, s: Partial<SavedSearch>) => req<SavedSearch>(`/radar/searches/${id}`, { method: "PUT", json: s }),
  deleteSearch: (id: string) => req<{ ok: true }>(`/radar/searches/${id}`, { method: "DELETE" }),
  runSearch: (id: string) => req<{ added: number; scanned: number; good: number; radar: RadarState }>(`/radar/searches/${id}/run`, { method: "POST", json: {} }),
  draftProposal: (id: string) => req<Lead>(`/radar/leads/${id}/proposal`, { method: "POST", json: {} }),
  rescoreLead: (id: string) => req<Lead>(`/radar/leads/${id}/score`, { method: "POST", json: {} }),
  updateLead: (id: string, b: { status?: Lead["status"]; proposalText?: string; proposalStatus?: "draft" | "approved" | "applied" }) => req<Lead>(`/radar/leads/${id}`, { method: "PUT", json: b }),
  convertLead: (id: string) => req<JobDetail>(`/radar/leads/${id}/convert`, { method: "POST", json: {} }),
};
