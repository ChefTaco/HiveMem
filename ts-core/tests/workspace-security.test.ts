import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import { createHiveMemHandler } from "../src/server.js";
import type { AuthPrincipal } from "../src/types.js";

const owner: AuthPrincipal = {
  agentId: "synthetic-owner",
  scopes: [
    "workspaces:read",
    "workspaces:write",
    "memories:read",
    "memories:write",
  ],
  rawClaims: { role: "agent", private_claim: "must-not-be-returned" },
};
const other: AuthPrincipal = { ...owner, agentId: "synthetic-other" };
const admin: AuthPrincipal = {
  agentId: "synthetic-admin",
  scopes: ["admin:all"],
  rawClaims: { role: "admin" },
};

test("archived workspace IDs cannot transfer ownership and owner restoration retains state", () => {
  const store = new InMemoryHiveMemStore();
  const created = store.createWorkspace(owner, {
    workspace_id: "team",
    title: "Retained team",
    members: [{ agent_id: other.agentId, role: "admin" }],
    policy: {
      retention_days: 60,
      agent_overrides: { "synthetic-other": { webhooks_enabled: false } },
    },
  });
  const memory = store.createMemory(owner, {
    content: "retained shared knowledge",
    type: "semantic",
    scope: "shared",
    workspace_id: "team",
  });
  assert.throws(
    () =>
      store.upsertWorkspaceMember(other, "team", other.agentId, {
        role: "owner",
      }),
    /owner permission/,
    "workspace administrators cannot promote themselves to owner",
  );
  store.upsertWorkspaceMember(owner, "team", "synthetic-coowner", {
    role: "owner",
  });
  assert.throws(
    () =>
      store.upsertWorkspaceMember(other, "team", "synthetic-coowner", {
        role: "viewer",
      }),
    /owner permission/,
  );
  assert.throws(
    () => store.removeWorkspaceMember(other, "team", "synthetic-coowner"),
    /owner permission/,
  );
  store.removeWorkspaceMember(owner, "team", "synthetic-coowner");
  store.deleteWorkspace(owner, "team");
  assert.throws(
    () => store.createWorkspace(other, { workspace_id: "team" }),
    /archived and reserved/,
  );
  assert.throws(
    () => store.createWorkspace(owner, { workspace_id: "team" }),
    /archived and reserved/,
  );
  assert.throws(
    () => store.restoreWorkspace(other, "team"),
    /owner permission/,
  );
  assert.throws(
    () =>
      store.restoreWorkspace(
        {
          ...admin,
          rawClaims: { role: "admin", workspace_ids: ["different"] },
        },
        "team",
      ),
    /owner permission/,
  );
  assert.deepEqual(
    store.listWorkspaces(
      { ...admin, rawClaims: { role: "admin", workspace_ids: ["different"] } },
      new URLSearchParams("include_deleted=true"),
    ),
    [],
  );
  const restored = store.restoreWorkspace(owner, "team");
  assert.equal(restored.owner_agent_id, created.owner_agent_id);
  assert.equal(restored.created_at, created.created_at);
  assert.deepEqual(restored.members, created.members);
  assert.deepEqual(restored.policy, created.policy);
  assert.equal(restored.deleted_at, null);
  assert.equal(store.getMemory(owner, memory.id).content, memory.content);
  assert.deepEqual(
    store.restoreWorkspace(owner, "team"),
    restored,
    "repeated restoration is idempotent",
  );
  store.deleteWorkspace(owner, "team");
  const restarted = new InMemoryHiveMemStore({ snapshot: store.snapshot() });
  assert.throws(
    () => restarted.createWorkspace(other, { workspace_id: "team" }),
    /archived and reserved/,
  );
  assert.deepEqual(
    restarted.restoreWorkspace(owner, "team").members,
    created.members,
  );
});

test("HTTP enforces restore scopes and ownership; browser profile excludes raw claims", async () => {
  const store = new InMemoryHiveMemStore();
  store.registerAgent(
    admin,
    { agent_id: owner.agentId, display_name: "Synthetic owner" },
    "obviously-fake-native-token",
  );
  store.registerAgent(
    admin,
    { agent_id: other.agentId, display_name: "Synthetic member" },
    "obviously-fake-native-token-other",
  );
  store.createWorkspace(owner, { workspace_id: "team" });
  store.deleteWorkspace(owner, "team");
  const secret = "f".repeat(64);
  const server = createServer(
    createHiveMemHandler({ store, jwtSecret: secret }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = (principal: AuthPrincipal) => ({
    Authorization:
      "Bearer " +
      signToken(secret, {
        ...principal.rawClaims,
        sub: principal.agentId,
        scope: principal.scopes.join(" "),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
  });
  try {
    assert.equal(
      (
        await fetch(origin + "/v1/workspaces/team/restore", {
          method: "POST",
          headers: headers({ ...owner, scopes: ["workspaces:read"] }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/workspaces/team/restore", {
          method: "POST",
          headers: headers(other),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/workspaces/team/restore", {
          method: "POST",
          headers: headers(owner),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(origin + "/v1/profile")).status, 401);
    const response = await fetch(origin + "/v1/profile", {
      headers: headers(owner),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      agent_id: owner.agentId,
      display_name: "Synthetic owner",
      role: "agent",
      scopes: owner.scopes,
      workspace_ids: null,
    });
    assert.equal(
      (await fetch(origin + "/v1/auth/me", { headers: headers(owner) })).status,
      200,
      "native compatibility route remains available",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

test("updating a memory needs write access to its workspace and to the workspace it moves to", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, {
    workspace_id: "team",
    members: [{ agent_id: other.agentId, role: "member" }],
  });
  store.createWorkspace(owner, { workspace_id: "closed" });
  const memory = store.createMemory(other, {
    content: "a note from the synthetic member",
    type: "semantic",
    scope: "shared",
    workspace_id: "team",
  });
  assert.throws(
    () => store.updateMemory(other, memory.id, { workspace_id: "closed" }),
    /Workspace write permission required/,
    "a memory cannot be moved into a workspace its owner may not write to",
  );
  assert.throws(
    () =>
      store.updateMemory(
        { ...other, rawClaims: { ...other.rawClaims, workspace_ids: ["team"] } },
        memory.id,
        { workspace_id: "default" },
      ),
    /Token does not permit this workspace/,
    "a workspace-bound token cannot move a memory out of its workspaces",
  );
  assert.equal(store.getMemory(other, memory.id).workspace_id, "team");
  assert.equal(
    store.updateMemory(other, memory.id, { content: "edited by a member" }).content,
    "edited by a member",
  );
  store.upsertWorkspaceMember(owner, "team", other.agentId, { role: "viewer" });
  assert.throws(
    () => store.updateMemory(other, memory.id, { content: "edited by a viewer" }),
    /Workspace write permission required/,
    "a viewer cannot change workspace content",
  );
  store.upsertWorkspaceMember(owner, "team", other.agentId, { role: "member" });
  store.createWorkspace(other, { workspace_id: "second" });
  assert.equal(
    store.updateMemory(other, memory.id, { workspace_id: "second" }).workspace_id,
    "second",
    "a move between two writable workspaces still works",
  );
});

test("only an administrator can claim the open default workspace, and * never names one", () => {
  const store = new InMemoryHiveMemStore();
  store.createMemory(other, {
    content: "shared in the open default workspace",
    type: "semantic",
    scope: "shared",
  });
  assert.throws(
    () => store.createWorkspace(owner, { workspace_id: "default" }),
    /Only an administrator can create the default workspace/,
  );
  assert.equal(
    store.browse(other, new URLSearchParams()).total,
    1,
    "the default workspace stays open to other agents",
  );
  assert.throws(() => store.createWorkspace(admin, { workspace_id: "*" }), /wildcard/);
  assert.equal(
    store.createWorkspace(admin, { workspace_id: "default" }).owner_agent_id,
    admin.agentId,
  );
});

test("dashboard memory options list only agents and tags from readable workspaces", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, { workspace_id: "closed" });
  store.createMemory(owner, {
    content: "shared inside a closed workspace",
    type: "semantic",
    scope: "shared",
    workspace_id: "closed",
    tags: ["closed-project-tag"],
  });
  store.createMemory(other, {
    content: "shared in the default workspace",
    type: "semantic",
    scope: "shared",
    tags: ["open-tag"],
  });
  const outside = store.dashboardMemoryOptions(other);
  assert.deepEqual(outside.tags, ["open-tag"]);
  assert.deepEqual(
    outside.agents.map((agent) => agent.agent_id),
    [other.agentId],
  );
  assert.deepEqual(store.dashboardMemoryOptions(owner).tags, ["closed-project-tag", "open-tag"]);
});

test("malformed paths are client errors and a failed chat checkpoint still answers", async () => {
  class FlakyStore extends InMemoryHiveMemStore {
    private failFlushAt = 0;
    private flushes = 0;
    /** Fail the nth flush from now. */
    failFlush(nth: number): void {
      this.flushes = 0;
      this.failFlushAt = nth;
    }
    override async flushPersistence(): Promise<void> {
      this.flushes += 1;
      if (this.flushes === this.failFlushAt)
        throw Object.assign(new Error("Memory persistence unavailable; write outcome is indeterminate"), { status: 503 });
    }
  }
  const store = new FlakyStore();
  const secret = "f".repeat(64);
  const server = createServer(createHiveMemHandler({ store, jwtSecret: secret })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization:
      "Bearer " +
      signToken(secret, {
        sub: owner.agentId,
        role: "agent",
        scope: "memories:read memories:write context:read workspaces:read",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
  };
  try {
    for (const path of ["/v1/memories/%E0%A4%A", "/v1/workspaces/%zz", "/v1/peers/%/conclusions"]) {
      const response = await fetch(origin + path, { headers });
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { detail: "Malformed percent-encoding in request path" });
    }
    assert.equal(
      (await fetch(origin + "/dashboard/api/memory-options", { headers: { Cookie: "hivemem_dash=%E0%A4%A" } })).status,
      401,
    );
    // The request's own flushes are the pre-route one, the post-auth one and the response's.
    store.failFlush(3);
    const chat = await fetch(origin + "/v1/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "anything" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(chat.status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});

test("another agent's profile covers only memories the caller can read", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, { workspace_id: "closed" });
  store.createMemory(owner, { content: "private note", type: "semantic", scope: "private", tags: ["private-tag"] });
  store.createMemory(owner, { content: "closed note", type: "semantic", scope: "shared", workspace_id: "closed", tags: ["closed-tag"] });
  store.createMemory(owner, { content: "open note", type: "semantic", scope: "shared", tags: ["open-tag"] });
  const seenByOther = store.agentProfile(other, owner.agentId);
  assert.deepEqual(seenByOther.top_tags, [{ tag: "open-tag", count: 1 }]);
  assert.equal(seenByOther.total_memories, 1);
  assert.equal(seenByOther.private_memories, 0);
  for (const viewer of [owner, admin]) {
    const profile = store.agentProfile(viewer, owner.agentId);
    assert.equal(profile.total_memories, 3);
    assert.equal(profile.private_memories, 1);
    assert.deepEqual(profile.top_tags.map((entry) => entry.tag).sort(), ["closed-tag", "open-tag", "private-tag"]);
  }
});

test("a rejected memory batch stores none of its items", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, { workspace_id: "closed" });
  const valid = { content: "first item", type: "semantic", scope: "private" };
  assert.throws(() => store.createMemories(other, { memories: [valid, { content: "no type or scope" }] }), /type and scope are required/);
  assert.throws(() => store.createMemories(other, { memories: [valid, { ...valid, workspace_id: "closed" }] }), /Workspace write permission required/);
  assert.equal(store.browse(other, new URLSearchParams()).total, 0);
  assert.equal(store.createMemories(other, { memories: [valid, valid] }).length, 2);
});
