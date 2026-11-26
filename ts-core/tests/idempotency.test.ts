import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { InMemoryHiveMemStore } from '../src/store.js';
import { createHiveMemServer } from '../src/server.js';
import { signToken } from '../src/auth.js';
import { IdempotencyCache, IdempotencyError, requestFingerprint } from '../src/idempotency.js';
import type { HiveMemSnapshot } from '../src/persistence.js';

async function serve(store: InMemoryHiveMemStore) {
  const secret = randomBytes(32).toString('hex');
  const tokenFor = (sub: string) => signToken(secret, { sub, scope: '*', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 });
  const tokens = { first: tokenFor('idempotency-first'), second: tokenFor('idempotency-second') };
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, who: keyof typeof tokens = 'first') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { post, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const memory = (content: string) => ({ content, type: 'semantic', scope: 'private' });
const count = (store: InMemoryHiveMemStore, content: string) => store.snapshot().memories.filter((item) => item.content === content).length;

test('a repeated Idempotency-Key replays the stored memory instead of writing twice', async () => {
  const store = new InMemoryHiveMemStore();
  const server = await serve(store);
  try {
    const first = await server.post('/v1/memories', memory('Replay fixture'), { 'idempotency-key': 'key-1' });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), null);
    const created = await first.json() as { id: string };
    const second = await server.post('/v1/memories', memory('Replay fixture'), { 'idempotency-key': 'key-1' });
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal((await second.json() as { id: string }).id, created.id);
    assert.equal(count(store, 'Replay fixture'), 1);
    // Re-serialized with another key order, the same request still replays.
    const reordered = await server.post('/v1/memories', { scope: 'private', type: 'semantic', content: 'Replay fixture' }, { 'x-idempotency-key': 'key-1' });
    assert.equal(reordered.status, 201);
    assert.equal(count(store, 'Replay fixture'), 1);
    // Without a key every POST is a new write, as before.
    await server.post('/v1/memories', memory('Replay fixture'));
    assert.equal(count(store, 'Replay fixture'), 2);
  } finally { await server.close(); }
});

test('the same key with a different request is refused and writes nothing', async () => {
  const store = new InMemoryHiveMemStore();
  const server = await serve(store);
  try {
    assert.equal((await server.post('/v1/memories', memory('Original body'), { 'idempotency-key': 'key-2' })).status, 201);
    const changed = await server.post('/v1/memories', memory('Changed body'), { 'idempotency-key': 'key-2' });
    assert.equal(changed.status, 422);
    assert.match((await changed.json() as { detail: string }).detail, /different request/);
    const otherRoute = await server.post('/v1/sessions', memory('Original body'), { 'idempotency-key': 'key-2' });
    assert.equal(otherRoute.status, 422);
    assert.equal(count(store, 'Changed body'), 0);
  } finally { await server.close(); }
});

test('keys are scoped to the principal', async () => {
  const store = new InMemoryHiveMemStore();
  const server = await serve(store);
  try {
    const first = await (await server.post('/v1/memories', memory('Scoped fixture'), { 'idempotency-key': 'shared' }, 'first')).json() as { id: string; agent_id: string };
    const second = await server.post('/v1/memories', memory('Scoped fixture'), { 'idempotency-key': 'shared' }, 'second');
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotent-replayed'), null);
    const body = await second.json() as { id: string; agent_id: string };
    assert.notEqual(body.id, first.id);
    assert.equal(body.agent_id, 'idempotency-second');
  } finally { await server.close(); }
});

test('a malformed key is a 400, and a failed request frees its key', async () => {
  const store = new InMemoryHiveMemStore();
  const server = await serve(store);
  try {
    const malformed = await server.post('/v1/memories', memory('Malformed key'), { 'idempotency-key': 'has space' });
    assert.equal(malformed.status, 400);
    const conflicting = await server.post('/v1/memories', memory('Malformed key'), { 'idempotency-key': 'a', 'x-idempotency-key': 'b' });
    assert.equal(conflicting.status, 400);
    assert.equal(count(store, 'Malformed key'), 0);
    const invalid = await server.post('/v1/memories', { content: 'x', type: 'not-a-type', scope: 'private' }, { 'idempotency-key': 'key-3' });
    assert.ok(invalid.status >= 400 && invalid.status < 500, String(invalid.status));
    const valid = await server.post('/v1/memories', memory('After a failure'), { 'idempotency-key': 'key-3' });
    assert.equal(valid.status, 201);
    assert.equal(count(store, 'After a failure'), 1);
  } finally { await server.close(); }
});

test('a retry after an indeterminate persistence failure replays once persistence recovers', async () => {
  let fail = false; let saved: HiveMemSnapshot = new InMemoryHiveMemStore().snapshot();
  const store = new InMemoryHiveMemStore({ persistence: { kind: 'qdrant', load: async () => saved, save: async (snapshot) => { if (fail) throw new Error('Injected unavailable persistence'); saved = structuredClone(snapshot); } } });
  const server = await serve(store);
  try {
    fail = true;
    const first = await server.post('/v1/memories', memory('Indeterminate write'), { 'idempotency-key': 'key-4' });
    assert.equal(first.status, 503);
    const stillDown = await server.post('/v1/memories', memory('Indeterminate write'), { 'idempotency-key': 'key-4' });
    assert.equal(stillDown.status, 503);
    fail = false; store.retryPersistence(); await store.flushPersistence();
    const retried = await server.post('/v1/memories', memory('Indeterminate write'), { 'idempotency-key': 'key-4' });
    assert.equal(retried.status, 201);
    assert.equal(retried.headers.get('idempotent-replayed'), 'true');
    assert.equal(count(store, 'Indeterminate write'), 1);
    assert.equal(saved.memories.filter((item) => item.content === 'Indeterminate write').length, 1);
    assert.equal((await retried.json() as { id: string }).id, saved.memories.find((item) => item.content === 'Indeterminate write')?.id);
  } finally { await server.close(); }
});

test('read-only POSTs ignore the key', async () => {
  const store = new InMemoryHiveMemStore();
  const server = await serve(store);
  try {
    await server.post('/v1/memories', memory('Searchable fixture'));
    for (const body of [{ query: 'Searchable' }, { query: 'fixture' }]) {
      const search = await server.post('/v1/memories/search', body, { 'idempotency-key': 'search-key' });
      assert.equal(search.status, 200);
      assert.equal(search.headers.get('idempotent-replayed'), null);
    }
  } finally { await server.close(); }
});

test('the cache reports an in-flight key, expires records and bounds their size', () => {
  let now = 1_000;
  const cache = new IdempotencyCache({ ttlMs: 100, maxEntries: 2, maxEntryBytes: 8, now: () => now });
  const owner = {}; const fingerprint = requestFingerprint('POST', '/v1/memories', '', { a: 1 });
  assert.equal(cache.begin('agent', 'k', fingerprint, owner), undefined);
  assert.throws(() => cache.begin('agent', 'k', fingerprint, {}), (error: unknown) => error instanceof IdempotencyError && error.status === 409);
  cache.complete('agent', 'k', owner, 201, '{"id":1}');
  assert.deepEqual(cache.begin('agent', 'k', fingerprint, {}), { status: 201, payload: '{"id":1}' });
  now += 101;
  assert.equal(cache.begin('agent', 'k', fingerprint, owner), undefined, 'An expired record is forgotten');
  cache.complete('agent', 'k', owner, 201, 'a payload over the limit');
  assert.equal(cache.begin('agent', 'k', fingerprint, {}), undefined, 'An oversized result is not kept');
  for (const key of ['x', 'y', 'z']) { const own = {}; cache.begin('agent', key, fingerprint, own); cache.complete('agent', key, own, 200, '{}'); }
  assert.equal(cache.size, 2, 'The oldest completed records are evicted past the entry limit');
});
