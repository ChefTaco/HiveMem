import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { InMemoryHiveMemStore, createHiveMemServer, signToken } from '../src/index.js';

/** `detail` is unchanged for existing clients; the suite envelope rides alongside it. */
function assertErrorBody(body: { detail?: unknown; error?: { code?: unknown; message?: unknown; requestId?: unknown } }, code: string, message: string): void {
  assert.equal(body.detail, message);
  assert.equal(body.error?.code, code);
  assert.equal(body.error?.message, message);
  assert.match(String(body.error?.requestId), /^[A-Za-z0-9._:-]{8,}$/);
}

const secret = 'b'.repeat(48);
const limit = 4096;

async function withServer(run: (port: number, token: string) => Promise<void>): Promise<void> {
  const server: Server = createHiveMemServer({ jwtSecret: secret, store: new InMemoryHiveMemStore(), maxBodyBytes: limit });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const token = signToken(secret, { sub: 'body-agent', role: 'agent', scope: 'memories:write memories:read', exp: Math.floor(Date.now() / 1000) + 300 });
  try { await run(port, token); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

interface RawResponse { status: number; body: string }

/** POST a body in chunks without a content-length, as a streaming client does. */
function postChunked(port: number, token: string, chunks: readonly string[], headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/memories', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    let index = 0;
    const next = (): void => {
      if (index >= chunks.length) { req.end(); return; }
      const chunk = chunks[index++]!;
      req.write(chunk, () => setTimeout(next, 5));
    };
    next();
  });
}

test('a streamed body over the limit is answered with 413 and the same message', async () => {
  await withServer(async (port, token) => {
    // Far more than socket buffers hold, so a server that stops reading leaves the client blocked.
    const chunks = Array.from({ length: 128 }, () => 'x'.repeat(64 * 1024));
    const response = await postChunked(port, token, ['{"content":"', ...chunks, '"}']);
    assert.equal(response.status, 413);
    assertErrorBody(JSON.parse(response.body), 'too_large', `Request body exceeds ${limit} bytes`);
  });
});

test('a declared content-length over the limit is refused with 413 before reading', async () => {
  await withServer(async (port, token) => {
    const body = JSON.stringify({ content: 'x'.repeat(limit) });
    const response = await fetch(`http://127.0.0.1:${port}/v1/memories`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 413);
    assertErrorBody(await response.json(), 'too_large', `Request body exceeds ${limit} bytes`);
  });
});

test('request bodies keep their parsing rules: empty is {}, invalid JSON is a 400', async () => {
  await withServer(async (port, token) => {
    const invalid = await postChunked(port, token, ['{"content":', ' nope}']);
    assert.equal(invalid.status, 400);
    assertErrorBody(JSON.parse(invalid.body), 'bad_request', 'Invalid JSON request body');
    // An empty or whitespace-only body is read as {} (here refused by validation, not as JSON).
    for (const chunks of [[], ['  \n ']]) {
      const empty = await postChunked(port, token, chunks);
      assert.notEqual(JSON.parse(empty.body).detail, 'Invalid JSON request body');
      assert.notEqual(empty.status, 413);
    }
    // No content-type check was ever applied, and none is now.
    const memory = JSON.stringify({ content: 'stored without a JSON content type' });
    const typed = await postChunked(port, token, [memory]);
    const plain = await postChunked(port, token, [memory], { 'content-type': 'text/plain' });
    assert.equal(plain.status, typed.status);
    assert.notEqual(plain.status, 415);
    // A body exactly at the limit is accepted.
    const prefix = '{"content":"', suffix = '"}';
    const exact = await postChunked(port, token, [prefix + 'y'.repeat(limit - prefix.length - suffix.length) + suffix]);
    assert.notEqual(exact.status, 413);
  });
});

test('a client that disconnects mid-body is not logged as an internal error', async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  await withServer(async (port, token) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/memories', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    req.on('error', () => undefined);
    await new Promise<void>((resolve) => req.write('{"content":', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The server still answers.
    const health = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert.equal(health.status, 200);
  });
  assert.deepEqual(logged, []);
});
