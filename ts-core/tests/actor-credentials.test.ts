import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { InMemoryHiveMemStore } from '../src/store.js';
import { createHiveMemHandler } from '../src/server.js';
import { signToken, verifyBearerToken } from '../src/auth.js';
import type { AuthPrincipal } from '../src/types.js';
const secret = 'b'.repeat(64);
const owner: AuthPrincipal = { agentId: 'fixture-owner', scopes: ['admin:agents', 'memories:read'], rawClaims: { role: 'agent' } };
const body = () => ({ action: 'enroll', agent_id: 'fixture-agent', display_name: 'Fixture Agent', scopes: ['memories:read'], workspace_id: 'default', expires_at: new Date(Date.now() + 3600_000).toISOString() });
test('native enrollment replays exact issuance after snapshot restore, with encrypted bounded owner-bound receipts', () => {
  const store = new InMemoryHiveMemStore(), policy = body(), first = store.actorCredentials(owner, 'a'.repeat(64), policy, secret);
  assert.equal(typeof first.token, 'string');
  const snapshot = structuredClone(store.snapshot());
  assert(!JSON.stringify(snapshot).includes(String(first.token)));
  const restored = new InMemoryHiveMemStore({ snapshot });
  assert.deepEqual(restored.actorCredentials(owner, 'a'.repeat(64), policy, secret), first);
  assert.throws(() => restored.actorCredentials({ ...owner, agentId: 'other-owner' }, 'a'.repeat(64), policy, secret), /another/);
  assert.throws(() => restored.actorCredentials(owner, 'a'.repeat(64), { ...policy, display_name: 'Other name' }, secret), /another/);
  assert.throws(() => restored.actorCredentials(owner, 'b'.repeat(64), policy, secret), /already exists/);
  assert.equal(restored.snapshot().agents.length, 1);
  restored.acknowledgeActorCredentials(owner, 'a'.repeat(64));
  assert.throws(() => restored.actorCredentials(owner, 'a'.repeat(64), policy, secret), /expired or acknowledged/);
});
test('scope and workspace authority are enforced before mutation; rotations and containment revoke older credentials without extending deadlines', () => {
  const store = new InMemoryHiveMemStore(), policy = body(), before = structuredClone(store.snapshot());
  assert.throws(() => store.actorCredentials({ ...owner, scopes: ['admin:agents'] }, 'a'.repeat(64), policy, secret), /does not hold/);
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.actorCredentials(owner, 'a'.repeat(64), { ...policy, workspace_id: 'missing' }, secret), /Workspace not found/);
  assert.deepEqual(store.snapshot(), before);
  const first = store.actorCredentials(owner, 'a'.repeat(64), policy, secret);
  const rotation = { ...policy, action: 'rotate', expires_at: new Date(Date.parse(policy.expires_at) + 3600_000).toISOString() };
  const second = store.actorCredentials(owner, 'b'.repeat(64), rotation, secret);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(store.actorCredentials(owner, 'b'.repeat(64), rotation, secret), second);
  assert.throws(() => store.assertCredentialActive(verifyBearerToken('Bearer ' + first.token, secret)), /rotated/);
  assert.equal(verifyBearerToken('Bearer ' + second.token, secret).rawClaims.exp, Math.floor(Date.parse(policy.expires_at) / 1000));
  store.actorCredentials({ ...owner, scopes: ['admin:agents'] }, 'c'.repeat(64), { ...rotation, action: 'disable' }, secret);
  assert.throws(() => store.assertCredentialActive(verifyBearerToken('Bearer ' + second.token, secret)), /disabled/);
  assert.throws(() => store.actorCredentials(owner, 'b'.repeat(64), rotation, secret), /expired or acknowledged/);
  assert.throws(() => store.actorCredentials(owner, 'd'.repeat(64), rotation, secret), /Disabled/);
});
test('HTTP credential operation authorizes direct scope and replays without a second enrollment', async () => {
  const store = new InMemoryHiveMemStore();
  const server = createServer(createHiveMemHandler({ store, jwtSecret: secret })).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object');
  const target = `http://127.0.0.1:${address.port}/v1/actor-credentials/` + 'a'.repeat(64), policy = body();
  const token = (scopes: string[]) => signToken(secret, { sub: owner.agentId, role: 'agent', scope: scopes.join(' '), exp: Math.floor(Date.now() / 1000) + 300 });
  try {
    assert.equal((await fetch(target, { method: 'POST', headers: { Authorization: 'Bearer ' + token(['agents:write']), 'Content-Type': 'application/json' }, body: JSON.stringify(policy) })).status, 403);
    const headers = { Authorization: 'Bearer ' + token([...owner.scopes]), 'Content-Type': 'application/json' };
    const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(policy) }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const first = await response.json();
    assert.deepEqual(await (await fetch(target, { method: 'POST', headers, body: JSON.stringify(policy) })).json(), first);
    assert.equal(store.snapshot().agents.filter(agent => agent.agent_id === policy.agent_id).length, 1);
    assert.equal((await fetch(target + '/receipt', { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(target, { method: 'POST', headers, body: JSON.stringify(policy) })).status, 410);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
