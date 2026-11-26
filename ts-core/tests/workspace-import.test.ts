import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHiveMemServer } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import type { AuthPrincipal, MemoryRecord } from "../src/types.js";

const admin: AuthPrincipal = { agentId: "operator", scopes: ["*"], rawClaims: { role: "admin" } };
const writer = (agentId: string): AuthPrincipal => ({ agentId, scopes: ["*"], rawClaims: {} });

function sourceExport() {
  const source = new InMemoryHiveMemStore();
  source.createWorkspace(admin, { workspace_id: "research", title: "Research" });
  source.upsertWorkspaceMember(admin, "research", "alice", { role: "member" });
  source.upsertWorkspaceMember(admin, "research", "bob", { role: "member" });
  source.createMemory(writer("alice"), { content: "Alice's shared finding", type: "semantic", scope: "shared", workspace_id: "research", tags: ["finding"] });
  source.createMemory(writer("bob"), { content: "Bob's private note", type: "episodic", scope: "private", workspace_id: "research", sensitivity: "sensitive" });
  source.createSession(writer("alice"), { session_id: "research-session", scope: "shared", workspace_id: "research", title: "Kickoff" });
  return source.exportWorkspace(admin, "research") as { workspace_id: string; memories: MemoryRecord[]; sessions: unknown[]; format_version: number };
}

function targetStore() {
  const target = new InMemoryHiveMemStore();
  target.createWorkspace(admin, { workspace_id: "restored", title: "Restored research" });
  return target;
}

test("an export imports into another installation with IDs, owners and timestamps kept", () => {
  const exported = sourceExport();
  const target = targetStore();
  const preview = target.importWorkspace(admin, "restored", exported) as { dry_run: boolean; memories: Record<string, number> };
  assert.equal(preview.dry_run, true, "import is a dry run unless asked");
  assert.equal(preview.memories.would_import, 2);
  assert.equal(target.exportWorkspace(admin, "restored").memories instanceof Array && (target.exportWorkspace(admin, "restored").memories as unknown[]).length, 0);

  const applied = target.importWorkspace(admin, "restored", { ...exported, dry_run: false }) as { memories: Record<string, number>; sessions: Record<string, number>; source_workspace_id: string };
  assert.deepEqual([applied.memories.imported, applied.sessions.imported, applied.source_workspace_id], [2, 1, "research"]);
  const restored = target.exportWorkspace(admin, "restored") as { memories: MemoryRecord[]; sessions: Array<{ session_id: string; owner_agent_id: string }> };
  const byId = new Map(restored.memories.map((memory) => [memory.id, memory]));
  for (const original of exported.memories) {
    const copy = byId.get(original.id);
    assert.ok(copy, original.id);
    assert.deepEqual({ ...copy, workspace_id: "research" }, original, "everything but the workspace is kept");
    assert.equal(copy.workspace_id, "restored");
  }
  assert.deepEqual(restored.sessions.map((session) => [session.session_id, session.owner_agent_id]), [["research-session", "alice"]]);
  // Members are the target's own configuration; once added, owners use their memories and privacy holds.
  for (const member of ["alice", "bob"]) target.upsertWorkspaceMember(admin, "restored", member, { role: "member" });
  const bobsNote = exported.memories.find((memory) => memory.agent_id === "bob")!;
  assert.equal(target.getMemory(writer("bob"), bobsNote.id).content, "Bob's private note");
  assert.throws(() => target.getMemory(writer("alice"), bobsNote.id));

  // Importing the same export again changes nothing.
  const again = target.importWorkspace(admin, "restored", { ...exported, dry_run: false }) as { memories: Record<string, number>; sessions: Record<string, number> };
  assert.deepEqual([again.memories.imported, again.memories.unchanged, again.memories.conflicts, again.sessions.unchanged], [0, 2, 0, 1]);
});

test("an ID already used differently is skipped, or refuses the whole import", () => {
  const exported = sourceExport();
  const target = targetStore();
  target.importWorkspace(admin, "restored", { ...exported, dry_run: false });
  const changed = { ...exported, memories: exported.memories.map((memory, index) => index === 0 ? { ...memory, content: "edited elsewhere" } : memory), dry_run: false };
  const skipped = target.importWorkspace(admin, "restored", changed) as { memories: { conflicts: number; conflict_ids: string[]; unchanged: number } };
  assert.deepEqual([skipped.memories.conflicts, skipped.memories.unchanged], [1, 1]);
  assert.deepEqual(skipped.memories.conflict_ids, [exported.memories[0]!.id]);
  assert.notEqual(target.getMemory(admin, exported.memories[0]!.id).content, "edited elsewhere", "a conflict never overwrites");

  // The same IDs cannot land in a second workspace either.
  target.createWorkspace(admin, { workspace_id: "second", title: "Second" });
  assert.throws(() => target.importWorkspace(admin, "second", { ...exported, dry_run: false, on_conflict: "fail" }), (error: unknown) => (error as { status?: number }).status === 409);
  assert.equal((target.exportWorkspace(admin, "second").memories as unknown[]).length, 0, "a refused import writes nothing");
});

test("import checks its caller, its target and every record", () => {
  const exported = sourceExport();
  const target = targetStore();
  assert.throws(() => target.importWorkspace(writer("alice"), "restored", exported), /Admin role required/);
  assert.throws(() => target.importWorkspace(admin, "missing", exported), /Create the target workspace/);
  assert.throws(() => target.importWorkspace(admin, "*", exported), /wildcard/);
  assert.throws(() => target.importWorkspace(admin, "restored", { ...exported, format_version: 2 }), /format_version/);
  const first = exported.memories[0]!;
  for (const broken of [
    { ...first, id: "" },
    { ...first, content: "" },
    { ...first, type: "dream" },
    { ...first, scope: "public" },
    { ...first, created_at: "yesterday" },
    { ...first, agent_id: undefined },
  ]) assert.throws(() => target.importWorkspace(admin, "restored", { ...exported, memories: [broken] }), (error: unknown) => (error as { status?: number }).status === 400 || (error as { status?: number }).status === 422);
  assert.throws(() => target.importWorkspace(admin, "restored", { ...exported, memories: [first, first] }), /repeats/);
  assert.equal((target.exportWorkspace(admin, "restored").memories as unknown[]).length, 0);
});

test("POST /v1/admin/workspaces/:id/import accepts an export larger than the ordinary body limit", async () => {
  const secret = randomBytes(32).toString("hex");
  const target = targetStore();
  const server = createHiveMemServer({ jwtSecret: secret, store: target, maxBodyBytes: 64 * 1024 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${signToken(secret, { exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`, "content-type": "application/json" });
  const exported = sourceExport();
  const big = { ...exported, dry_run: false, memories: [...exported.memories, ...Array.from({ length: 60 }, (_, index) => ({ ...exported.memories[0]!, id: `bulk-${index}`, content: "x".repeat(2048) }))] };
  try {
    const response = await fetch(base + "/v1/admin/workspaces/restored/import", { method: "POST", headers: bearer({ sub: "operator", role: "admin", scope: "*" }), body: JSON.stringify(big) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(((await response.json()) as { memories: { imported: number } }).memories.imported, 62);
    // Other routes keep the ordinary limit, and agents cannot import.
    assert.equal((await fetch(base + "/v1/memories", { method: "POST", headers: bearer({ sub: "alice", role: "agent", scope: "memories:write" }), body: JSON.stringify({ content: "y".repeat(70 * 1024) }) })).status, 413);
    assert.equal((await fetch(base + "/v1/admin/workspaces/restored/import", { method: "POST", headers: bearer({ sub: "alice", role: "agent", scope: "memories:write" }), body: JSON.stringify(exported) })).status, 403);
    const operations = await (await fetch(base + "/v1/capabilities/operations", { headers: bearer({ sub: "operator", role: "admin", scope: "*" }) })).json() as { operations: Array<{ id: string; state: string }> };
    assert.equal(operations.operations.find((operation) => operation.id === "workspace-import")?.state, "implemented");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
