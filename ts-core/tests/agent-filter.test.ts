import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { InMemoryHiveMemStore } from "../src/store.js";
import { MemorySearchRequestSchema } from "../src/browser-memory-contracts.js";
import { createHiveMemServer, signToken, type BrowseResponse, type MemoryRecord, type SearchResponse, type StatsResponse } from "../src/index.js";

const jwtSecret = "test_secret_32_bytes_or_more_xxxx";

function token(agentId: string, role?: string): string {
  return signToken(jwtSecret, {
    sub: agentId,
    ...(role ? { role } : {}),
    scope: "memories:read memories:write sessions:read sessions:write",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe("agent_id filters", () => {
  let server: Server;
  let baseUrl: string;
  const ids: Record<string, string> = {};

  async function call<T>(method: string, path: string, body?: unknown, agent = "agent-a", role?: string): Promise<{ status: number; body: T }> {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token(agent, role)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: (await response.json()) as T };
  }

  async function remember(agent: string, content: string, scope: "private" | "shared"): Promise<string> {
    const created = await call<MemoryRecord>("POST", "/v1/memories", { content, type: "semantic", scope, workspace_id: "default" }, agent);
    assert.equal(created.status, 201);
    return created.body.id;
  }

  before(async () => {
    server = createHiveMemServer({ jwtSecret, store: new InMemoryHiveMemStore({ webhookTransport: async () => 202 }) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ids.aPrivate = await remember("agent-a", "Alpha private deploy note", "private");
    ids.aShared = await remember("agent-a", "Alpha shared deploy note", "shared");
    ids.bShared = await remember("agent-b", "Bravo shared deploy note", "shared");
    ids.bPrivate = await remember("agent-b", "Bravo private deploy note", "private");
    const session = await call("POST", "/v1/sessions", { session_id: "bravo-session", title: "Bravo", scope: "shared", workspace_id: "default" }, "agent-b");
    assert.equal(session.status, 201);
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("leaves browse unchanged without agent_id", async () => {
    const browse = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default");
    assert.equal(browse.status, 200);
    assert.deepEqual(new Set(browse.body.memories.map((memory) => memory.id)), new Set([ids.aPrivate, ids.aShared, ids.bShared]));
    assert.equal(browse.body.total, 3);
    const empty = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default&agent_id=");
    assert.equal(empty.body.total, 3);
  });

  it("filters browse by agent_id within the caller's readable memories", async () => {
    const own = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default&agent_id=agent-a");
    assert.deepEqual(new Set(own.body.memories.map((memory) => memory.id)), new Set([ids.aPrivate, ids.aShared]));
    assert.equal(own.body.total, 2);
    const other = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default&agent_id=agent-b");
    assert.deepEqual(other.body.memories.map((memory) => memory.id), [ids.bShared]);
    assert.equal(other.body.total, 1);
    assert.equal(other.body.next_cursor, null);
    const scoped = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default&agent_id=agent-a&scope=shared");
    assert.deepEqual(scoped.body.memories.map((memory) => memory.id), [ids.aShared]);
    const unknown = await call<BrowseResponse>("GET", "/v1/memories/browse?workspace_id=default&agent_id=nobody");
    assert.equal(unknown.body.total, 0);
  });

  it("rejects malformed agent_id on browse with the validation error format", async () => {
    for (const value of ["A", "Agent-A", "a", "agent.a", "x".repeat(33)]) {
      const response = await call<{ detail: string }>("GET", `/v1/memories/browse?workspace_id=default&agent_id=${encodeURIComponent(value)}`);
      assert.equal(response.status, 422, value);
      assert.match(response.body.detail, /agent_id must match/);
    }
  });

  it("filters search by the agent_id body field", async () => {
    const all = await call<SearchResponse>("POST", "/v1/memories/search", { query: "deploy", workspace_id: "default", limit: 10 });
    assert.equal(all.status, 200);
    assert.equal(all.body.results.length, 3);
    const filtered = await call<SearchResponse>("POST", "/v1/memories/search", { query: "deploy", workspace_id: "default", limit: 10, agent_id: "agent-b" });
    assert.deepEqual(filtered.body.results.map((result) => result.memory.id), [ids.bShared]);
    assert.equal(filtered.body.total_searched, 1);
    const invalid = await call<{ detail: string }>("POST", "/v1/memories/search", { query: "deploy", workspace_id: "default", agent_id: "Bad Agent" });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.detail, /agent_id must match/);
    const wrongType = await call<{ detail: string }>("POST", "/v1/memories/search", { query: "deploy", workspace_id: "default", agent_id: 7 });
    assert.equal(wrongType.status, 422);
  });

  it("accepts agent_id in the browser search contract", () => {
    assert.equal(MemorySearchRequestSchema.parse({ query: "x", agent_id: "agent-b" }).agent_id, "agent-b");
    assert.throws(() => MemorySearchRequestSchema.parse({ query: "x", agent_id: "Agent B" }));
  });

  it("scopes stats counts by agent_id and leaves unscoped stats unchanged", async () => {
    const all = await call<StatsResponse>("GET", "/v1/stats");
    assert.equal(all.status, 200);
    assert.equal(all.body.memories, 4);
    assert.equal(all.body.sessions, 1);
    const bravo = await call<StatsResponse>("GET", "/v1/stats?agent_id=agent-b", undefined, "agent-b");
    assert.equal(bravo.status, 200);
    assert.deepEqual(Object.keys(bravo.body).sort(), Object.keys(all.body).sort());
    assert.equal(bravo.body.memories, 2);
    assert.equal(bravo.body.sessions, 1);
    const alpha = await call<StatsResponse>("GET", "/v1/stats?agent_id=agent-a");
    assert.equal(alpha.body.memories, 2);
    assert.equal(alpha.body.sessions, 0);
    assert.equal(alpha.body.webhooks, 0);
    // Another agent's counts include its private records: only that agent or an administrator.
    const foreign = await call<{ detail: string }>("GET", "/v1/stats?agent_id=agent-b");
    assert.equal(foreign.status, 403);
    const administered = await call<StatsResponse>("GET", "/v1/stats?agent_id=agent-b", undefined, "operator", "admin");
    assert.equal(administered.status, 200);
    assert.equal(administered.body.memories, 2);
    const invalid = await call<{ detail: string }>("GET", "/v1/stats?agent_id=-", undefined, "operator", "admin");
    assert.equal(invalid.status, 422);
  });
});
