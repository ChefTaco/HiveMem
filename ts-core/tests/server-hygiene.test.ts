import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHiveMemServer, type HiveMemServerOptions } from "../src/server.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import { signToken } from "../src/auth.js";
import { QdrantHiveMemPersistence } from "../src/persistence.js";
import { PrincipalRateLimiter, RateLimitError, rateLimitedPath, searchRateLimitFromEnv } from "../src/rate-limit.js";

const secret = randomBytes(32).toString("hex");
const token = (sub: string, scope = "memories:read memories:write context:read sessions:read sessions:write") =>
  signToken(secret, { sub, role: "agent", scope, exp: Math.floor(Date.now() / 1000) + 300 });

async function withServer(options: HiveMemServerOptions, run: (base: string) => Promise<void>): Promise<void> {
  const server = createHiveMemServer({ jwtSecret: secret, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${port}`); } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type ErrorBody = { detail: string; error: { code: string; message: string; requestId: string } };

test("error bodies keep detail and add the suite envelope with the response's request ID", async () => {
  await withServer({}, async (base) => {
    const cases: Array<[string, RequestInit, number, string]> = [
      ["/v1/no-such-route", { headers: { authorization: `Bearer ${token("envelope-agent")}` } }, 404, "not_found"],
      ["/v1/memories/browse", {}, 401, "unauthorized"],
      ["/v1/admin/audit", { headers: { authorization: `Bearer ${token("envelope-agent")}` } }, 403, "forbidden"],
      ["/v1/backup", { method: "POST", headers: { authorization: `Bearer ${signToken(secret, { sub: "operator", role: "admin", scope: "*", exp: Math.floor(Date.now() / 1000) + 300 })}` } }, 501, "not_implemented"],
    ];
    for (const [path, init, status, code] of cases) {
      const response = await fetch(base + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-request-id": "fixture-request-0001" } });
      assert.equal(response.status, status, path);
      const body = await response.json() as ErrorBody;
      assert.equal(typeof body.detail, "string", path);
      assert.deepEqual(body.error, { code, message: body.detail, requestId: response.headers.get("x-request-id") }, path);
    }
    // Success bodies are untouched.
    const ok = await (await fetch(base + "/v1/memories/browse", { headers: { authorization: `Bearer ${token("envelope-agent")}` } })).json() as Record<string, unknown>;
    assert.equal("error" in ok, false);
  });
});

test("search, context and chat are limited per principal, with Retry-After", async () => {
  await withServer({ searchRateLimitPerMinute: 3 }, async (base) => {
    const search = (sub: string) => fetch(base + "/v1/memories/search", { method: "POST", headers: { authorization: `Bearer ${token(sub)}`, "content-type": "application/json" }, body: JSON.stringify({ query: "fixture" }) });
    for (let index = 0; index < 3; index++) assert.equal((await search("busy-agent")).status, 200);
    const limited = await search("busy-agent");
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.equal((await limited.json() as ErrorBody).error.code, "rate_limited");
    // Context and chat share the same budget; another principal has its own.
    assert.equal((await fetch(base + "/v1/context", { method: "POST", headers: { authorization: `Bearer ${token("busy-agent")}`, "content-type": "application/json" }, body: JSON.stringify({ query: "fixture" }) })).status, 429);
    assert.equal((await search("quiet-agent")).status, 200);
    // Writes and reads outside the scanning routes are not limited.
    const write = await fetch(base + "/v1/memories", { method: "POST", headers: { authorization: `Bearer ${token("busy-agent")}`, "content-type": "application/json" }, body: JSON.stringify({ content: "still writable", type: "semantic", scope: "private" }) });
    assert.equal(write.status, 201);
  });
  await withServer({ searchRateLimitPerMinute: 0 }, async (base) => {
    for (let index = 0; index < 20; index++) {
      const response = await fetch(base + "/v1/memories/search", { method: "POST", headers: { authorization: `Bearer ${token("unlimited-agent")}`, "content-type": "application/json" }, body: JSON.stringify({ query: "fixture" }) });
      assert.equal(response.status, 200);
    }
  });
});

test("the limiter refills evenly and its settings are validated", () => {
  let now = 0;
  const limiter = new PrincipalRateLimiter(60, () => now);
  for (let index = 0; index < 60; index++) limiter.take("agent");
  assert.throws(() => limiter.take("agent"), (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 1);
  now += 1000;
  limiter.take("agent");
  assert.throws(() => limiter.take("agent"), RateLimitError);
  assert.equal(searchRateLimitFromEnv(undefined), 600);
  assert.equal(searchRateLimitFromEnv("0"), 0);
  assert.equal(searchRateLimitFromEnv("120"), 120);
  for (const raw of ["-1", "1.5", "lots"]) assert.throws(() => searchRateLimitFromEnv(raw), /HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE/);
  assert.equal(rateLimitedPath("POST", "/v1/sessions/abc/chat"), true);
  assert.equal(rateLimitedPath("POST", "/v1/sessions/abc/context"), true);
  assert.equal(rateLimitedPath("GET", "/v1/memories/search"), false);
  assert.equal(rateLimitedPath("POST", "/v1/memories"), false);
});

test("health routes share one readiness run", async () => {
  let probes = 0;
  const store = new InMemoryHiveMemStore({ persistence: { kind: "qdrant", load: async () => new InMemoryHiveMemStore().snapshot(), save: async () => undefined, probe: async () => { probes++; await new Promise((resolve) => setTimeout(resolve, 20)); } } });
  await withServer({ store, readyCacheMs: 60_000 }, async (base) => {
    const paths = ["/v1/health", "/v1/health/ready", "/health/ready", "/v1/health/dependencies"];
    const answers = await Promise.all([...paths, ...paths].map((path) => fetch(base + path)));
    assert.deepEqual(answers.map((response) => response.status), Array(8).fill(200));
    for (const path of paths) assert.equal((await fetch(base + path)).status, 200);
    assert.equal(probes, 1, "one probe serves every concurrent and cached health request");
  });
  probes = 0;
  await withServer({ store, readyCacheMs: 0 }, async (base) => {
    await fetch(base + "/v1/health/ready");
    await fetch(base + "/v1/health/ready");
    assert.equal(probes, 2, "readyCacheMs 0 shares only a run in progress");
  });
});

test("Qdrant failures leave the response body out of the error and responses are bounded", async () => {
  const leaked = "payload-content-that-must-not-reach-logs";
  let mode: "error" | "huge" = "error";
  const fake: Server = createServer((_request, response) => {
    if (mode === "error") { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ status: { error: leaked } })); return; }
    response.writeHead(200, { "content-type": "application/json", "content-length": String(300 * 1024 * 1024) });
    response.end();
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const { port } = fake.address() as AddressInfo;
  try {
    const persistence = new QdrantHiveMemPersistence({ url: `http://127.0.0.1:${port}` });
    const failure = await persistence.load().then(() => null, (error: unknown) => error as Error);
    assert.ok(failure);
    assert.match(failure.message, /Qdrant GET \/collections failed with 500$/);
    assert.equal(failure.message.includes(leaked), false);
    mode = "huge";
    await assert.rejects(persistence.load(), (error: unknown) => !String((error as Error).message).includes(leaked));
  } finally {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
