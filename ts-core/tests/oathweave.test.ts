import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHiveMemHandler } from "../src/server.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOathweaveVerifier } from "../src/oathweave.js";

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
  const handler = createHiveMemHandler({
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
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
