import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { validateHiveEvent, type HiveEvent } from "@hivemagnus/hive-common/events";
import { createHiveMemServer } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import type { AuthPrincipal, JsonObject, QueueJobRecord, WebhookDeliveryRecord } from "../src/types.js";

const admin: AuthPrincipal = { agentId: "operator", scopes: ["*"], rawClaims: { role: "admin" } };
const agent = (agentId: string): AuthPrincipal => ({ agentId, scopes: ["memories:read", "memories:write", "webhooks:read", "webhooks:write", "workspaces:read", "workspaces:write", "sessions:write"], rawClaims: {} });
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function seededStore(): InMemoryHiveMemStore {
  const snapshot = new InMemoryHiveMemStore().snapshot();
  snapshot.operations = [
    { id: "conflict:a:b", kind: "conflict", workspace_id: "default", memory_ids: ["a", "b"], resolved: false, created_at: recent(30) },
    { id: "conflict:c:d", kind: "conflict", workspace_id: "team", memory_ids: ["c", "d"], resolved: false, created_at: recent(20) },
    { id: "conflict:old", kind: "conflict", workspace_id: "default", memory_ids: ["e", "f"], resolved: false, created_at: recent(60 * 24 * 20) },
  ];
  const delivery = (id: string, status: WebhookDeliveryRecord["status"], minutes: number): WebhookDeliveryRecord => ({
    id, endpoint_id: "endpoint-1", owner_agent_id: "writer", workspace_id: "default", event_id: "event-" + id, event_type: "memory.created",
    nonce: "nonce", status, attempts: 2, url: "https://receiver.example.com/hook?token=do-not-show", response_status: status === "failed" ? 503 : 202,
    error: status === "failed" ? "http_status" : null, created_at: recent(minutes + 1), updated_at: recent(minutes), delivered_at: null,
  });
  snapshot.webhookDeliveries = [delivery("delivery-failed", "failed", 15), delivery("delivery-ok", "delivered", 14)];
  const job = (id: string, status: QueueJobRecord["status"], minutes: number): QueueJobRecord => ({
    id, task_type: "message_extract", status, work_unit_key: "unit-" + id, payload: { content: "secret memory content" }, owner_agent_id: "writer",
    workspace_id: "default", session_id: null, peer_id: null, observer_peer_id: null, observed_peer_id: null, idempotency_key: "key-" + id,
    priority: 0, retry_count: 4, created_at: recent(minutes + 5), not_before: null, started_at: null, finished_at: recent(minutes), locked_at: null,
    error: "failure quoting secret memory content", result: null,
  });
  snapshot.queueJobs = [job("job-dead", "dead_letter", 10), job("job-done", "completed", 9)];
  return new InMemoryHiveMemStore({ snapshot });
}

test("the feed serves conflicts, failed deliveries and dead letters as valid HiveEvents, without content or URLs", () => {
  const store = seededStore();
  const page = store.hiveEvents(admin, new URLSearchParams());
  assert.deepEqual(page.data.map((event) => event.type), ["memory.conflict.detected", "memory.conflict.detected", "webhook.delivery.failed", "queue.job.dead_letter"]);
  for (const event of page.data) {
    assert.equal(validateHiveEvent(event, { strict: true }).ok, true, event.id);
    assert.equal(event.product, "hivemem");
    assert.deepEqual(event.link, { product: "hivemem", path: "/?page=memories" });
  }
  const text = JSON.stringify(page);
  for (const secret of ["secret memory content", "do-not-show", "receiver.example.com"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(page.data.some((event) => event.sourceRef === "conflict:old"), false, "events past the 14-day retention are not served");
  assert.equal(page.nextCursor, null, "a caught-up page has no next cursor");

  // Paging: oldest first, then nothing after the last page.
  const first = store.hiveEvents(admin, new URLSearchParams("limit=2"));
  assert.equal(first.data.length, 2);
  assert.ok(first.nextCursor);
  const rest = store.hiveEvents(admin, new URLSearchParams({ limit: "200", after: first.nextCursor }));
  assert.deepEqual([...first.data, ...rest.data].map((event) => event.id), page.data.map((event) => event.id));
  assert.equal(rest.nextCursor, null);
  assert.throws(() => store.hiveEvents(admin, new URLSearchParams("after=not-a-cursor")), (error: unknown) => (error as { status?: number }).status === 400);

  // A workspace-restricted administrator sees only its workspaces; agents see nothing.
  const restricted = store.hiveEvents({ ...admin, rawClaims: { role: "admin", workspace_ids: ["team"] } }, new URLSearchParams());
  assert.deepEqual(restricted.data.map((event) => event.sourceRef), ["conflict:c:d"]);
  assert.throws(() => store.hiveEvents(agent("writer"), new URLSearchParams()), /Admin role required/);
});

test("a stale worker is an event while it stays stale", () => {
  const store = seededStore();
  store.configureWorker(true);
  assert.equal(store.hiveEvents(admin, new URLSearchParams()).data.some((event) => event.type === "worker.stale"), false);
  (store as unknown as { workerHeartbeat: string }).workerHeartbeat = recent(5);
  const stale = store.hiveEvents(admin, new URLSearchParams()).data.find((event) => event.type === "worker.stale");
  assert.ok(stale);
  assert.equal(stale.severity, "critical");
  assert.equal(validateHiveEvent(stale, { strict: true }).ok, true);
});

test("GET /v1/hive/events is an authenticated, administrator-only, no-store feed", async () => {
  const secret = randomBytes(32).toString("hex");
  const server = createHiveMemServer({ jwtSecret: secret, store: seededStore() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bearer = (claims: JsonObject) => ({ authorization: `Bearer ${signToken(secret, { exp: Math.floor(Date.now() / 1000) + 300, ...claims })}` });
  try {
    assert.equal((await fetch(base + "/v1/hive/events")).status, 401);
    assert.equal((await fetch(base + "/v1/hive/events", { headers: bearer({ sub: "writer", role: "agent", scope: "memories:read" }) })).status, 403);
    const response = await fetch(base + "/v1/hive/events?limit=10", { headers: bearer({ sub: "operator", role: "admin", scope: "*" }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { data: HiveEvent[]; nextCursor: string | null };
    assert.equal(body.data.length, 4);
    assert.equal((await fetch(base + "/v1/hive/events?limit=0", { headers: bearer({ sub: "operator", role: "admin", scope: "*" }) })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed delivery and a dead letter from real queue runs reach the feed", async () => {
  const store = new InMemoryHiveMemStore({ webhookTransport: async () => { throw new Error("receiver down"); } });
  store.createWebhook(admin, { url: "https://receiver.example.com/hook", workspace_id: "default", event_types: ["memory.created"] });
  store.createMemory(admin, { content: "content that must stay out of events", type: "semantic", scope: "shared" });
  const job = store.snapshot().queueJobs.find((item) => item.task_type === "webhook_delivery")!;
  for (let attempt = 0; attempt < 4; attempt++) await store.runQueueJob(admin, job.id);
  const types = store.hiveEvents(admin, new URLSearchParams()).data.map((event) => event.type);
  assert.deepEqual(types.filter((type) => type !== "memory.conflict.detected").sort(), ["queue.job.dead_letter", "webhook.delivery.failed"]);
  assert.equal(JSON.stringify(store.hiveEvents(admin, new URLSearchParams())).includes("content that must stay out"), false);
});

test("an all-members webhook sees other members' readable writes, with sensitive content withheld", async () => {
  const sent: JsonObject[] = [];
  const store = new InMemoryHiveMemStore({ webhookTransport: async (request) => { sent.push(request.payload as JsonObject); return 202; } });
  const owner = agent("team-owner"), member = agent("team-member"), helper = agent("team-helper");
  store.createWorkspace(owner, { workspace_id: "team", title: "Team" });
  store.upsertWorkspaceMember(owner, "team", member.agentId, { role: "member" });
  store.upsertWorkspaceMember(owner, "team", helper.agentId, { role: "admin" });

  assert.throws(() => store.createWebhook(member, { url: "https://receiver.example.com/member", workspace_id: "team", all_members: true }), /admin permission/);
  const plain = store.createWebhook(owner, { url: "https://receiver.example.com/own", workspace_id: "team", event_types: ["memory.created"] });
  const observer = store.createWebhook(owner, { url: "https://receiver.example.com/all", workspace_id: "team", event_types: ["memory.created", "session.created"], all_members: true });
  assert.equal(observer.all_members, true);
  const delegated = store.createWebhook(helper, { url: "https://receiver.example.com/helper", workspace_id: "team", event_types: ["memory.created"], all_members: true });

  store.createMemory(member, { content: "a shared team fact", type: "semantic", scope: "shared", workspace_id: "team" });
  store.createMemory(member, { content: "a sensitive team fact", type: "semantic", scope: "shared", workspace_id: "team", sensitivity: "sensitive" });
  store.createMemory(member, { content: "a member's private note", type: "semantic", scope: "private", workspace_id: "team" });
  store.createSession(member, { session_id: "team-private-session", scope: "private", workspace_id: "team" });

  const deliveries = (endpointId: string) => store.snapshot().queueJobs.filter((job) => job.task_type === "webhook_delivery" && job.payload.endpoint_id === endpointId);
  assert.equal(deliveries(plain.id).length, 0, "a plain endpoint still sees only its owner's writes");
  const observed = deliveries(observer.id).map((job) => job.payload as { member_event: boolean; actor_agent_id: string; data: { content: string | null; content_withheld?: boolean; agent_id: string } });
  assert.equal(observed.length, 2, "private memories and private sessions of other members are not delivered");
  assert.deepEqual(observed.map((payload) => [payload.member_event, payload.actor_agent_id, payload.data.agent_id]), [[true, member.agentId, member.agentId], [true, member.agentId, member.agentId]]);
  assert.deepEqual(observed.map((payload) => [payload.data.content, payload.data.content_withheld ?? false]), [["a shared team fact", false], [null, true]]);

  // Losing the admin role stops delivery even for events already queued.
  store.upsertWorkspaceMember(owner, "team", helper.agentId, { role: "member" });
  const queued = deliveries(delegated.id);
  assert.equal(queued.length, 2);
  for (const job of queued) await store.runQueueJob(admin, job.id);
  assert.equal(sent.some((payload) => payload.endpoint_id === delegated.id), false);
  assert.deepEqual(store.listWebhookDeliveries(helper, new URLSearchParams("workspace_id=team")).deliveries.filter((item) => item.endpoint_id === delegated.id).map((item) => item.error), ["workspace_access_withdrawn", "workspace_access_withdrawn"]);
  // And no new member events are queued for it.
  store.createMemory(member, { content: "after the downgrade", type: "semantic", scope: "shared", workspace_id: "team" });
  assert.equal(deliveries(delegated.id).length, 2);
});
