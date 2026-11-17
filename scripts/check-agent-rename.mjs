// rename-agent against a real Qdrant and the real native CLI, with disposable resources only:
// an old subject owns data, the rename is refused while HiveMem runs and while the target owns
// data, then moves everything (private collections with their vectors), is idempotent, and the
// new subject can do what the old one could while the old one is refused.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer as tcpServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {signToken} from '../ts-core/dist/src/auth.js';

if (process.env.HIVEMEM_RENAME_TEST_CONFIRM !== 'isolated-synthetic-installation')
  throw Error('Set HIVEMEM_RENAME_TEST_CONFIRM=isolated-synthetic-installation for new disposable resources');
const OLD = 'hive-router', NEW = 'emberpath';
const root = resolve(import.meta.dirname, '..'), state = mkdtempSync(join(tmpdir(), 'hivemem-agent-rename-'));
const container = 'hivemem-rename-test-' + randomUUID();
const qdrantImage = process.env.HIVEMEM_RENAME_TEST_QDRANT_IMAGE ?? 'qdrant/qdrant:v1.18.1';
let child, created = false;
const docker = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const signing = randomBytes(48).toString('hex'), qdrantKey = randomBytes(32).toString('hex');
try {
  try { docker(['image', 'inspect', qdrantImage]); } catch { docker(['pull', qdrantImage]); }
  const image = JSON.parse(docker(['image', 'inspect', qdrantImage]))[0].Id;
  const qdrantEnv = join(state, 'qdrant.env'); writeFileSync(qdrantEnv, `QDRANT__SERVICE__API_KEY=${qdrantKey}\n`, {mode: 0o600});
  docker(['run', '-d', '--name', container, '--env-file', qdrantEnv, '-p', '127.0.0.1::6333', image]); created = true;
  const port = JSON.parse(docker(['inspect', container]))[0].NetworkSettings.Ports['6333/tcp'][0].HostPort;
  const qdrant = `http://127.0.0.1:${port}`;
  const q = async (path, method = 'GET', body) => {
    const response = await fetch(qdrant + path, {method, headers: {'api-key': qdrantKey, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    assert(response.ok || response.status === 404, `Qdrant ${method} ${path}: ${response.status}`);
    return response.status === 404 ? null : response.json();
  };
  await eventually(async () => (await fetch(qdrant + '/collections', {headers: {'api-key': qdrantKey}})).ok);
  const reservation = tcpServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const apiPort = reservation.address().port; await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${apiPort}`;
  const env = {PATH: process.env.PATH, HOME: state, LANG: 'C.UTF-8', HIVEMEM_JWT_SECRET: signing,
    HIVEMEM_STORAGE_PATH: join(state, 'memory'), HIVEMEM_QDRANT_URL: qdrant, QDRANT_API_KEY: qdrantKey,
    HIVEMEM_TS_CORE_HOST: '127.0.0.1', HIVEMEM_TS_CORE_PORT: String(apiPort), HIVEMEM_TS_PERSISTENCE: 'qdrant',
    HIVEMEM_WORKER_ENABLED: 'false', HIVEMEM_UPDATE_CHECK: 'false'};
  const cli = (...args) => spawnSync(process.execPath, ['ts-core/dist/src/cli.js', ...args], {cwd: root, env, encoding: 'utf8', timeout: 60000});
  const rename = (...args) => { const result = cli('rename-agent', '--from', OLD, '--to', NEW, '--json', ...args); return {status: result.status, stderr: result.stderr, report: result.stdout.trim() ? JSON.parse(result.stdout) : null}; };
  execFileSync(process.execPath, ['ts-core/dist/src/cli.js', 'migrate', '--backup-dir', join(state, 'backup')], {cwd: root, env, stdio: 'pipe', timeout: 30000});
  function start() {
    child = spawn(process.execPath, ['ts-core/dist/src/cli.js', 'start'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const log = join(state, 'native.log');
    child.stdout.on('data', chunk => appendFileSync(log, chunk, {mode: 0o600}));
    child.stderr.on('data', chunk => appendFileSync(log, chunk, {mode: 0o600}));
  }
  const token = sub => signToken(signing, {sub, role: 'admin', scope: 'admin:all', exp: Math.floor(Date.now() / 1000) + 600});
  async function request(path, bearer, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, {method, headers: {authorization: 'Bearer ' + bearer, 'content-type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10000)});
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  // 1. The old subject owns one of everything.
  start(); await eventually(async () => (await fetch(origin + '/v1/health/live')).ok);
  const old = token(OLD);
  await request('/v1/workspaces', old, 'POST', {workspace_id: 'ops', title: 'Synthetic ops workspace'}, 201);
  const privateMemory = await request('/v1/memories', old, 'POST', {content: 'Synthetic private semantic note.', type: 'semantic', scope: 'private'}, 201);
  const procedural = await request('/v1/memories', old, 'POST', {content: 'Synthetic private procedure.', type: 'procedural', scope: 'private'}, 201);
  const shared = await request('/v1/memories', old, 'POST', {content: 'Synthetic shared episode.', type: 'episodic', scope: 'shared'}, 201);
  const session = await request('/v1/sessions', old, 'POST', {title: 'Synthetic private session', scope: 'private'}, 201);
  const episode = await request('/v1/episodes', old, 'POST', {title: 'Synthetic episode'}, 201);
  await request(`/v1/episodes/${episode.episode_id}/messages`, old, 'POST', {role: 'assistant', content: 'Synthetic message.'}, 201);
  const webhook = await request('/v1/webhooks', old, 'POST', {url: 'https://hooks.example.com/hivemem', event_types: ['memory.created']}, 201);
  // A semantic shadow collection carries owners in its payloads.
  await q('/collections/hivemem_shadow_rename_test', 'PUT', {vectors: {size: 4, distance: 'Cosine'}});
  await q('/collections/hivemem_shadow_rename_test/points?wait=true', 'PUT', {points: [
    {id: randomUUID(), vector: [1, 0, 0, 0], payload: {memory_id: privateMemory.id, agent_id: OLD, scope: 'private'}},
    {id: randomUUID(), vector: [0, 1, 0, 0], payload: {memory_id: 'other', agent_id: 'hermes', scope: 'private'}}]});
  const vectorOf = async (collection, id) => (await q(`/collections/${collection}/points/scroll`, 'POST', {limit: 10, with_vector: true, with_payload: true, filter: {must: [{key: 'id', match: {value: id}}]}})).result.points[0]?.vector;
  const originalVector = await vectorOf(`${OLD}_private_semantic`, privateMemory.id);
  assert(Array.isArray(originalVector) && originalVector.length === 768, 'the private memory has a stored vector');

  // 2. Read-only modes work while HiveMem runs; the rename itself is refused.
  const dry = rename('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.report.status, 'would-rename');
  assert.equal(dry.report.plan.source.memories, 3);
  assert.equal(dry.report.plan.source.sessions, 1);
  assert.equal(dry.report.plan.source.webhooks, 1);
  assert.equal(rename('--verify').status, 2, 'pending while OLD owns data');
  const running = rename();
  assert.equal(running.status, 1);
  assert.match(running.stderr, /stop HiveMem before renaming/);

  // 3. A target that already owns data is refused without a write, then merged on approval.
  const preexisting = await request('/v1/memories', token(NEW), 'POST', {content: 'Synthetic note the target already owns.', type: 'semantic', scope: 'private'}, 201);
  await stopChild();
  const refused = rename();
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(refused.report.status, 'conflict');
  assert.equal(rename('--verify').status, 2, 'a refused rename wrote nothing');
  const applied = rename('--allow-existing-target');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.report.status, 'renamed');
  assert.equal(applied.report.verified, true);
  assert.deepEqual(applied.report.shadowPayloadsUpdated, {hivemem_shadow_rename_test: 1});

  // 4. Qdrant: the old collections are gone, the private memories moved with their vectors.
  const names = (await q('/collections')).result.collections.map(entry => entry.name);
  assert.equal(names.some(name => name.startsWith(`${OLD}_private_`)), false, names.join(','));
  assert.deepEqual(await vectorOf(`${NEW}_private_semantic`, privateMemory.id), originalVector);
  assert.equal((await q('/collections/hivemem_shadow_rename_test/points/count', 'POST', {exact: true, filter: {must: [{key: 'agent_id', match: {value: OLD}}]}})).result.count, 0);

  // 5. Rerunning is a no-op and verifies.
  const again = rename();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.report.status, 'already-renamed');
  assert.equal(rename('--verify').status, 0);

  // 6. The new subject does everything the old one could; the old one is refused.
  start(); await eventually(async () => (await fetch(origin + '/v1/health/live')).ok);
  const ember = token(NEW);
  await request('/v1/memories/' + privateMemory.id, old, 'GET', undefined, 403);
  assert.equal((await request('/v1/memories/' + privateMemory.id, ember, 'PUT', {content: 'Edited by the renamed owner.'})).content, 'Edited by the renamed owner.');
  await request('/v1/memories/' + shared.id, ember, 'PUT', {importance: 0.9});
  await request('/v1/memories/' + procedural.id, ember, 'DELETE', undefined, 204);
  assert((await request('/v1/memories/' + preexisting.id, ember)).id === preexisting.id);
  const sessions = await request('/v1/sessions', ember);
  assert((sessions.sessions ?? sessions).some(entry => entry.session_id === session.session_id), 'the private session is listed for the new owner');
  assert.equal((await request(`/v1/episodes/${episode.episode_id}`, ember)).messages.length, 1);
  const hooks = await request('/v1/webhooks', ember);
  assert((hooks.webhooks ?? hooks).some(entry => entry.id === webhook.id));
  const agents = await request('/v1/agents', ember);
  const listed = agents.agents ?? agents;
  assert.equal(listed.find(entry => entry.agent_id === OLD)?.active, false, 'the old ID keeps a disabled record');
  await stopChild();
  console.log(JSON.stringify({agentRename: 'passed', actualNativeCli: true, actualQdrant: true, qdrantImage: image,
    refusedWhileRunning: true, refusedExistingTarget: true, mergedOnApproval: true, vectorsPreserved: true,
    oldCollectionsRemoved: true, shadowPayloadsMoved: true, idempotent: true, newOwnerAuthorized: true, oldSubjectRefused: true}));
} finally {
  await stopChild();
  if (created) docker(['rm', '-f', container]);
  rmSync(state, {recursive: true, force: true});
}

async function eventually(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {try {if (await check()) return;} catch {} await delay(200);}
  throw Error('Disposable rename acceptance did not complete within its deadline');
}

async function stopChild() {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  let forced = false;
  const exited = once(current, 'exit'), timer = setTimeout(() => {forced = true; current.kill('SIGKILL');}, 10000);
  current.kill('SIGTERM');
  try {await exited;} finally {clearTimeout(timer);}
  assert(!forced, 'HiveMem must stop gracefully');
}
