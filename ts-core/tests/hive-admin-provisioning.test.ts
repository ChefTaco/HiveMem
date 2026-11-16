import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createHiveMemServer, type HiveMemServerOptions } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { authorizeHiveAdminProvisioning, hiveAdminProvisioningConfig, HiveAdminProvisioningError } from "../src/hive-admin-provisioning.js";
import type { AuthPrincipal } from "../src/types.js";
import type { HiveMemPersistence, HiveMemSnapshot } from "../src/persistence.js";

const secret = "b".repeat(64);
const issuer = "https://identity.example.com/api/oathweave";
const operation = "11111111-2222-4333-8444-555555555555";
const nextOperation = "11111111-2222-4333-8444-666666666666";
const endpoint = "/internal/hive/admin-accounts/";
const body = { version: 1, issuer, subject: "synthetic-person-id", local_id: "synthetic-memory-person", username: "_synthetic-admin", display_name: "Synthetic Administrator" };
const admin: AuthPrincipal = { agentId: "synthetic-existing-operator", scopes: ["admin:all"], rawClaims: { role: "admin" } };

async function serve(store = new InMemoryHiveMemStore(), options: Partial<HiveMemServerOptions> = {}, enabled = true) {
  const server = createHiveMemServer({ jwtSecret: "a".repeat(64), store, ...(enabled ? { adminProvisioningSecret: secret, adminProvisioningIssuer: issuer } : {}), ...options });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method = "POST", value: unknown = body, id = operation, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(base + endpoint + id, { method, headers: { "content-type": "application/json", "x-hive-admin-provisioning-secret": secret, ...extraHeaders }, ...(method === "POST" ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown>, cacheControl: response.headers.get("cache-control") };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return { store, call, close, base };
}

test("installer creation and exact retries preserve a distinct principal and durable receipt across restore", async () => {
  const store = new InMemoryHiveMemStore();
  store.registerAgent(admin, { agent_id: "synthetic-retained-agent", display_name: "Retained", operation_id: "retained-operation" }, "");
  const retained = store.snapshot().agents[0];
  const app = await serve(store);
  let original: Record<string, unknown>;
  let snapshot: HiveMemSnapshot;
  try {
    const response = await app.call();
    assert.equal(response.status, 201);
    assert.equal(response.cacheControl, "no-store");
    original = response.body;
    assert.equal(original.local_id, body.local_id);
    assert.equal(original.issuer, issuer);
    assert.equal(original.subject, body.subject);
    assert.equal(original.credential_generation, 0);
    assert.equal(original.active, true);
    assert.equal(original.status, "committed");
    assert.match(String(original.request_sha256), /^[a-f0-9]{64}$/);
    assert.equal("token" in original, false);
    snapshot = store.snapshot();
    assert.equal(snapshot.agents.length, 2);
    assert.deepEqual(snapshot.agents[0], retained);
    const repeated = await app.call();
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, original);
    assert.deepEqual((await app.call("GET")).body, original);
    assert.deepEqual(store.snapshot(), snapshot);
  } finally { await app.close(); }
  const restored = await serve(new InMemoryHiveMemStore({ snapshot }));
  try {
    assert.deepEqual((await restored.call("GET")).body, original);
    assert.equal((await restored.call()).status, 200);
    assert.deepEqual(restored.store.snapshot(), snapshot);
  } finally { await restored.close(); }
  const rebound = await serve(new InMemoryHiveMemStore({ snapshot }), { adminProvisioningIssuer: "https://other.example.com/api/oathweave" });
  try {
    assert.equal((await rebound.call("GET")).status, 409);
    assert.equal((await rebound.call("POST", { ...body, issuer: "https://other.example.com/api/oathweave" })).status, 409);
    assert.deepEqual(rebound.store.snapshot(), snapshot);
  } finally { await rebound.close(); }
});

test("concurrent requests own one principal and changed requests or identities are refused", async () => {
  const app = await serve();
  try {
    const responses = await Promise.all([app.call(), app.call()]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
    const before = app.store.snapshot();
    for (const [value, id] of [
      [{ ...body, username: "different-admin" }, operation],
      [{ ...body, local_id: "different-memory-person" }, nextOperation],
      [{ ...body, subject: "different-person" }, nextOperation],
    ] as const) assert.equal((await app.call("POST", value, id)).status, 409);
    assert.equal((await app.call("GET", undefined, nextOperation)).status, 404);
    assert.deepEqual(app.store.snapshot(), before);
  } finally { await app.close(); }
});

test("disabled, rotated, changed or missing principals never re-enroll or reset on receipt retries", async () => {
  for (const mutation of ["disable", "rotate", "rename", "missing", "binding"] as const) {
    const app = await serve();
    let snapshot: HiveMemSnapshot;
    try {
      assert.equal((await app.call()).status, 201);
      if (mutation === "disable") app.store.updateAgent(admin, body.local_id, { active: false });
      if (mutation === "rotate") app.store.rotateAgentCredentials(admin, body.local_id);
      if (mutation === "rename") app.store.updateAgent(admin, body.local_id, { display_name: "Changed name" });
      snapshot = app.store.snapshot();
    } finally { await app.close(); }
    if (mutation === "missing") snapshot.agents = [];
    if (mutation === "binding") snapshot.agents[0]!.metadata.hive_admin_account = { issuer, subject: "foreign-subject" };
    const restored = await serve(new InMemoryHiveMemStore({ snapshot }));
    try {
      assert.equal((await restored.call("GET")).status, 409, mutation);
      assert.equal((await restored.call()).status, 409, mutation);
      assert.deepEqual(restored.store.snapshot(), snapshot);
    } finally { await restored.close(); }
  }
});

test("foreign native IDs are never adopted and strict bodies cannot request credentials or broader authority", async () => {
  const store = new InMemoryHiveMemStore();
  store.registerAgent(admin, { agent_id: body.local_id, display_name: body.display_name }, "");
  const app = await serve(store);
  const before = store.snapshot();
  try {
    assert.equal((await app.call()).status, 409);
    for (const value of [
      { ...body, issuer: "https://other.example.com/api/oathweave" },
      { ...body, role: "admin" }, { ...body, token_scopes: ["*"] },
      { ...body, local_id: "../../foreign" }, { ...body, subject: "subject\nchanged" },
      { ...body, display_name: "" }, { ...body, display_name: null }, { ...body, username: "not valid" },
    ]) assert.equal((await app.call("POST", value)).status, 422);
    const response = await app.call("POST", { ...body, display_name: "x".repeat(5000) });
    assert.equal(response.status, 413);
    assert.deepEqual(store.snapshot(), before);
  } finally { await app.close(); }
});

test("the boundary is disabled without configuration and refuses browser, proxy and non-loopback credentials", async () => {
  assert.equal(hiveAdminProvisioningConfig(undefined, undefined), undefined);
  assert.throws(() => hiveAdminProvisioningConfig("short", issuer), /64 lowercase/);
  assert.throws(() => hiveAdminProvisioningConfig(secret, "http://identity.example.com"), /HTTPS/);
  assert.throws(() => hiveAdminProvisioningConfig(secret, undefined), /HTTPS/);
  assert.throws(() => createHiveMemServer({ jwtSecret: secret, adminProvisioningSecret: secret, adminProvisioningIssuer: issuer }), /independent/);
  const disabled = await serve(undefined, {}, false);
  try {
    assert.equal((await disabled.call()).status, 404);
    assert.equal((await disabled.call("GET")).status, 404);
    assert.equal(disabled.store.snapshot().agents.length, 0);
  } finally { await disabled.close(); }
});

test("the dedicated secret alone cannot authorize remote, forwarded, browser or native-bearer requests", async () => {
  const config = hiveAdminProvisioningConfig(secret, issuer)!;
  for (const remote of ["203.0.113.8", "::ffff:203.0.113.8", undefined, "127.not-an-address"]) {
    const request = { headers: { "x-hive-admin-provisioning-secret": secret }, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
    assert.throws(() => authorizeHiveAdminProvisioning(request, config), error => error instanceof HiveAdminProvisioningError && error.status === 403);
  }
  for (const remote of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    const request = { headers: { "x-hive-admin-provisioning-secret": secret }, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
    assert.doesNotThrow(() => authorizeHiveAdminProvisioning(request, config));
  }
  const app = await serve();
  try {
    for (const headers of [
      { "x-hive-admin-provisioning-secret": "c".repeat(64) },
      { "x-hive-admin-provisioning-secret": "" },
      { origin: "https://console.example.com" }, { cookie: "synthetic-session=example" },
      { authorization: "Bearer synthetic-token" }, { "x-forwarded-for": "127.0.0.1" }, { forwarded: "for=127.0.0.1" },
      { referer: "https://console.example.com/" }, { "x-real-ip": "127.0.0.1" },
    ]) assert.equal((await app.call("POST", body, operation, headers)).status, 403);
    assert.equal((await app.call("GET")).status, 404);
    const publicRoute = await fetch(app.base + "/v1/agents", { headers: { "x-hive-admin-provisioning-secret": secret } });
    assert.equal(publicRoute.status, 401);
    assert.equal(app.store.snapshot().agents.length, 0);
  } finally { await app.close(); }
});

test("successful acknowledgement waits for persistence and a failed checkpoint is reconciled without replaying creation", async () => {
  let release!: () => void;
  let saving!: () => void;
  const started = new Promise<void>(resolve => { saving = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saved: HiveMemSnapshot | undefined;
  const persistence: HiveMemPersistence = { kind: "qdrant", load: async () => new InMemoryHiveMemStore().snapshot(), save: async snapshot => { saving(); await gate; saved = snapshot; } };
  const app = await serve(new InMemoryHiveMemStore({ persistence }));
  try {
    let acknowledged = false;
    const response = app.call().then(value => { acknowledged = true; return value; });
    await started;
    assert.equal(acknowledged, false);
    assert.equal(saved, undefined);
    release();
    assert.equal((await response).status, 201);
    assert.equal(saved!.agents.length, 1);
    assert.equal(saved!.operations!.filter(row => row.kind === "hive-admin-account").length, 1);
  } finally { release(); await app.close(); }

  let unavailable = true;
  const failing: HiveMemPersistence = { kind: "qdrant", load: persistence.load, save: async snapshot => { if (unavailable) throw new Error("synthetic private persistence detail"); saved = snapshot; } };
  const recovering = await serve(new InMemoryHiveMemStore({ persistence: failing }));
  try {
    const first = await recovering.call();
    assert.equal(first.status, 503);
    assert.equal(JSON.stringify(first.body).includes("synthetic private"), false);
    assert.equal((await recovering.call("GET")).status, 503);
    unavailable = false;
    assert.equal((await recovering.call()).status, 200);
    assert.equal((await recovering.call("GET")).status, 200);
    assert.equal(saved!.agents.length, 1);
    assert.equal(saved!.operations!.filter(row => row.kind === "hive-admin-account").length, 1);
  } finally { await recovering.close(); }
});
