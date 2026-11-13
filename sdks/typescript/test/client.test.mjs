import assert from "node:assert/strict";
import test from "node:test";
import { ContextPackage, HiveMem } from "../dist/index.js";

test("HiveMem createMemory sends auth and workspace", async () => {
  const seen = {};
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    workspaceId: "ws",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.auth = init.headers.get("authorization");
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "m1", ...seen.body }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.createMemory({ content: "hello", type: "semantic", scope: "private" });
  assert.equal(seen.auth, "Bearer tok");
  assert.equal(seen.body.workspace_id, "ws");
  assert.equal(result.id, "m1");
});

test("ContextPackage produces OpenAI fallback messages", () => {
  const pkg = new ContextPackage({ summary: { content: "summary" }, memories: [{ id: "m", agent_id: "a", content: "memory", type: "semantic", scope: "private" }] });
  const messages = pkg.toOpenAI({ assistantPeerId: "bot" });
  assert.equal(messages[0].content, "Assistant peer id: bot");
  assert.ok(messages.some((message) => message.content.includes("memory")));
});

test("HiveMem syncKnowledgeSource uses the bounded knowledge route and workspace", async () => {
  const seen = {};
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    workspaceId: "team",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ...seen.body, created: 1, superseded: 0, retired: 0, unchanged: 0, created_ids: ["m1"], superseded_ids: [], retired_ids: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.syncKnowledgeSource({ mode: "preview", project_id: "p", source_id: "repo:p", source_uri: "repo://p", revision: "r1", observed_at: "2026-09-21T00:00:00Z", chunks: [] });
  assert.equal(seen.url, "https://hive.test/v1/knowledge/sources/sync");
  assert.equal(seen.body.workspace_id, "team");
  assert.equal(result.created, 1);
});

test("HiveMem middleware hooks and auth refresh are applied", async () => {
  const calls = [];
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "old",
    requestIdProvider: () => "req-1",
    authRefresh: () => "new",
    onRequest: (method, url) => calls.push(["request", method, url]),
    onResponse: response => calls.push(["response", response.status]),
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.get("authorization"), "Bearer new");
      assert.equal(init.headers.get("x-request-id"), "req-1");
      return new Response(JSON.stringify({ peer_id: "user", cards: [], generated_at: "now", observer_peer_id: "agent", workspace_id: "default" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const card = await client.getPeerCard("user");
  assert.equal(card.peer_id, "user");
  assert.deepEqual(calls[0].slice(0, 2), ["request", "GET"]);
  assert.deepEqual(calls[1], ["response", 200]);
});

test("HiveMem history, conclusion and operation reads use the documented routes", async () => {
  const urls = [];
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    workspaceId: "team",
    fetchImpl: async (url) => {
      urls.push(new URL(String(url)));
      return new Response(JSON.stringify({ id: "x", results: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await client.getMemory("m/1", { includeHistory: true });
  await client.getConclusion("c1");
  await client.listConclusionsPage("peer", { limit: 2, cursor: "abc" });
  await client.getQueueOperation("op-1", "dream");
  await client.exportAudit({ after: "cursor-1", limit: 5 });
  await client.exportAudit();

  assert.equal(urls[0].pathname, "/v1/memories/m%2F1");
  assert.equal(urls[0].searchParams.get("include_history"), "true");
  assert.equal(urls[1].pathname, "/v1/conclusions/c1");
  assert.equal(urls[1].searchParams.has("include_history"), false);
  assert.equal(urls[2].pathname, "/v1/peers/peer/conclusions");
  assert.equal(urls[2].searchParams.get("paginate"), "true");
  assert.equal(urls[2].searchParams.get("cursor"), "abc");
  assert.equal(urls[2].searchParams.get("workspace_id"), "team");
  assert.equal(urls[3].pathname, "/v1/queue/operations/op-1");
  assert.equal(urls[3].searchParams.get("task_type"), "dream");
  assert.equal(urls[3].searchParams.get("workspace_id"), "team");
  assert.equal(urls[4].pathname, "/v1/audit/export");
  assert.equal(urls[4].searchParams.get("after"), "cursor-1");
  assert.equal(urls[4].searchParams.get("limit"), "5");
  assert.equal(urls[4].searchParams.has("workspace_id"), false);
  assert.equal(urls[5].search, "");
});

test("HiveMem context helpers preserve real server context, citations and budget", async () => {
  const formatted = "- [memory:memory-1] The synthetic launch code is amber-cedar.";
  const client = new HiveMem({
    baseUrl: "https://memory.example.com",
    workspaceId: "verification",
    fetchImpl: async () => new Response(JSON.stringify({
      memories: [{
        memory: { id: "memory-1", agent_id: "agent-1", content: "The synthetic launch code is amber-cedar.", type: "semantic", scope: "private" },
        collection: "private_semantic", score: 1, tokens_used: 12,
        citation: { memory_id: "memory-1" },
      }],
      summary: { content: "1 memories selected for context.", memory_count: 1 },
      formatted_context: { format: "markdown", content: formatted },
      metadata: { token_budget: 100, tokens_used: 20 },
    }), { headers: { "content-type": "application/json" } }),
  });
  const context = await client.context({ search_query: "synthetic launch code" });
  assert.deepEqual(context.toOpenAI(), [{ role: "system", content: formatted }]);
  assert.deepEqual(context.toOpenAI({ assistantPeerId: "bot" }), [
    { role: "system", content: "Assistant peer id: bot" },
    { role: "system", content: formatted },
  ]);
  assert.deepEqual(context.toAnthropic(), [{ role: "user", content: formatted }]);
  const empty = new ContextPackage({
    memories: context.raw().memories,
    formatted_context: { format: "markdown", content: "" },
  });
  assert.deepEqual(empty.toOpenAI(), []);
  assert.deepEqual(empty.toAnthropic(), []);
});

test("ContextPackage supports nested retrieval entries without preformatted context", () => {
  const context = new ContextPackage({ memories: [{
    memory: { id: "memory-1", agent_id: "agent-1", content: "The synthetic code is amber-cedar.", type: "semantic", scope: "private" },
    collection: "private_semantic", score: 1, tokens_used: 10,
  }] });
  assert.deepEqual(context.toOpenAI(), [{ role: "system", content: "Memory: The synthetic code is amber-cedar." }]);
  assert.deepEqual(context.toAnthropic(), [{ role: "user", content: "Memory: The synthetic code is amber-cedar." }]);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("HiveMem createWorkspace posts the workspace ID and options", async () => {
  const seen = {};
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    workspaceId: "ignored-default",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.method = init.method;
      seen.body = JSON.parse(init.body);
      return json({ workspace_id: seen.body.workspace_id, owner_agent_id: "agent", title: seen.body.title, members: [] }, 201);
    },
  });
  const workspace = await client.createWorkspace("team", { title: "Team", members: [{ agent_id: "helper", role: "member", scopes: ["memories:read"] }] });
  assert.equal(seen.url, "https://hive.test/v1/workspaces");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { title: "Team", members: [{ agent_id: "helper", role: "member", scopes: ["memories:read"] }], workspace_id: "team" });
  assert.equal(workspace.workspace_id, "team");
});

test("HiveMem tokenProvider supplies the token and is refreshed and retried once on 401", async () => {
  const providerCalls = [];
  const auths = [];
  let issued = 0;
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    tokenProvider: ({ forceRefresh }) => {
      providerCalls.push(forceRefresh);
      if (forceRefresh) issued += 1;
      return `svc-${issued}`;
    },
    fetchImpl: async (_url, init) => {
      const auth = init.headers.get("authorization");
      auths.push(auth);
      return auth === "Bearer svc-0" ? json({ detail: "expired" }, 401) : json({ status: "ok" });
    },
  });
  assert.deepEqual(await client.health(), { status: "ok" });
  assert.deepEqual(providerCalls, [false, true]);
  assert.deepEqual(auths, ["Bearer svc-0", "Bearer svc-1"]);

  // A second 401 after the refresh is final: no loop.
  const always401 = new HiveMem({ baseUrl: "https://hive.test", tokenProvider: () => "x", fetchImpl: async () => json({ detail: "no" }, 401) });
  await assert.rejects(always401.health(), (error) => error.statusCode === 401);

  // Without a provider a 401 is not retried, and a static token still works.
  let calls = 0;
  const fixed = new HiveMem({ baseUrl: "https://hive.test", token: "static", fetchImpl: async (_url, init) => { calls += 1; assert.equal(init.headers.get("authorization"), "Bearer static"); return json({ detail: "no" }, 401); } });
  await assert.rejects(fixed.health(), (error) => error.statusCode === 401);
  assert.equal(calls, 1);
});

test("HiveMem refuses redirects and sends extra headers without overriding its own", async () => {
  const seen = [];
  let n = 0;
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    headers: () => ({ "x-request-id": `req-${++n}`, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", authorization: "Bearer spoofed", accept: "text/html" }),
    fetchImpl: async (_url, init) => {
      seen.push({ redirect: init.redirect, rid: init.headers.get("x-request-id"), tp: init.headers.get("traceparent"), auth: init.headers.get("authorization"), accept: init.headers.get("accept") });
      return json({ status: "ok" });
    },
  });
  await client.health();
  await client.health();
  assert.deepEqual(seen[0], { redirect: "error", rid: "req-1", tp: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", auth: "Bearer tok", accept: "application/json" });
  assert.equal(seen[1].rid, "req-2");

  const staticHeaders = new HiveMem({ baseUrl: "https://hive.test", headers: { "x-hive-caller": "studio" }, fetchImpl: async (_url, init) => { assert.equal(init.headers.get("x-hive-caller"), "studio"); assert.equal(init.headers.get("authorization"), null); return json({}); } });
  await staticHeaders.health();
});

test("HiveMem keeps the status and text of a non-JSON error body", async () => {
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    maxRetries: 0,
    fetchImpl: async () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html" } }),
  });
  await assert.rejects(client.health(), (error) => error.statusCode === 502 && error.message === "<html>Bad Gateway</html>" && error.details === undefined);
});

test("HiveMem reads the detail of a JSON error body and names the status of an empty one", async () => {
  let body = JSON.stringify({ detail: "Workspace is archived" });
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    maxRetries: 0,
    fetchImpl: async () => new Response(body, { status: 409, statusText: "" }),
  });
  await assert.rejects(client.health(), (error) => error.statusCode === 409 && error.message === "Workspace is archived" && error.details.detail === "Workspace is archived");
  body = "";
  await assert.rejects(client.health(), (error) => error.statusCode === 409 && error.message === "HiveMem answered HTTP 409");
});

test("HiveMem retries a 5xx response and releases the discarded response body", async () => {
  const responses = [];
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    fetchImpl: async () => {
      const response = responses.length === 0
        ? new Response(JSON.stringify({ detail: "Internal server error" }), { status: 503 })
        : new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      responses.push(response);
      return response;
    },
  });
  assert.deepEqual(await client.health(), { status: "ok" });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].body.locked || responses[0].bodyUsed, true, "the retried response body is cancelled, not left unread");
});
