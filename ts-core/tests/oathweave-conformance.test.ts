import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { runOathweaveConformance } from "@hivemagnus/hive-common/oathweave/conformance";
import { createOathweaveServiceVerifier, createOathweaveVerifier } from "../src/identity.js";

test("HiveMem's Oathweave verifiers meet the shared conformance vectors", async () => {
  const report = await runOathweaveConformance((token, ctx) => {
    if (ctx.principal === "service") {
      return createOathweaveServiceVerifier(
        { issuers: [ctx.issuer, ...ctx.nativeIssuers], audience: ctx.audience },
        createLocalJWKSet(ctx.jwks),
        { now: () => ctx.nowMs },
      )(token);
    }
    return createOathweaveVerifier(
      { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
      { fetch: ctx.fetch, now: () => ctx.nowMs },
    )(token);
  });
  assert.equal(report.failed, 0);
  for (const name of ["valid-native-service", "unconfigured-native-issuer", "native-service-lifetime-too-long"])
    assert(report.results.some((result) => result.name === name && result.passed), name);
});

test("user-token refusals carry the shared reasons", async () => {
  const userVectors = ["valid-user", "expired", "not-yet-valid", "wrong-audience", "wrong-issuer", "bad-signature", "unknown-kid", "alg-none", "hs256-confusion", "lifetime-too-long", "user-without-session"];
  const report = await runOathweaveConformance((token, ctx) => createOathweaveVerifier(
    { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
    { fetch: ctx.fetch, now: () => ctx.nowMs },
  )(token), { strictReasons: true, only: userVectors });
  assert.equal(report.passed, userVectors.length);
});

test("user tokens keep HiveMem's rules: roles and clientId required, small clock tolerance, short session reuse", async () => {
  const keys = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] });
  const issuer = "https://identity.example.com";
  let userinfoCalls = 0;
  const config = { issuer, jwksUrl: issuer + "/jwks", userinfoUrl: issuer + "/userinfo", audience: "hivemem" };
  const userinfo = async () => { userinfoCalls += 1; return Response.json({ sub: "fake-user" }); };
  const now = Math.floor(Date.now() / 1000);
  const clock = () => now * 1000;
  const sign = (claims: JWTPayload, omit: string[] = [], iat = now) => {
    const payload: JWTPayload = { actorType: "USER", sessionId: "fake-session", clientId: "hivexui-hivemem", roles: [], permissions: ["hivemem:memories:read"], ...claims };
    for (const name of omit) delete payload[name];
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("fake-user").setIssuer(issuer).setAudience("hivemem").setJti("fake-jti")
      .setIssuedAt(iat).setExpirationTime(iat + 300)
      .sign(keys.privateKey);
  };
  // Defaults: 5 s clock tolerance, userinfo answer reused for 3 s.
  const verify = createOathweaveVerifier(config, { keys: jwks, fetch: userinfo, now: clock });
  const valid = await sign({});
  assert.equal((await verify(valid)).subject, "fake-user");
  await verify(valid);
  assert.equal(userinfoCalls, 1, "the session answer is reused inside the window");
  await assert.rejects(verify(await sign({}, ["roles"])));
  await assert.rejects(verify(await sign({ client_id: "hivexui-hivemem" }, ["clientId"])));
  await verify(await sign({}, [], now + 4));
  await verify(await sign({}, [], now - 304));
  await assert.rejects(verify(await sign({}, [], now + 10)), "a token issued beyond the tolerance is refused");
  await assert.rejects(verify(await sign({}, [], now - 310)), "a token expired beyond the tolerance is refused");

  // 0 and 0 restore exact times and a session check on every call.
  userinfoCalls = 0;
  const strict = createOathweaveVerifier(config, { keys: jwks, fetch: userinfo, now: clock, clockToleranceSec: 0, sessionCacheMs: 0 });
  await strict(valid);
  await strict(valid);
  assert.equal(userinfoCalls, 2, "no session cache window");
  await assert.rejects(strict(await sign({}, [], now + 4)), "a token issued in the future is refused without tolerance");
  await assert.rejects(strict(await sign({}, [], now - 304)), "an expired token is refused without tolerance");

  // Out-of-range overrides are clamped to the bounds, never widened.
  const clamped = createOathweaveVerifier(config, { keys: jwks, fetch: userinfo, now: clock, clockToleranceSec: 3600 });
  await clamped(await sign({}, [], now - 350));
  await assert.rejects(clamped(await sign({}, [], now - 370)), "tolerance is capped at 60 s");
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

test("service tokens get the same clock tolerance, and 0 restores exact times", async () => {
  const keys = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }] });
  const now = Math.floor(Date.now() / 1000);
  const clock = () => now * 1000;
  const sign = (iat: number) => new SignJWT({ actorType: "SERVICE_ACCOUNT", token_type: "access", permissions: ["hivemem:memories:read"], clientId: "fake-service" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("fake-service").setIssuer("hive-iam").setAudience("hivemem").setJti("fake-jti")
    .setIssuedAt(iat).setExpirationTime(iat + 300)
    .sign(keys.privateKey);
  const verify = createOathweaveServiceVerifier({ issuers: ["hive-iam"], audience: "hivemem" }, jwks, { now: clock });
  await verify(await sign(now + 4));
  await verify(await sign(now - 304));
  await assert.rejects(verify(await sign(now + 10)));
  await assert.rejects(verify(await sign(now - 310)));
  const strict = createOathweaveServiceVerifier({ issuers: ["hive-iam"], audience: "hivemem" }, jwks, { now: clock, clockToleranceSec: 0 });
  await assert.rejects(strict(await sign(now + 4)));
  await assert.rejects(strict(await sign(now - 304)));
});
