import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { runOathweaveConformance } from "@hivemagnus/hive-common/oathweave/conformance";
import { createOathweaveServiceVerifier, createOathweaveVerifier } from "../src/identity.js";

test("HiveMem's Oathweave verifiers meet the shared conformance vectors", async () => {
  const report = await runOathweaveConformance((token, ctx) => {
    if (ctx.principal === "service") {
      return createOathweaveServiceVerifier({ issuers: [ctx.issuer], audience: ctx.audience }, createLocalJWKSet(ctx.jwks), { now: () => ctx.nowMs })(token);
    }
    return createOathweaveVerifier(
      { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
      { fetch: ctx.fetch, now: () => ctx.nowMs },
    )(token);
  });
  assert.equal(report.failed, 0);
});

test("user-token refusals carry the shared reasons", async () => {
  const userVectors = ["valid-user", "expired", "not-yet-valid", "wrong-audience", "wrong-issuer", "bad-signature", "unknown-kid", "alg-none", "hs256-confusion", "lifetime-too-long", "user-without-session"];
  const report = await runOathweaveConformance((token, ctx) => createOathweaveVerifier(
    { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
    { fetch: ctx.fetch, now: () => ctx.nowMs },
  )(token), { strictReasons: true, only: userVectors });
  assert.equal(report.passed, userVectors.length);
});

test("user tokens keep HiveMem's rules: roles and clientId required, no clock tolerance, session checked every call", async () => {
  const keys = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] });
  const issuer = "https://identity.example.com";
  let userinfoCalls = 0;
  const verify = createOathweaveVerifier(
    { issuer, jwksUrl: issuer + "/jwks", userinfoUrl: issuer + "/userinfo", audience: "hivemem" },
    { keys: jwks, fetch: async () => { userinfoCalls += 1; return Response.json({ sub: "fake-user" }); } },
  );
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims: JWTPayload, omit: string[] = [], iat = now) => {
    const payload: JWTPayload = { actorType: "USER", sessionId: "fake-session", clientId: "hivexui-hivemem", roles: [], permissions: ["hivemem:memories:read"], ...claims };
    for (const name of omit) delete payload[name];
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("fake-user").setIssuer(issuer).setAudience("hivemem").setJti("fake-jti")
      .setIssuedAt(iat).setExpirationTime(iat + 300)
      .sign(keys.privateKey);
  };
  const valid = await sign({});
  assert.equal((await verify(valid)).subject, "fake-user");
  await verify(valid);
  assert.equal(userinfoCalls, 2, "no session cache window");
  await assert.rejects(verify(await sign({}, ["roles"])));
  await assert.rejects(verify(await sign({ client_id: "hivexui-hivemem" }, ["clientId"])));
  await assert.rejects(verify(await sign({}, [], now + 10)), "a token issued in the future is refused without tolerance");
  await assert.rejects(verify(await sign({}, [], now - 305)), "an expired token is refused without tolerance");
});

test("service tokens must name their client in clientId", async () => {
  const keys = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] });
  const verify = createOathweaveServiceVerifier({ issuers: ["hive-iam"], audience: "hivemem" }, jwks);
  const sign = (claims: JWTPayload) => new SignJWT({ actorType: "SERVICE_ACCOUNT", token_type: "access", permissions: ["hivemem:memories:read"], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("fake-service").setIssuer("hive-iam").setAudience("hivemem").setJti("fake-jti")
    .setIssuedAt().setExpirationTime("5m")
    .sign(keys.privateKey);
  assert.equal((await verify(await sign({ clientId: "fake-service" }))).clientId, "fake-service");
  await assert.rejects(verify(await sign({ client_id: "fake-service" })));
});
