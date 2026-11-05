import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHiveMemHandler } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import type { AuthPrincipal } from "../src/types.js";
const owner: AuthPrincipal = {
  agentId: "synthetic-owner",
  scopes: ["*"],
  rawClaims: { role: "agent" },
};
const admin: AuthPrincipal = {
  agentId: "synthetic-admin",
  scopes: ["*"],
  rawClaims: { role: "admin" },
};
const other: AuthPrincipal = { ...owner, agentId: "synthetic-other" };

test("session IDs stay reserved and removed workspace access prevents owned session mutations", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, {
    workspace_id: "team",
    members: [{ agent_id: other.agentId, role: "member" }],
  });
  const session = store.createSession(other, {
    session_id: "retained-session",
    workspace_id: "team",
    title: "Retained",
  });
  const before = structuredClone(store.snapshot());
  assert.throws(
    () =>
      store.createSession(owner, {
        session_id: session.session_id,
        workspace_id: "team",
      }),
    /reserved/,
  );
  assert.deepEqual(store.snapshot(), before);
  store.removeWorkspaceMember(owner, "team", other.agentId);
  assert.throws(
    () =>
      store.updateSession(other, session.session_id, { title: "Forbidden" }),
    /permission/,
  );
  assert.throws(
    () => store.deleteSession(other, session.session_id),
    /permission/,
  );
  assert.deepEqual(
    store
      .listSessions(admin, new URLSearchParams({ workspace_id: "*" }))
      .map((s) => s.session_id),
    [],
    "private sessions do not become visible to another principal",
  );
  const constrained = {
    ...admin,
    rawClaims: { role: "admin", workspace_ids: ["default"] },
  };
  assert.throws(
    () => store.getSession(constrained, session.session_id),
    /workspace/,
  );
});

test("webhook endpoints and delivery history honor current workspace access", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, {
    workspace_id: "team",
    members: [{ agent_id: other.agentId, role: "member" }],
  });
  const endpoint = store.createWebhook(other, {
    workspace_id: "team",
    url: "https://hooks.example.com/memory",
    event_types: ["memory.created"],
    secret: "obviously-fake-signing-secret",
  });
  const testEvent = store.testWebhook(other, { workspace_id: "team" });
  assert.equal(testEvent.queued_deliveries, 1);
  store.removeWorkspaceMember(owner, "team", other.agentId);
  assert.deepEqual(
    store.listWebhooks(other, new URLSearchParams({ workspace_id: "*" })),
    [],
  );
  assert.equal(
    store.listWebhookDeliveries(other, new URLSearchParams()).total,
    0,
  );
  assert.throws(() => store.getWebhook(other, endpoint.id), /permission/);
  assert.throws(
    () => store.getWebhookDelivery(other, testEvent.delivery_ids[0]!),
    /permission/,
  );
  assert.throws(
    () => store.updateWebhook(other, endpoint.id, { workspace_id: "default" }),
    /permission/,
  );
  assert.throws(() => store.deleteWebhook(other, endpoint.id), /permission/);
  assert.throws(
    () => store.testWebhook(other, { workspace_id: "team" }),
    /permission/,
  );
});

test("direct console parity APIs separate read and mutation scopes without dashboard cookies", async () => {
  const store = new InMemoryHiveMemStore();
  const secret = "f".repeat(64);
  const server = createServer(
    createHiveMemHandler({ store, jwtSecret: secret }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const token = (scopes: string[]) =>
    signToken(secret, {
      sub: owner.agentId,
      agent_id: owner.agentId,
      scopes,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
  const readHeaders = {
    Authorization: `Bearer ${token(["memories:read"])}`,
    "Content-Type": "application/json",
  };
  try {
    const before = structuredClone(store.snapshot());
    for (const path of [
      "/v1/conflicts",
      "/v1/consolidation/status",
      "/v1/consolidation/logs",
    ])
      assert.equal(
        (await fetch(origin + path, { headers: readHeaders })).status,
        200,
        path,
      );
    assert.deepEqual(
      store.snapshot(),
      before,
      "summary reads do not write audit state",
    );
    assert.equal(
      (
        await fetch(origin + "/v1/conflicts/unknown/resolve", {
          headers: readHeaders,
          method: "POST",
          body: JSON.stringify({ action: "acknowledge" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/consolidation/status", {
          headers: { Authorization: `Bearer ${token(["sessions:read"])}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(origin + "/v1/consolidation/status")).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("queue retry and cancellation enforce current workspace restrictions and job ownership", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, { workspace_id: "team" });
  store.createSession(owner, { workspace_id: "team" });
  const job = store.queueStatus(
    admin,
    new URLSearchParams({ workspace_id: "team" }),
  ).jobs[0]!;
  const constrained = {
    ...admin,
    rawClaims: { role: "admin", workspace_ids: ["default"] },
  };
  const foreign = { ...other, scopes: ["admin:queue"] };
  for (const principal of [constrained, foreign])
    assert.throws(() => store.cancelQueueJob(principal, job.id));
  assert.equal(store.getQueueJob(admin, job.id).status, "pending");
  store.cancelQueueJob(admin, job.id);
  for (const principal of [constrained, foreign])
    assert.throws(() => store.retryQueueJob(principal, job.id));
  assert.equal(store.getQueueJob(admin, job.id).status, "cancelled");
});

test("conflict review requires current workspace write permission even for the memory owner", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, {
    workspace_id: "team",
    members: [{ agent_id: other.agentId, role: "member" }],
  });
  const memory = store.createMemory(other, {
    workspace_id: "team",
    content: "Synthetic conflict source",
    type: "semantic",
    scope: "private",
  });
  store.upsertWorkspaceMember(owner, "team", other.agentId, {
    role: "viewer",
    scopes: [],
  });
  assert.equal(store.getMemory(other, memory.id).id, memory.id);
  assert.throws(
    () =>
      store.resolveDashboardConflict(other, memory.id, { action: "dismiss" }),
    /permission/,
  );
});

test("moving a session does not retain access to memories in a subsequently revoked workspace", () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(owner, {
    workspace_id: "team",
    members: [{ agent_id: other.agentId, role: "member" }],
  });
  const session = store.createSession(other, { workspace_id: "team" });
  store.createMemory(other, {
    workspace_id: "team",
    session_id: session.session_id,
    content: "Synthetic retained workspace source",
    type: "semantic",
    scope: "private",
  });
  store.updateSession(other, session.session_id, { workspace_id: "default" });
  assert.equal(store.getSessionMemories(other, session.session_id).length, 1);
  store.removeWorkspaceMember(owner, "team", other.agentId);
  assert.equal(
    store.getSession(other, session.session_id).workspace_id,
    "default",
  );
  assert.deepEqual(store.getSessionMemories(other, session.session_id), []);
});
