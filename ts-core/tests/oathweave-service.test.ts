import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createHiveMemHandler } from "../src/server.js";
import { createOathweaveServiceVerifier } from "../src/oathweave.js";
import { parseServiceLinks, type ServiceLink } from "../src/account-links.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import type { AuthPrincipal } from "../src/types.js";

const issuer = "oathweave-fake-installation";
const clientId = "fake-model-gateway";
const operator: AuthPrincipal = { agentId: "synthetic-operator", scopes: ["*"], rawClaims: { role: "admin" } };

async function keyring() {
  const signing = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: "fake-kid", alg: "RS256" }] });
  const sign = (claims: JWTPayload & Record<string, unknown>, options: { key?: CryptoKey; lifetime?: number; iat?: number; omit?: string[] } = {}) => {
    const now = options.iat ?? Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      actorType: "SERVICE_ACCOUNT", clientId, clientName: clientId, token_type: "access",
      roles: [], permissions: ["hivemem:admin:all"], ...claims,
    };
    for (const name of options.omit ?? []) delete payload[name];
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "fake-kid" })
      .setSubject(typeof claims.sub === "string" ? claims.sub : clientId)
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setAudience(typeof claims.aud === "string" ? claims.aud : "hivemem")
      .setJti(typeof claims.jti === "string" ? claims.jti : "fake-jti-" + Math.random().toString(16).slice(2))
      .setIssuedAt(now)
      .setExpirationTime(now + (options.lifetime ?? 300))
      .sign(options.key ?? signing.privateKey);
  };
  return { keys, sign, stranger: stranger.privateKey };
}

test("service verification accepts only short-lived, audience-bound client_credentials tokens", async () => {
  const { keys, sign, stranger } = await keyring();
  const verify = createOathweaveServiceVerifier({ issuers: [issuer], audience: "hivemem" }, keys);
  const identity = await verify(await sign({}));
  assert.equal(identity.clientId, clientId);
  assert.equal(identity.issuer, issuer);
  assert.deepEqual(identity.permissions, ["hivemem:admin:all"]);
  const rejected = [
    await sign({ aud: "emberpath" }),
    await sign({ iss: "oathweave-other-installation" }),
    await sign({ actorType: "USER" }),
    await sign({ clientId: "another-client" }),
    await sign({ sub: "another-client" }),
    await sign({ token_type: "refresh" }),
    await sign({ sessionId: "fake-session" }),
    await sign({ permissions: "hivemem:admin:all" }),
    await sign({}, { lifetime: 3600 }),
    await sign({}, { iat: Math.floor(Date.now() / 1000) - 1200, lifetime: 600 }),
    await sign({}, { key: stranger }),
    await sign({}, { omit: ["token_type"] }),
  ];
  for (const token of rejected) await assert.rejects(verify(token));
  assert.throws(() => createOathweaveServiceVerifier({ issuers: [], audience: "hivemem" }, keys));
});

test("service links are explicit, unique and carry a scope ceiling", () => {
  const link = { issuer, clientId, localId: "fake-router", scopes: ["admin:all"] };
  assert.deepEqual(parseServiceLinks(JSON.stringify([link])), [link]);
  assert.throws(() => parseServiceLinks(JSON.stringify([link, { ...link, localId: "other" }])), /Duplicate/u);
  assert.throws(() => parseServiceLinks(JSON.stringify([{ ...link, scopes: [] }])));
  assert.throws(() => parseServiceLinks(JSON.stringify([{ ...link, extra: true }])));
  assert.throws(() => parseServiceLinks(JSON.stringify([{ ...link, clientId: "bad id" }])));
});

async function serve(options: { links?: ServiceLink[]; withService?: boolean; store?: InMemoryHiveMemStore; revocationFilePath?: string } = {}) {
  const { keys, sign } = await keyring();
  const store = options.store ?? new InMemoryHiveMemStore();
  const links = options.links ?? [{ issuer, clientId, localId: "fake-router", scopes: ["admin:all"] }];
  const handler = createHiveMemHandler({
    store,
    jwtSecret: "f".repeat(64),
    oathweaveAccountLinks: [],
    oathweaveServiceLinks: links,
    ...(options.withService === false ? {} : { verifyOathweaveService: createOathweaveServiceVerifier({ issuers: links.map((item) => item.issuer), audience: "hivemem" }, keys) }),
    ...(options.revocationFilePath ? { revocationFilePath: options.revocationFilePath } : {}),
  });
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, token: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  return { store, sign, call, close };
}

test("a linked service identity reaches the admin endpoints a model gateway uses, as its local principal", async () => {
  const { store, sign, call, close } = await serve();
  try {
    const token = await sign({});
    assert.equal((await call("/v1/agents", token)).status, 200);
    assert.equal((await call("/v1/stats", token)).status, 200);
    assert.equal((await call("/v1/memories/browse?limit=5&workspace_id=*", token)).status, 200);
    const registered = await call("/v1/agents/register", token, { method: "POST", body: JSON.stringify({ agent_id: "fake-onboarded-agent", display_name: "Synthetic onboarded agent" }) });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const issued = await call("/v1/auth/tokens", token, { method: "POST", body: JSON.stringify({ agent_id: "fake-onboarded-agent", scopes: ["memories:read"], expires_hours: 1 }) });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body?.agent_id, "fake-onboarded-agent");
    const created = await call("/v1/memories", token, { method: "POST", body: JSON.stringify({ content: "synthetic service fixture", type: "semantic", scope: "shared" }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((created.body as { agent_id?: string } | null)?.agent_id ?? "fake-router", "fake-router");
    assert(store.snapshot());
  } finally { await close(); }
});

test("service identities cannot exceed their link, convert into HiveMem tokens, or outlive containment", async () => {
  const { store, sign, call, close } = await serve({ links: [{ issuer, clientId, localId: "fake-router", scopes: ["memories:read"] }] });
  try {
    // Oathweave grants admin, but the link allows only reads.
    assert.equal((await call("/v1/agents", await sign({}))).status, 403);
    const reader = await sign({ permissions: ["hivemem:memories:read", "iam:users:read"] });
    assert.equal((await call("/v1/memories/browse?limit=5", reader)).status, 200);
    assert.equal((await call("/v1/memories", reader, { method: "POST", body: JSON.stringify({ content: "synthetic", type: "semantic" }) })).status, 403);
    // Only permissions for this resource count.
    assert.equal((await call("/v1/memories/browse", await sign({ permissions: ["iam:users:read"] }))).status, 403);
    assert.equal((await call("/v1/auth/refresh", reader, { method: "POST", body: "{}" })).status, 403);
    // Unlinked clients and issuers are refused.
    assert.equal((await call("/v1/memories/browse", await sign({ sub: "unlinked-client", clientId: "unlinked-client", permissions: ["hivemem:memories:read"] }))).status, 403);
    assert.equal((await call("/v1/memories/browse", await sign({ iss: "oathweave-other-installation", permissions: ["hivemem:memories:read"] }))).status, 401);
    // Disabling the local principal contains the service immediately.
    store.registerAgent(operator, { agent_id: "fake-router", display_name: "Synthetic router" }, "obviously-fake-native-token");
    assert.equal((await call("/v1/memories/browse", reader)).status, 200);
    store.updateAgent(operator, "fake-router", { active: false });
    assert.equal((await call("/v1/memories/browse", reader)).status, 403);
  } finally { await close(); }
});

test("without a service link, service tokens are refused rather than treated as users", async () => {
  const { sign, call, close } = await serve({ links: [], withService: false });
  try {
    assert.equal((await call("/v1/agents", await sign({}))).status, 401);
  } finally { await close(); }
});

test("a service linked with admin:agents enrolls agents into a workspace it creates, within its own scopes", async () => {
  const enrollScopes = ["admin:agents", "workspaces:write", "memories:read", "memories:write", "sessions:read", "sessions:write"];
  const { store, sign, call, close } = await serve({ links: [{ issuer, clientId, localId: "fake-fleet", scopes: enrollScopes }] });
  try {
    const token = await sign({ permissions: enrollScopes.map((scope) => "hivemem:" + scope) });
    const deadline = new Date(Date.now() + 24 * 3600_000).toISOString();
    const policy = { action: "enroll", agent_id: "fake-agent", display_name: "Synthetic agent", scopes: ["memories:read", "memories:write"], workspace_id: "fake-agents", expires_at: deadline };
    const operation = (digit: string) => digit.repeat(64);
    // The workspace does not exist yet: enrollment names it, so it is created first.
    assert.equal((await call(`/v1/actor-credentials/${operation("a")}`, token, { method: "POST", body: JSON.stringify(policy) })).status, 404);
    const workspace = { workspace_id: "fake-agents", title: "Synthetic agents" };
    const created = await call("/v1/workspaces", token, { method: "POST", body: JSON.stringify(workspace) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body?.owner_agent_id, "fake-fleet");
    // Ensuring it again returns the same workspace.
    assert.equal((await call("/v1/workspaces", token, { method: "POST", body: JSON.stringify(workspace) })).body?.owner_agent_id, "fake-fleet");
    const enrolled = await call(`/v1/actor-credentials/${operation("b")}`, token, { method: "POST", body: JSON.stringify(policy) });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    assert.equal(enrolled.body?.agent_id, "fake-agent");
    const agentToken = String(enrolled.body?.token);
    const remembered = await call("/v1/memories", agentToken, { method: "POST", body: JSON.stringify({ content: "synthetic agent memory", type: "semantic", scope: "private", workspace_id: "fake-agents" }) });
    assert.equal(remembered.status, 201, JSON.stringify(remembered.body));
    // The same request replays the same credential; a second enrollment of that agent conflicts.
    assert.equal((await call(`/v1/actor-credentials/${operation("b")}`, token, { method: "POST", body: JSON.stringify(policy) })).body?.token, agentToken);
    assert.equal((await call(`/v1/actor-credentials/${operation("c")}`, token, { method: "POST", body: JSON.stringify(policy) })).status, 409);
    const rotated = await call(`/v1/actor-credentials/${operation("d")}`, token, { method: "POST", body: JSON.stringify({ ...policy, action: "rotate" }) });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(store.credentialGeneration("fake-agent"), 1);
    // It cannot grant what it does not hold, reach full administration, or enroll without admin:agents.
    assert.equal((await call(`/v1/actor-credentials/${operation("e")}`, token, { method: "POST", body: JSON.stringify({ ...policy, agent_id: "fake-other", scopes: ["webhooks:write"] }) })).status, 403);
    assert.equal((await call("/v1/admin/agents", token)).status, 403);
    const narrowed = await sign({ permissions: ["hivemem:workspaces:write", "hivemem:memories:read"] });
    assert.equal((await call(`/v1/actor-credentials/${operation("f")}`, narrowed, { method: "POST", body: JSON.stringify({ ...policy, agent_id: "fake-other" }) })).status, 403);
  } finally { await close(); }
});

test("admin:agents on the Oathweave side is ignored unless the service link allows it", async () => {
  const { call, sign, close } = await serve({ links: [{ issuer, clientId, localId: "fake-fleet", scopes: ["workspaces:write", "memories:read", "memories:write"] }] });
  try {
    const token = await sign({ permissions: ["hivemem:admin:agents", "hivemem:workspaces:write", "hivemem:memories:read", "hivemem:memories:write"] });
    assert.equal((await call("/v1/workspaces", token, { method: "POST", body: JSON.stringify({ workspace_id: "fake-agents" }) })).status, 201);
    const policy = { action: "enroll", agent_id: "fake-agent", display_name: "Synthetic agent", scopes: ["memories:read"], workspace_id: "fake-agents", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    assert.equal((await call(`/v1/actor-credentials/${"a".repeat(64)}`, token, { method: "POST", body: JSON.stringify(policy) })).status, 403);
  } finally { await close(); }
});
