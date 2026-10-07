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
  providers: ProviderStatus;
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
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
};
