import { describe, expect, it } from "vitest";
import type { Clip, WorkspaceDoc } from "../shared/types";
import { emptyDoc, getBackend, getDoc, loadTenant, runInWorkspace, tenantLoadHooks, useMemoryBackend } from "../server/db";
import { MAX_RESUMES } from "../server/render";
import "../server/caption-jobs";

const clip = (id: string, resumes: number): Clip =>
  ({
    id,
    campaignId: "camp_x",
    title: id,
    status: "rendering",
    render: { status: "rendering", step: "Cutting shots", voice: "none", requestedAt: new Date().toISOString(), cost: 0, resumes },
  }) as unknown as Clip;

async function workspace(id: string, doc: Partial<WorkspaceDoc>) {
  await getBackend().createUser({ id: `u_${id}`, email: `${id}@test.dev`, name: id, passwordHash: "x", createdAt: new Date().toISOString() });
  await getBackend().createWorkspace({ id, ownerId: `u_${id}`, name: id, createdAt: new Date().toISOString() }, { ...emptyDoc(), ...doc });
}

describe("after a restart", () => {
  it("loads a workspace once even when requests arrive together", async () => {
    useMemoryBackend();
    await workspace("ws_once", {});
    let loads = 0;
    tenantLoadHooks.push((ws) => ws === "ws_once" && loads++);
    await Promise.all([loadTenant("ws_once"), loadTenant("ws_once"), loadTenant("ws_once")]);
    expect(loads).toBe(1);
  });

  it("re-queues interrupted renders and caption jobs, but not forever", async () => {
    useMemoryBackend();
    await workspace("ws_resume", {
      clips: [clip("clip_again", 0), clip("clip_givenup", MAX_RESUMES)],
      captionJobs: [{ id: "cap_x", name: "x", status: "rendering", resumes: 2 } as never],
    });
    expect(await getBackend().workspacesWithPendingWork()).toEqual(["ws_resume"]);
    await loadTenant("ws_resume");
    runInWorkspace("ws_resume", undefined, () => {
      const [again, givenUp] = getDoc().clips;
      // Picked up again (it may already be running or have failed for lack of footage, but it was retried).
      expect(again.render?.resumes).toBe(1);
      expect(givenUp.render).toMatchObject({ status: "failed", error: expect.stringMatching(/server restart/) });
      expect(givenUp.status).toBe("approved");
      // A caption job that already resumed twice goes back to "ready" so it can be rendered again by hand.
      expect(getDoc().captionJobs![0]).toMatchObject({ status: "ready", error: expect.stringMatching(/server restart/) });
    });
  });

  it("finds interrupted format breakdowns at boot, not just renders and caption jobs", async () => {
    useMemoryBackend();
    await workspace("ws_fmt", { formats: [{ id: "fmt_x", name: "x", status: "analyzing", sourceKey: "k", source: { kind: "upload" }, cost: 0, createdAt: "", updatedAt: "" } as never] });
    await workspace("ws_idle", { formats: [{ id: "fmt_y", name: "y", status: "ready", sourceKey: "k", source: { kind: "upload" }, cost: 0, createdAt: "", updatedAt: "" } as never] });
    expect(await getBackend().workspacesWithPendingWork()).toEqual(["ws_fmt"]);
  });
});
