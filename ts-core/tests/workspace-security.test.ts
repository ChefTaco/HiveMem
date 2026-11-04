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
