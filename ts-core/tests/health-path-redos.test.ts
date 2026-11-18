import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { InMemoryHiveMemStore } from '../src/index.js';
import { createHiveMemHandler } from '../src/server.js';

const secret = 'h'.repeat(48);

// Unauthenticated GET and HEAD requests pass their path to the shared health resolver before any
// other routing. A path of many slashes followed by another character made its trailing-slash trim
// quadratic (hive-common before 0.5.1). The server allows a long request target here so the whole
// adversarial path reaches the handler.
async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer({ maxHeaderSize: 1024 * 1024 }, createHiveMemHandler({ jwtSecret: secret, store: new InMemoryHiveMemStore() }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(port); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function send(port: number, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const method of ['GET', 'HEAD']) {
  test(`${method} on a path of many slashes and a final character is answered quickly`, async () => {
    await withServer(async (port) => {
      const path = '/health' + '/'.repeat(100_000) + 'x';
      const started = performance.now();
      const status = await send(port, method, path);
      const elapsed = performance.now() - started;
      assert.notEqual(status, 200);
      assert.ok(elapsed < 1000, `answered in ${Math.round(elapsed)} ms`);
      // The health routes still resolve, trailing slashes included.
      assert.equal(await send(port, method, '/health/live///'), 200);
    });
  });
}
