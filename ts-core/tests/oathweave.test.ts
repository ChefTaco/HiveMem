import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHiveMemHandler } from "../src/server.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOathweaveServiceVerifier, createOathweaveVerifier, oathweaveClockToleranceSec, oathweaveSessionCacheMs } from "../src/identity.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAccountLinks } from "../src/account-links.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import type { AuthPrincipal } from "../src/types.js";

const operator: AuthPrincipal = {agentId:'synthetic-operator',scopes:['*'],rawClaims:{role:'admin'}};

test("resource verification rejects wrong audiences and revoked sessions", async () => {
  const keys = await generateKeyPair("RS256");
  const config = {
    issuer: "https://identity.example.com",
    jwksUrl: "https://identity.example.com/jwks",
    userinfoUrl: "https://identity.example.com/userinfo",
    audience: "hivemem",
  };
  let online = true;
  const verify = createOathweaveVerifier(config, {
    sessionCacheMs: 0,
    keys: createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }],
    }),
    fetch: async () =>
      online
        ? Response.json({ sub: "fake-user" })
        : new Response("", { status: 401 }),
  });
  const token = async (audience: string) =>
    new SignJWT({
      actorType: "USER",
      sessionId: "fake-session",
      clientId: "hivexui-hivemem",
      roles: ["SUPER_ADMIN"],
      permissions: ["hivemem:memories:read"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("fake-user")
      .setIssuer(config.issuer)
      .setAudience(audience)
      .setJti("fake-jti")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  const identity = await verify(await token("hivemem"));
  assert.deepEqual(identity.permissions, ["hivemem:memories:read"]);
  await assert.rejects(verify(await token("emberpath")));
  online = false;
  await assert.rejects(verify(await token("hivemem")));
});

test("HTTP keeps identity reads scoped and prevents role-based write escalation", async () => {
  const store=new InMemoryHiveMemStore();
  store.registerAgent(operator,{agent_id:'existing-agent',display_name:'Synthetic existing agent'},'obviously-fake-native-token');
  const handler = createHiveMemHandler({
    store,
    jwtSecret: "f".repeat(64),
    oathweaveAccountLinks: [
      {
        issuer: "https://identity.example.com",
        subject: "fake-user",
        localId: "existing-agent",
      },
    ],
    verifyOathweave: async () => ({
      subject: "fake-user",
      issuer: "https://identity.example.com",
      sessionId: "fake-session",
      tokenId: "fake-jti",
      roles: ["SUPER_ADMIN"],
      permissions: ["hivemem:memories:read"],
      displayName: "Test User",
    }),
  });
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.obviously-fake-fixture.signature`,
    "Content-Type": "application/json",
  };
  try {
    assert.equal(
      (await fetch(origin + "/v1/memories/browse", { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/memories/search", {
          method: "POST",
          headers,
          body: JSON.stringify({ query: "synthetic" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/memories", {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "synthetic fixture",
            type: "semantic",
            scope: "shared",
          }),
        })
      ).status,
      403,
    );
    assert.equal((await fetch(origin + "/v1/memories")).status, 401);
    const before = structuredClone(store.snapshot());
    assert.equal((await fetch(origin + "/v1/memories/conflicts", {method: "POST", headers, body: JSON.stringify({content: "synthetic conflict query"})})).status, 200);
    assert.deepEqual(store.snapshot(), before, "Conflict detection is a read and must not create mutation receipts");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('browser links require an existing active account and the reviewed credential generation',async()=>{
  const secret='f'.repeat(64);
  const store=new InMemoryHiveMemStore();
  const link={issuer:'https://identity.example.com',subject:'fake-user',localId:'existing-agent',credentialGeneration:1};
  const handler=createHiveMemHandler({jwtSecret:secret,store,oathweaveAccountLinks:[link],verifyOathweave:async()=>({...link,sessionId:'fake-session',tokenId:'fake-jti',roles:[],permissions:['hivemem:memories:read'],displayName:'Synthetic person'})});
  const server=createServer(handler).listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  assert(address && typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  const headers={Authorization:`Bearer ${Buffer.from(JSON.stringify({alg:'RS256'})).toString('base64url')}.obviously-fake-fixture.signature`};
  const read=()=>fetch(origin+'/v1/memories/browse',{headers});
  try {
    assert.equal((await read()).status,403);
    assert.throws(()=>store.getAgent(operator,link.localId));
    store.registerAgent(operator,{agent_id:link.localId,display_name:'Synthetic existing agent'},'obviously-fake-native-token');
    assert.equal((await read()).status,403); // Generation zero cannot accept a generation-one link.
    store.rotateAgentCredentials(operator,link.localId);
    assert.equal((await read()).status,200);
    const native=signToken(secret,{sub:link.localId,role:'agent',scope:'memories:read',token_generation:0,exp:Math.floor(Date.now()/1000)+300});
    assert.equal((await fetch(origin+'/v1/memories/browse',{headers:{Authorization:'Bearer '+native}})).status,403);
    store.rotateAgentCredentials(operator,link.localId);
    assert.equal((await read()).status,403);
    link.credentialGeneration=2; // An explicit reviewed configuration update.
    assert.equal((await read()).status,200);
    store.updateAgent(operator,link.localId,{active:false});
    link.credentialGeneration=store.credentialGeneration(link.localId);
    assert.equal((await read()).status,403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

test("an account link's scopes cap what Oathweave grants, including admin", async () => {
  const store = new InMemoryHiveMemStore();
  store.registerAgent(operator, { agent_id: "capped-agent", display_name: "Synthetic capped agent" }, "obviously-fake-native-token");
  const issuer = "https://identity.example.com";
  let permissions = ["hivemem:admin:all", "hivemem:memories:read", "hivemem:memories:write"];
  const links: Array<{ issuer: string; subject: string; localId: string; scopes?: string[] }> = [{ issuer, subject: "fake-user", localId: "capped-agent", scopes: ["memories:read"] }];
  const handler = createHiveMemHandler({
    store, jwtSecret: "f".repeat(64), oathweaveAccountLinks: links,
    verifyOathweave: async () => ({ subject: "fake-user", issuer, sessionId: "fake-session", tokenId: "fake-jti", roles: ["SUPER_ADMIN"], permissions, displayName: "Synthetic person" }),
  });
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.obviously-fake-fixture.signature`, "Content-Type": "application/json" };
  const me = async () => (await (await fetch(origin + "/v1/auth/me", { headers })).json()) as { scopes: string[] };
  try {
    assert.deepEqual((await me()).scopes, ["memories:read"]);
    assert.equal((await fetch(origin + "/v1/admin/audit", { headers })).status, 403, "a granted admin:all outside the ceiling is dropped");
    assert.equal((await fetch(origin + "/v1/memories", { method: "POST", headers, body: JSON.stringify({ content: "capped write", type: "semantic", scope: "private" }) })).status, 403);
    assert.equal((await fetch(origin + "/v1/memories/browse", { headers })).status, 200);
    // A ceiling never widens: a wildcard ceiling keeps only what Oathweave grants.
    links[0]!.scopes = ["memories:*"];
    permissions = ["hivemem:memories:read"];
    assert.deepEqual((await me()).scopes, ["memories:read"]);
    // A granted wildcard is narrowed to the ceiling.
    links[0]!.scopes = ["memories:read", "sessions:read"];
    permissions = ["hivemem:*"];
    assert.deepEqual((await me()).scopes.sort(), ["memories:read", "sessions:read"]);
    // No ceiling keeps today's behaviour: every hivemem: permission applies.
    delete links[0]!.scopes;
    permissions = ["hivemem:admin:all"];
    assert.equal((await fetch(origin + "/v1/admin/audit", { headers })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("account links accept only well-formed scope ceilings", () => {
  const base = { issuer: "https://identity.example.com", subject: "fake-user", localId: "capped-agent" };
  assert.deepEqual(parseAccountLinks(JSON.stringify([{ ...base, scopes: ["memories:read", "memories:*"] }]))[0]!.scopes, ["memories:read", "memories:*"]);
  assert.equal(parseAccountLinks(JSON.stringify([base]))[0]!.scopes, undefined);
  for (const scopes of [[], ["Memories:Read"], ["memories read"], "memories:read"]) assert.throws(() => parseAccountLinks(JSON.stringify([{ ...base, scopes }])));
});

test("the userinfo reuse window defaults to three seconds and is capped at five", async () => {
  assert.equal(oathweaveSessionCacheMs(undefined), 3000);
  assert.equal(oathweaveSessionCacheMs(""), 3000);
  assert.equal(oathweaveSessionCacheMs("0"), 0, "0 restores the check on every request");
  assert.equal(oathweaveSessionCacheMs("2000"), 2000);
  assert.equal(oathweaveSessionCacheMs("5000"), 5000);
  for (const raw of ["-1", "5001", "1.5", "abc", "60000"]) assert.throws(() => oathweaveSessionCacheMs(raw), /HIVEMEM_OATHWEAVE_SESSION_CACHE_MS/);

  const keys = await generateKeyPair("RS256");
  const config = { issuer: "https://identity.example.com", jwksUrl: "https://identity.example.com/jwks", userinfoUrl: "https://identity.example.com/userinfo", audience: "hivemem" };
  let clock = Date.now();
  const token = await new SignJWT({ actorType: "USER", sessionId: "fake-session", clientId: "hivexui-hivemem", roles: [], permissions: ["hivemem:memories:read"] })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject("fake-user").setIssuer(config.issuer).setAudience("hivemem")
    .setJti("fake-jti").setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 300).sign(keys.privateKey);
  const local = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] });
  for (const [sessionCacheMs, expected] of [[undefined, 1], [0, 3], [3000, 1]] as const) {
    let calls = 0;
    const verify = createOathweaveVerifier(config, { keys: local, now: () => clock, ...(sessionCacheMs === undefined ? {} : { sessionCacheMs }), fetch: async () => { calls++; return Response.json({ sub: "fake-user" }); } });
    for (let index = 0; index < 3; index++) await verify(token);
    assert.equal(calls, expected, `session cache ${String(sessionCacheMs)}`);
  }
  // Past the default window the session is checked again, so a sign-out lands within 3 s.
  let calls = 0;
  let online = true;
  const verify = createOathweaveVerifier(config, { keys: local, now: () => clock, fetch: async () => { calls++; return online ? Response.json({ sub: "fake-user" }) : new Response("", { status: 401 }); } });
  await verify(token);
  online = false;
  clock += 2500;
  await verify(token);
  assert.equal(calls, 1, "a signed-out session may keep working inside the window");
  clock += 1000;
  await assert.rejects(verify(token));
  assert.equal(calls, 2);
  // A refused check is not reused as a success.
  online = true;
  await assert.rejects(verify(token));
});

test("the Oathweave clock tolerance defaults to five seconds and is capped at sixty", () => {
  assert.equal(oathweaveClockToleranceSec(undefined), 5);
  assert.equal(oathweaveClockToleranceSec(" "), 5);
  assert.equal(oathweaveClockToleranceSec("0"), 0);
  assert.equal(oathweaveClockToleranceSec("60"), 60);
  for (const raw of ["-1", "61", "2.5", "abc", "300"]) assert.throws(() => oathweaveClockToleranceSec(raw), /HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC/);
});

test("a revoked token ID is refused on every request, even while its session answer is cached", async () => {
  const keys = await generateKeyPair("RS256");
  const issuer = "https://identity.example.com";
  const config = { issuer, jwksUrl: issuer + "/jwks", userinfoUrl: issuer + "/userinfo", audience: "hivemem" };
  const now = Math.floor(Date.now() / 1000);
  const sign = (jti: string) => new SignJWT({ actorType: "USER", sessionId: "fake-session", clientId: "hivexui-hivemem", roles: [], permissions: ["hivemem:memories:read"] })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject("fake-user").setIssuer(issuer).setAudience("hivemem")
    .setJti(jti).setIssuedAt(now).setExpirationTime(now + 300).sign(keys.privateKey);
  let userinfoCalls = 0;
  // One verifier, so both handlers share its userinfo cache.
  const verify = createOathweaveVerifier(config, {
    keys: createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] }),
    sessionCacheMs: 5000,
    fetch: async () => { userinfoCalls++; return Response.json({ sub: "fake-user" }); },
  });
  const revoked = await sign("revoked-browser-jti");
  const kept = await sign("kept-browser-jti");
  const directory = await mkdtemp(join(tmpdir(), "hivemem-oathweave-revoked-"));
  const revocationFilePath = join(directory, "revoked.json");
  await writeFile(revocationFilePath, JSON.stringify({ "revoked-browser-jti": now + 300 }), { mode: 0o600 });
  const servers: ReturnType<typeof createServer>[] = [];
  const start = async (options: { revocationFilePath?: string }) => {
    const store = new InMemoryHiveMemStore();
    store.registerAgent(operator, { agent_id: "existing-agent", display_name: "Synthetic existing agent" }, "obviously-fake-native-token");
    const server = createServer(createHiveMemHandler({
      store, jwtSecret: "f".repeat(64), verifyOathweave: verify,
      oathweaveAccountLinks: [{ issuer, subject: "fake-user", localId: "existing-agent" }], ...options,
    })).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    return (token: string) => fetch(`http://127.0.0.1:${address.port}/v1/memories/browse`, { headers: { Authorization: `Bearer ${token}` } });
  };
  try {
    const open = await start({ revocationFilePath: join(directory, "none.json") });
    assert.equal((await open(revoked)).status, 200, "warms the session cache");
    assert.equal(userinfoCalls, 1);
    const guarded = await start({ revocationFilePath });
    assert.equal((await guarded(revoked)).status, 401);
    assert.equal(userinfoCalls, 1, "refused although the cached session answer was still fresh");
    assert.equal((await guarded(kept)).status, 200);
    assert.equal((await guarded(revoked)).status, 401);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("service tokens are checked against the configured JWKS endpoint by the shared verifier", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "service-key", alg: "RS256", use: "sig" };
  const requested: string[] = [];
  const verify = createOathweaveServiceVerifier(
    { issuers: ["hive-iam"], audience: "hivemem", jwksUrl: "https://identity.example.com/jwks" },
    undefined,
    { fetch: async (input) => { requested.push(String(input instanceof Request ? input.url : input)); return Response.json({ keys: [jwk] }); } },
  );
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ actorType: "SERVICE_ACCOUNT", clientId: "example-service", clientName: "example-service", token_type: "access", roles: [], permissions: ["hivemem:memories:read"] })
    .setProtectedHeader({ alg: "RS256", kid: "service-key" }).setSubject("example-service").setIssuer("hive-iam").setAudience("hivemem")
    .setJti("service-jti").setIssuedAt(now).setExpirationTime(now + 300).sign(keys.privateKey);
  const principal = await verify(token);
  assert.equal(principal.clientId, "example-service");
  await verify(token);
  assert.deepEqual(requested, ["https://identity.example.com/jwks"], "keys are fetched once and cached");
  assert.throws(() => createOathweaveServiceVerifier({ issuers: ["hive-iam"], audience: "hivemem" }), /OATHWEAVE_JWKS_URL/);
});
