import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateIP, safeFetch } from "../server/sources";

let server: http.Server;
let base = "";
const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
beforeAll(() => {
  // Exercise the direct (production) path: no outbound proxy.
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  server = http
    .createServer((req, res) => {
      if (req.url === "/hop") return res.writeHead(302, { Location: "/video" }).end();
      res.writeHead(200, { "Content-Type": "video/mp4", "X-Seen-UA": String(req.headers["user-agent"]) }).end("0123456789");
    })
    .listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server?.close();
  Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v)));
  delete process.env.ALLOW_PRIVATE_FETCH;
});

describe("safeFetch", () => {
  it("knows private and special-purpose ranges", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.5", "192.0.0.8", "::1", "fd12::1", "64:ff9b::a00:1", "2002:a00:1::", "::ffff:10.0.0.1"])
      expect(privateIP(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005::200e"]) expect(privateIP(ip), ip).toBe(false);
  });

  it("refuses names that resolve to private addresses, at check and at connect time", async () => {
    await expect(safeFetch(`${base}/video`)).rejects.toThrow(/can't be fetched/);
  });

  it("fetches directly through the guarded connection, following redirects", async () => {
    process.env.ALLOW_PRIVATE_FETCH = "1"; // the test server is on localhost
    const r = await safeFetch(`${base}/hop`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("x-seen-ua")).toMatch(/UGCMediaClips/);
    expect(await r.text()).toBe("0123456789");
  });
});
