import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHiveMemHandler } from "../src/server.js";
import { createOathweaveServiceVerifier } from "../src/identity.js";
import type { ServiceLink } from "../src/account-links.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import { HiveAuditPageSchema, HiveAuditRecordSchema, toHiveAuditRecord } from "../src/audit-export.js";

const jwtSecret = "a".repeat(64);
const issuer = "oathweave-fake-installation";
const auditClient = "fake-audit-collector";
const memoryClient = "fake-memory-reader";
const secretContent = "synthetic-confidential-memory-body";
const secretToken = "synthetic-token-value-that-must-not-leak";

async function serve(store = new InMemoryHiveMemStore()) {
  const signing = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: "fake-kid", alg: "RS256" }] });
  const links: ServiceLink[] = [
    { issuer, clientId: auditClient, localId: "fake-collector", scopes: ["audit:read"] },
    { issuer, clientId: memoryClient, localId: "fake-reader", scopes: ["memories:read", "memories:write", "audit:read"] },
  ];
  const handler = createHiveMemHandler({
    store, jwtSecret, oathweaveAccountLinks: [], oathweaveServiceLinks: links,
    verifyOathweaveService: createOathweaveServiceVerifier({ issuers: [issuer], audience: "hivemem" }, keys),
  });
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const service = (clientId: string, permissions: string[]) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ actorType: "SERVICE_ACCOUNT", clientId, clientName: clientId, token_type: "access", roles: [], permissions })
      .setProtectedHeader({ alg: "RS256", kid: "fake-kid" }).setSubject(clientId).setIssuer(issuer).setAudience("hivemem")
      .setJti("fake-jti-" + Math.random().toString(16).slice(2)).setIssuedAt(now).setExpirationTime(now + 300).sign(signing.privateKey);
  };
  const local = (claims: Record<string, unknown>) => signToken(jwtSecret, { exp: Math.floor(Date.now() / 1000) + 300, ...claims });
  const call = async (path: string, token?: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" } });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : null, cacheControl: response.headers.get("cache-control") };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  return { store, call, service, local, close };
}

/** Legacy records with equal timestamps, an unknown extra field and non-audit kinds. */
function seededStore() {
  const operations = [
    { id: "b-record", kind: "tombstone", actor: "fake-agent", created_at: "2026-01-01T00:00:00.000Z", memory_id: "mem-1", workspace_id: "default", content: secretContent },
    { id: "a-record", kind: "api.mutation", actor: "fake-agent", created_at: "2026-01-01T00:00:00.000Z", path: "/v1/memories/mem-1", method: "DELETE", status: 204, request_id: "req-1", body: { content: secretContent } },
    { id: "c-record", kind: "actor-credential.enroll", actor: "fake-admin", actor_type: "user", created_at: "2026-01-02T00:00:00.000Z", agent_id: "fake-new-agent", workspace_id: "default", operation_id: "op-1", token_generation: 1, expires_at: "2026-02-01T00:00:00.000Z", token: secretToken },
    { id: "d-record", kind: "conflict.resolve", actor: "fake-agent", created_at: "2026-01-03T00:00:00.000Z", memory_id: "mem-2", workspace_id: "other", resolved: 1, action: "keep_both" },
    { id: "e-record", kind: "actor-credential", owner: "fake-admin", encrypted_receipt: secretToken, created_at: "2026-01-04T00:00:00.000Z" },
    { id: "f-record", kind: "consolidation-run", created_at: "2026-01-05T00:00:00.000Z", result: { content: secretContent } },
    { id: "g-record", kind: "retention", actor: "fake-agent", created_at: "2026-01-06T00:00:00.000Z", workspace_id: "default", archived: 3 },
  ];
  const store = new InMemoryHiveMemStore();
  return new InMemoryHiveMemStore({ snapshot: { ...store.snapshot(), operations } });
}

async function exportAll(call: (path: string, token?: string) => Promise<{ status: number; body: Record<string, unknown> | null }>, token: string, limit: number) {
  const records: Array<Record<string, unknown>> = [];
  let after: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const response = await call(`/v1/audit/export?limit=${limit}${after ? "&after=" + after : ""}`, token);
    assert.equal(response.status, 200);
    const page = HiveAuditPageSchema.parse(response.body);
    assert.ok(page.data.length <= limit);
    // Amendment 1: a cursor on every page with records, null only on an empty page.
    assert.equal(page.nextCursor === null, page.data.length === 0);
    records.push(...page.data);
    if (!page.nextCursor) return records;
    after = page.nextCursor;
  }
  throw new Error("export did not finish");
}

test("audit export pages oldest first by (created_at, id) with a stable cursor round trip", async () => {
  const { call, service, close } = await serve(seededStore());
  try {
    const token = await service(auditClient, ["hivemem:audit:read"]);
    const all = await exportAll(call, token, 200);
    assert.deepEqual(all.map((record) => record.id), ["a-record", "b-record", "c-record", "d-record", "g-record"].map((id) => "hivemem:audit:" + id));
    for (const limit of [1, 2, 3]) assert.deepEqual(await exportAll(call, token, limit), all, `limit ${limit}`);
    // IDs are stable across calls and the caught-up cursor stays caught up.
    const first = await call("/v1/audit/export?limit=4", token);
    const rest = await call("/v1/audit/export?after=" + String(first.body!.nextCursor), token);
    assert.deepEqual((rest.body!.data as unknown[]).map((record) => (record as { id: string }).id), ["hivemem:audit:g-record"]);
    assert.equal(typeof rest.body!.nextCursor, "string");
    const caughtUp = await call("/v1/audit/export?after=" + String(rest.body!.nextCursor), token);
    assert.deepEqual(caughtUp.body, { data: [], nextCursor: null });
    assert.equal(first.cacheControl, "no-store");
    assert.deepEqual(all.map((record) => record.action), ["memory.delete", "memory.tombstone", "actor_credential.enroll", "conflict.resolve", "lifecycle.retention_archive"]);
    const enroll = all[2]!;
    assert.deepEqual(enroll.actor, { type: "user", id: "fake-admin" });
    assert.deepEqual(enroll.target, { type: "agent", id: "fake-new-agent" });
    assert.deepEqual(enroll.subject, { actorId: "fake-new-agent" });
    assert.deepEqual(all[0]!.target, { type: "memory", id: "mem-1" });
    assert.deepEqual(all[0]!.subject, { actorId: "fake-agent" });
    assert.equal((all[3]!.details as Record<string, unknown>).resolution, "keep_both");
  } finally { await close(); }
});

test("audit export bounds limit and rejects malformed cursors and repeated parameters", async () => {
  const { call, local, close } = await serve(seededStore());
  try {
    const admin = local({ sub: "fake-admin", role: "admin", scope: "*" });
    assert.equal(((await call("/v1/audit/export", admin)).body!.data as unknown[]).length, 5);
    assert.equal((await call("/v1/audit/export?limit=1000", admin)).status, 200);
    for (const query of ["limit=0", "limit=-1", "limit=abc", "limit=1&limit=2", "after=not%20a%20cursor", "after=bm90LWpzb24", "after=" + Buffer.from(JSON.stringify({ t: 1 })).toString("base64url"), "after=" + Buffer.from(JSON.stringify({ t: "x", i: "y", z: "w" })).toString("base64url")]) {
      const response = await call("/v1/audit/export?" + query, admin);
      assert.equal(response.status, 400, query);
    }
  } finally { await close(); }
});

test("audit export requires an administrator or a service token with hivemem:audit:read", async () => {
  const { call, local, service, close } = await serve(seededStore());
  try {
    assert.equal((await call("/v1/audit/export")).status, 401);
    assert.equal((await call("/v1/audit/export", "not-a-token")).status, 401);
    assert.equal((await call("/v1/audit/export", local({ sub: "fake-agent", role: "agent", scope: "memories:read memories:write" }))).status, 403);
    // A local token naming the scope is not a service identity.
    assert.equal((await call("/v1/audit/export", local({ sub: "fake-agent", role: "agent", scope: "audit:read *" }))).status, 403);
    assert.equal((await call("/v1/audit/export", await service(memoryClient, ["hivemem:memories:read"]))).status, 403);
    assert.equal((await call("/v1/audit/export", await service(auditClient, ["hivemem:audit:read"]))).status, 200);
    assert.equal((await call("/v1/audit/export", await service(memoryClient, ["hivemem:memories:read", "hivemem:audit:read"]))).status, 200);
    // The audit permission does not reach memory or admin routes.
    const auditor = await service(auditClient, ["hivemem:audit:read"]);
    assert.equal((await call("/v1/memories", auditor)).status, 403);
    assert.equal((await call("/v1/admin/audit", auditor)).status, 403);
    assert.equal((await call("/v1/audit/export", local({ sub: "fake-admin", role: "admin", scope: "*" }))).status, 200);
    assert.equal((await call("/v1/audit/export", local({ sub: "fake-admin", role: "agent", scope: "admin:all" }))).status, 200);
    // A workspace-restricted administrator sees only its workspaces.
    const scoped = await call("/v1/audit/export", local({ sub: "fake-admin", role: "admin", scope: "*", workspace_ids: ["other"] }));
    assert.deepEqual((scoped.body!.data as Array<{ id: string }>).map((record) => record.id), ["hivemem:audit:d-record"]);
    assert.equal((await call("/v1/audit/export", auditor, { method: "POST" })).status, 404);
  } finally { await close(); }
});

test("live operations export as schema-valid records without memory content or secrets", async () => {
  const { call, local, service, close } = await serve();
  try {
    const admin = local({ sub: "fake-admin", role: "admin", scope: "*" });
    const created = await call("/v1/memories", admin, { method: "POST", body: JSON.stringify({ content: secretContent, type: "semantic", scope: "shared", workspace_id: "default", metadata: { api_key: secretToken } }) });
    assert.equal(created.status, 201);
    const id = String(created.body!.id);
    assert.equal((await call("/v1/memories/" + encodeURIComponent(id), admin, { method: "PUT", body: JSON.stringify({ content: secretContent + "-v2" }) })).status, 200);
    assert.equal((await call("/v1/memories/" + encodeURIComponent(id), admin, { method: "DELETE" })).status < 300, true);
    const token = await service(auditClient, ["hivemem:audit:read"]);
    const response = await call("/v1/audit/export", token);
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes(secretContent));
    assert.ok(!response.text.includes(secretToken));
    const page = HiveAuditPageSchema.parse(response.body);
    for (const record of page.data) HiveAuditRecordSchema.parse(record);
    assert.deepEqual(page.data.map((record) => record.action), ["memory.create", "memory.update", "memory.delete"]);
    for (const record of page.data) {
      assert.equal(record.product, "hivemem");
      assert.equal(record.outcome, "success");
      assert.deepEqual(record.actor, { type: "user", id: "fake-admin" });
      assert.match(record.occurredAt, /Z$/u);
    }
    assert.deepEqual(page.data[1]!.target, { type: "memory", id });
    // The same records come back on a second read: IDs are stable.
    assert.deepEqual((await call("/v1/audit/export", token)).body, response.body);
    // A service caller is recorded as a service, by its Oathweave client.
    const writer = await service(memoryClient, ["hivemem:memories:read", "hivemem:memories:write"]);
    assert.equal((await call("/v1/memories", writer, { method: "POST", body: JSON.stringify({ content: secretContent, type: "semantic", scope: "shared" }) })).status, 201);
    const next = HiveAuditPageSchema.parse((await call("/v1/audit/export", token)).body);
    assert.deepEqual(next.data.slice(0, 3), page.data);
    assert.deepEqual(next.data[3]!.actor, { type: "service", id: memoryClient, issuer, displayName: "fake-reader" });
    assert.equal("subject" in next.data[3]!, false);
  } finally { await close(); }
});

test("every mapped kind passes the strict schema and drops unknown fields", () => {
  const kinds = ["api.mutation", "conflict.resolve", "retention", "tombstone", "auth.renew", "actor-credential.enroll", "actor-credential.rotate", "actor-credential.renew", "actor-credential.disable"];
  const paths = ["/v1/memories", "/v1/memories/batch", "/v1/workspaces/w%201/members/a", "/v1/peers/p/card", "/v1/queue/jobs/j/retry", "/v1/actor-credentials/abc/receipt", "/v1/2fa/thing", "/v1"];
  for (const kind of kinds) for (const path of kind === "api.mutation" ? paths : ["/v1"]) for (const actor of [{ actor: "fake" }, {}, { actor: "svc", actor_type: "service", actor_issuer: issuer, actor_client_id: auditClient }]) {
    const record = toHiveAuditRecord({ id: "x-" + kind, kind, created_at: "2026-01-01T00:00:00.000Z", path, method: "PATCH", agent_id: "fake", memory_id: "m", password: secretToken, content: secretContent, ...actor });
    assert.ok(record, kind);
    HiveAuditRecordSchema.parse(record);
    assert.ok(!JSON.stringify(record).includes(secretToken));
    assert.ok(!JSON.stringify(record).includes(secretContent));
  }
  const serviceRecord = toHiveAuditRecord({ id: "s", kind: "tombstone", actor: "svc", actor_type: "service", actor_issuer: issuer, actor_client_id: auditClient, created_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(serviceRecord!.actor, { type: "service", id: auditClient, issuer, displayName: "svc" });
  assert.equal("subject" in serviceRecord!, false);
  assert.equal(toHiveAuditRecord({ id: "bad id", kind: "tombstone", created_at: "2026-01-01T00:00:00Z" }), undefined);
  assert.equal(toHiveAuditRecord({ id: "q", kind: "queue-operation", created_at: "2026-01-01T00:00:00Z" }), undefined);
  assert.equal(toHiveAuditRecord({ id: "q", kind: "tombstone", created_at: "not a date" }), undefined);
  assert.throws(() => HiveAuditRecordSchema.parse({ ...serviceRecord, extra: true }));
});

test("records written in the same millisecond, or after a page was read, are never skipped", () => {
  const store = seededStore();
  const writer = { agentId: "fake-agent", scopes: ["*"], rawClaims: { role: "agent" } };
  const admin = { agentId: "fake-admin", scopes: ["*"], rawClaims: { role: "admin" } };
  const seen: string[] = [];
  let after: string | null = null;
  const poll = (limit: string) => {
    const page = store.auditExport(admin, new URLSearchParams(after ? { after, limit } : { limit }));
    seen.push(...page.data.map((record) => String(record.target?.id)));
    if (page.nextCursor) after = page.nextCursor;
    return page;
  };
  for (let round = 0; round < 20; round++) {
    for (let index = 0; index < 5; index++) store.recordOperation("tombstone", writer, { memory_id: `m-${round}-${index}`, workspace_id: "default" });
    poll("3");
  }
  while (poll("200").data.length);
  const expected = Array.from({ length: 100 }, (_, i) => `m-${Math.floor(i / 5)}-${i % 5}`);
  assert.deepEqual(seen.filter((id) => id.startsWith("m-")), expected);
  // Restarting from a snapshot keeps later records after earlier ones.
  const restored = new InMemoryHiveMemStore({ snapshot: store.snapshot() });
  restored.recordOperation("tombstone", writer, { memory_id: "after-restart", workspace_id: "default" });
  const all = restored.auditExport(admin, new URLSearchParams({ limit: "200" })).data;
  assert.equal(all.at(-1)!.target?.id, "after-restart");
});
