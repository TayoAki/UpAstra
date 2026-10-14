import { verifyPassword } from "./auth";
import { fileStore } from "./files";
import { getBackend } from "./persist";
import { HttpError, evictTenant } from "./store";

// Deleting things for real: a workspace (its document, members, invites and
// uploaded files) and a user account. Owners who share a workspace hand it to
// the next admin (or member) instead of deleting their team's data.

export async function deleteWorkspaceEverywhere(workspaceId: string) {
  await evictTenant(workspaceId);
  try {
    await fileStore().deletePrefix(`${workspaceId}/`);
  } catch (err) {
    // Don't leave a half-deleted workspace because of storage; log for cleanup.
    console.error(`[accounts] failed to delete uploads for ${workspaceId}:`, err);
  }
  await getBackend().deleteWorkspace(workspaceId);
}

export interface AccountDeletion {
  deletedWorkspaces: string[];
  transferredWorkspaces: { name: string; newOwner: string }[];
  leftWorkspaces: string[];
}

export async function deleteAccount(userId: string, password: string): Promise<AccountDeletion> {
  const b = getBackend();
  const user = await b.getUser(userId);
  if (!user) throw new HttpError(404, "Account not found");
  if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Wrong password");

  const result: AccountDeletion = { deletedWorkspaces: [], transferredWorkspaces: [], leftWorkspaces: [] };
  for (const ws of await b.listWorkspacesForUser(userId)) {
    const others = (await b.listMembers(ws.id)).filter((m) => m.userId !== userId);
    if (ws.role !== "owner") {
      await b.removeMember(ws.id, userId);
      result.leftWorkspaces.push(ws.name);
    } else if (!others.length) {
      await deleteWorkspaceEverywhere(ws.id);
      result.deletedWorkspaces.push(ws.name);
    } else if (others.some((m) => m.role === "owner")) {
      await b.removeMember(ws.id, userId);
      result.leftWorkspaces.push(ws.name);
    } else {
      const heir = others.find((m) => m.role === "admin") ?? others[0];
      await b.addMember({ userId: heir.userId, workspaceId: ws.id, role: "owner" });
      await b.removeMember(ws.id, userId);
      result.transferredWorkspaces.push({ name: ws.name, newOwner: heir.email });
    }
  }
  await b.deleteUser(userId);
  return result;
}
