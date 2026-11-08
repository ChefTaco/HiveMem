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
test('renewal sets a new deadline for an active member, keeps the previous credential only for its grace period, and is audited', () => {
  const store = new InMemoryHiveMemStore(), policy = body(), first = store.actorCredentials(owner, 'a'.repeat(64), policy, secret);
  const later = new Date(Date.now() + 600 * 3600_000).toISOString();
  const renewal = { ...policy, action: 'renew', expires_at: later, grace_seconds: 120 };
  const renewed = store.actorCredentials(owner, 'b'.repeat(64), renewal, secret);
  assert.equal(renewed.expires_at, later);
  assert.equal(verifyBearerToken('Bearer ' + renewed.token, secret).rawClaims.exp, Math.floor(Date.parse(later) / 1000));
  assert.deepEqual(store.actorCredentials(owner, 'b'.repeat(64), renewal, secret), renewed);
  // Both work during the grace period; the renewed one is the current generation.
  store.assertCredentialActive(verifyBearerToken('Bearer ' + renewed.token, secret));
  store.assertCredentialActive(verifyBearerToken('Bearer ' + first.token, secret));
  const until = Date.parse(String(renewed.previous_credential_valid_until));
  assert(until > Date.now() + 100_000 && until <= Date.now() + 120_000);
  const audit = store.adminAudit({ agentId: 'admin', scopes: ['admin:all'], rawClaims: { role: 'admin' } }, new URLSearchParams()).events as Array<Record<string, unknown>>;
  const entry = audit.find(event => event.kind === 'actor-credential.renew');
  assert.equal(entry?.agent_id, policy.agent_id);
  assert.equal(entry?.expires_at, later);
  assert.equal(entry?.actor, owner.agentId);
  assert(!JSON.stringify(audit).includes(String(renewed.token)));
  // After the grace period only the renewed credential works.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 121_000;
    assert.throws(() => store.assertCredentialActive(verifyBearerToken('Bearer ' + first.token, secret)), /rotated/);
    store.assertCredentialActive(verifyBearerToken('Bearer ' + renewed.token, secret));
  } finally { Date.now = realNow; }
  // A rotation still keeps the renewed deadline and ends any grace at once.
  const again = store.actorCredentials(owner, 'c'.repeat(64), { ...renewal, grace_seconds: 3600 }, secret);
  store.assertCredentialActive(verifyBearerToken('Bearer ' + renewed.token, secret));
  const rotated = store.actorCredentials(owner, 'd'.repeat(64), { ...policy, action: 'rotate', expires_at: new Date(Date.now() + 700 * 3600_000).toISOString() }, secret);
  assert.equal(rotated.expires_at, again.expires_at);
  assert.throws(() => store.assertCredentialActive(verifyBearerToken('Bearer ' + again.token, secret)), /rotated/);
  assert.throws(() => store.assertCredentialActive(verifyBearerToken('Bearer ' + renewed.token, secret)), /rotated/);
});
test('renewal cannot widen scopes, reach non-members or disabled agents, exceed 720 hours or carry grace on other actions', () => {
  const store = new InMemoryHiveMemStore(), policy = body();
  const wide: AuthPrincipal = { ...owner, scopes: ['admin:agents', 'memories:read', 'memories:write'] };
  store.actorCredentials(wide, 'a'.repeat(64), policy, secret);
  const renewal = { ...policy, action: 'renew', expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() };
  const before = structuredClone(store.snapshot());
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...renewal, scopes: ['memories:read', 'memories:write'] }, secret), /cannot add/);
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...renewal, scopes: ['memories:write'] }, secret), /cannot add/);
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...renewal, expires_at: new Date(Date.now() + 721 * 3600_000).toISOString() }, secret), /720 hours/);
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...renewal, grace_seconds: 86_401 }, secret), /Invalid/);
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...policy, action: 'rotate', grace_seconds: 60 }, secret), /Invalid/);
  assert.throws(() => store.actorCredentials(wide, 'b'.repeat(64), { ...renewal, agent_id: 'missing-agent' }, secret), /does not exist/);
  assert.throws(() => store.actorCredentials({ ...wide, scopes: ['admin:agents'] }, 'b'.repeat(64), renewal, secret), /does not hold/);
  assert.deepEqual(store.snapshot(), before);
  store.actorCredentials(wide, 'c'.repeat(64), { ...policy, action: 'disable' }, secret);
  assert.throws(() => store.actorCredentials(wide, 'd'.repeat(64), renewal, secret), /Disabled agents cannot renew/);
});
test('a credential in its grace period refreshes only into the same, expiring generation', async () => {
  const store = new InMemoryHiveMemStore(), policy = body();
  const first = store.actorCredentials(owner, 'a'.repeat(64), policy, secret);
  store.actorCredentials(owner, 'b'.repeat(64), { ...policy, action: 'renew', grace_seconds: 60, expires_at: new Date(Date.now() + 48 * 3600_000).toISOString() }, secret);
  const server = createServer(createHiveMemHandler({ store, jwtSecret: secret })).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/auth/refresh`, { method: 'POST', headers: { Authorization: 'Bearer ' + first.token } });
    assert.equal(response.status, 200);
    const refreshed = verifyBearerToken('Bearer ' + (await response.json() as { token: string }).token, secret);
    assert.equal(refreshed.rawClaims.token_generation, verifyBearerToken('Bearer ' + first.token, secret).rawClaims.token_generation);
    const realNow = Date.now;
    try { Date.now = () => realNow() + 61_000; assert.throws(() => store.assertCredentialActive(refreshed), /rotated/); } finally { Date.now = realNow; }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('capabilities advertise credential renewal', () => {
  assert.equal(new InMemoryHiveMemStore().capabilities().actor_credential_renewal, 'renew-grace-v1');
});
test('in a recorded workspace, renewal follows current membership and stops for a removed member', () => {
  const store = new InMemoryHiveMemStore();
  const service: AuthPrincipal = { agentId: 'fixture-fleet', scopes: ['admin:agents', 'workspaces:write', 'memories:read', 'memories:write'], rawClaims: { role: 'agent' } };
  store.createWorkspace(service, { workspace_id: 'fixture-agents', title: 'Fixture agents' });
  const policy = { ...body(), workspace_id: 'fixture-agents', scopes: ['memories:read', 'memories:write'] };
  store.actorCredentials(service, 'a'.repeat(64), policy, secret);
  const renewal = { ...policy, action: 'renew', expires_at: new Date(Date.now() + 700 * 3600_000).toISOString() };
  assert.equal(typeof store.actorCredentials(service, 'b'.repeat(64), renewal, secret).token, 'string');
  store.removeWorkspaceMember(service, 'fixture-agents', policy.agent_id);
  assert.throws(() => store.actorCredentials(service, 'c'.repeat(64), renewal, secret), /Only a member/);
});
