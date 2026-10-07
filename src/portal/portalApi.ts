import type { ClientRequestView, FileRef, PortalPublic } from "../../shared/types";

// Client-portal API. Clients carry a portal token (stored per portal in this
// browser), never the studio's session cookie.

export interface PortalClient {
  id: string;
  email: string;
  name: string;
  company: string;
}

const key = (slug: string) => `so.portal.${slug}`;
export const getToken = (slug: string) => {
  try {
    return localStorage.getItem(key(slug)) ?? "";
  } catch {
    return "";
  }
};
export const setToken = (slug: string, token: string) => {
  try {
    if (token) localStorage.setItem(key(slug), token);
    else localStorage.removeItem(key(slug));
  } catch {
    /* storage blocked (e.g. some embedded contexts): token lives for this tab only */
  }
};

let memoryToken = "";

export function portalApi(slug: string) {
  const token = () => getToken(slug) || memoryToken;
  async function req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    if (token()) headers["X-Portal-Token"] = token();
    const res = await fetch(`/papi/${encodeURIComponent(slug)}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) setToken(slug, "");
      throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
    }
    return data as T;
  }
  const remember = (r: { token: string; user: PortalClient }) => {
    setToken(slug, r.token);
    memoryToken = r.token;
    return r.user;
  };
  return {
    signedIn: () => !!token(),
    signOut: () => {
      setToken(slug, "");
      memoryToken = "";
    },
    portal: () => req<PortalPublic>("/"),
    signup: (b: { email: string; password: string; name: string; company: string; website?: string }) => req<{ token: string; user: PortalClient }>("/auth/signup", { method: "POST", json: b }).then(remember),
    login: (email: string, password: string) => req<{ token: string; user: PortalClient }>("/auth/login", { method: "POST", json: { email, password } }).then(remember),
    me: () => req<{ user: PortalClient; requests: ClientRequestView[] }>("/me"),
    upload: (file: File) =>
      req<FileRef>("/uploads", { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } }),
    submit: (b: { packageId: string; addOnIds: string[]; answers: Record<string, string>; files: Record<string, FileRef[]>; title?: string }) =>
      req<ClientRequestView>("/requests", { method: "POST", json: b }),
    request: (id: string) => req<ClientRequestView>(`/requests/${id}`),
    message: (id: string, body: string) => req<ClientRequestView>(`/requests/${id}/messages`, { method: "POST", json: { body } }),
    approve: (id: string) => req<ClientRequestView>(`/requests/${id}/approve`, { method: "POST", json: {} }),
    fileUrl: (key: string) => `/papi/${encodeURIComponent(slug)}/files/${key}`,
    download: async (f: FileRef) => {
      const res = await fetch(`/papi/${encodeURIComponent(slug)}/files/${f.key}`, { headers: { "X-Portal-Token": token() } });
      if (!res.ok) throw new Error("Download failed");
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement("a"), { href: url, download: f.name }).click();
      URL.revokeObjectURL(url);
    },
  };
}

export type PortalApi = ReturnType<typeof portalApi>;
