import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { acceptsIdempotencyKey, createHiveMemServer, isReadPost } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import type { AuthPrincipal } from "../src/types.js";

const admin: AuthPrincipal = { agentId: "operator", scopes: ["*"], rawClaims: { role: "admin" } };
const agent: AuthPrincipal = { agentId: "plain-agent", scopes: ["*"], rawClaims: { role: "agent" } };

test("read routes are matched exactly, so a write whose ID names a read word keeps its Idempotency-Key", () => {
  for (const path of ["/v1/memories/search", "/v1/memories/search/text", "/v1/memories/search/hybrid", "/v1/memories/conflicts", "/v1/context", "/v1/chat", "/v1/archive/search", "/v1/embed", "/v1/sessions/s-1/chat", "/v1/sessions/s-1/context"]) {
    assert.equal(isReadPost(path), true, path);
    assert.equal(acceptsIdempotencyKey(path), false, path);
  }
  for (const path of ["/v1/peers/research-bot/conclusions", "/v1/episodes/chat-episode/messages", "/v1/admin/workspaces/chat-team/import", "/v1/sessions/context-session", "/v1/memories", "/v1/webhooks"]) {
    assert.equal(isReadPost(path), false, path);
    assert.equal(acceptsIdempotencyKey(path), true, path);
  }
  for (const path of ["/v1/auth/tokens", "/v1/actor-credentials/" + "a".repeat(64), "/v1/agents/register"]) assert.equal(acceptsIdempotencyKey(path), false, path);
});

test("a retried keyed write to such a route replays instead of writing twice, and is audited", async () => {
  const secret = randomBytes(32).toString("hex");
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: "chat-team", title: "Chat team" });
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${signToken(secret, { sub: "operator", role: "admin", scope: "*", exp: Math.floor(Date.now() / 1000) + 300 })}`, "content-type": "application/json", "idempotency-key": "retry-key-0001" };
  const exported = { format_version: 1, workspace_id: "source", dry_run: false, memories: [{ id: "chat-memory", content: "keyed import", agent_id: "writer", type: "semantic", scope: "shared", created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }] };
  try {
    const first = await fetch(base + "/v1/admin/workspaces/chat-team/import", { method: "POST", headers, body: JSON.stringify(exported) });
    assert.equal(first.status, 200);
    const again = await fetch(base + "/v1/admin/workspaces/chat-team/import", { method: "POST", headers, body: JSON.stringify(exported) });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(await again.json(), await first.json());
    const audited = store.snapshot().operations!.filter((entry) => entry.kind === "api.mutation" && entry.path === "/v1/admin/workspaces/chat-team/import");
    assert.equal(audited.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("administering the implicit default workspace needs the admin role", () => {
  const store = new InMemoryHiveMemStore();
  // Reading and writing it stay open to every agent.
  store.createMemory(agent, { content: "default stays writable", type: "semantic", scope: "shared" });
  store.createWebhook(agent, { url: "https://receiver.example.com/own", workspace_id: "default" });
  // Observing every member, pruning or enrolling there are administration.
  assert.throws(() => store.createWebhook(agent, { url: "https://receiver.example.com/all", workspace_id: "default", all_members: true }), /admin role/);
  assert.throws(() => store.pruneWorkspace(agent, "default", true), /admin role/);
  assert.throws(() => store.actorCredentials({ ...agent, scopes: ["admin:agents"] }, "a".repeat(64), { action: "enroll", agent_id: "minted", display_name: "Minted", scopes: ["memories:read"], workspace_id: "default", expires_at: new Date(Date.now() + 3600_000).toISOString() }, "s".repeat(64)), /admin role/);
  assert.doesNotThrow(() => store.pruneWorkspace(admin, "default", true));
  // Member events are checked against a workspace record, which the implicit default lacks.
  assert.throws(() => store.createWebhook(admin, { url: "https://receiver.example.com/all", workspace_id: "default", all_members: true }), /workspace record/);
  store.createWorkspace(admin, { workspace_id: "default", title: "Default" });
  assert.equal(store.createWebhook(admin, { url: "https://receiver.example.com/all", workspace_id: "default", all_members: true }).all_members, true);
});
