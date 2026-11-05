// Developer-owned disposable resources only; no existing API, database or webhook is selected.
import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {createServer as tcpServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {signToken} from '../ts-core/dist/src/auth.js';

if (process.env.HIVEMEM_WEBHOOK_TEST_CONFIRM !== 'isolated-synthetic-installation')
  throw Error('Set HIVEMEM_WEBHOOK_TEST_CONFIRM=isolated-synthetic-installation for new disposable resources');
const root = resolve(import.meta.dirname, '..'), state = mkdtempSync(join(tmpdir(), 'hivemem-webhook-worker-'));
const container = 'hivemem-webhook-test-' + randomUUID();
let child, receiver, created = false;
const docker = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const secret = randomBytes(32).toString('hex'), signing = randomBytes(48).toString('hex'), qdrantKey = randomBytes(32).toString('hex');
const received = [];
let receiverStatus = 202;
try {
  const image = JSON.parse(docker(['image', 'inspect', 'qdrant/qdrant:v1.18.1']))[0].Id;
  const cert = join(state, 'receiver.crt'), key = join(state, 'receiver.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], {stdio: 'pipe'});
  receiver = createServer({key: readFileSync(key), cert: readFileSync(cert)}, async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/events');
      let raw = ''; for await (const chunk of request) {raw += chunk; assert(raw.length < 10000);}
      const timestamp = request.headers['x-hivemem-timestamp'], nonce = request.headers['x-hivemem-nonce'];
      assert(Math.abs(Date.now() / 1000 - Number(timestamp)) < 15);
      assert.equal(request.headers['x-hivemem-signature'], 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${nonce}.${raw}`).digest('hex'));
      const payload = JSON.parse(raw); assert.equal(typeof payload.event_id, 'string');
      assert(['webhook.test', 'memory.created'].includes(payload.event_type));
      received.push({eventId: payload.event_id, nonce});
      response.writeHead(receiverStatus); response.end('Synthetic receiver');
    } catch {response.writeHead(400); response.end();}
  });
  receiver.listen(0); await once(receiver, 'listening');
  const destination = `https://localhost:${receiver.address().port}/events`;
  const qdrantEnv = join(state, 'qdrant.env'); writeFileSync(qdrantEnv, `QDRANT__SERVICE__API_KEY=${qdrantKey}\n`, {mode: 0o600});
  docker(['run', '-d', '--name', container, '--env-file', qdrantEnv, '-p', '127.0.0.1::6333', image]); created = true;
  const port = JSON.parse(docker(['inspect', container]))[0].NetworkSettings.Ports['6333/tcp'][0].HostPort;
  const qdrant = `http://127.0.0.1:${port}`;
  await eventually(async () => (await fetch(qdrant + '/collections', {headers: {'api-key': qdrantKey}})).ok);
  const reservation = tcpServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const apiPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${apiPort}`;
  const env = {PATH: process.env.PATH, HOME: state, LANG: 'C.UTF-8', HIVEMEM_JWT_SECRET: signing,
    HIVEMEM_STORAGE_PATH: join(state, 'memory'), HIVEMEM_QDRANT_URL: qdrant, QDRANT_API_KEY: qdrantKey,
    HIVEMEM_TS_CORE_HOST: '127.0.0.1', HIVEMEM_TS_CORE_PORT: String(apiPort), HIVEMEM_TS_PERSISTENCE: 'qdrant',
    HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS: 'localhost', HIVEMEM_WEBHOOK_CA_FILE: cert,
    HIVEMEM_WORKER_ENABLED: 'true', HIVEMEM_CONSOLIDATION_INTERVAL_SECONDS: '0'};
  execFileSync(process.execPath, ['ts-core/dist/src/cli.js', 'migrate', '--backup-dir', join(state, 'backup')], {
    cwd: root, env, stdio: 'pipe', timeout: 30000,
  });
  function start() {
    child = spawn(process.execPath, ['ts-core/dist/src/cli.js', 'start'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const log = join(state, 'native.log');
    child.stdout.on('data', chunk => appendFileSync(log, chunk, {mode: 0o600}));
    child.stderr.on('data', chunk => appendFileSync(log, chunk, {mode: 0o600}));
  }
  start(); await eventually(async () => (await fetch(origin + '/v1/health/live')).ok);
  const admin = signToken(signing, {sub: 'fixture-bootstrap', role: 'admin', scope: 'admin:all', exp: Math.floor(Date.now()/1000)+300});
  async function request(path, token, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, {method, headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10000)});
    assert.equal(response.status, expected, `${method} ${path}: unexpected response`);
    return response.json();
  }
  await request('/v1/workspaces', admin, 'POST', {workspace_id: 'webhook-test', title: 'Synthetic webhook workspace', members: [{agent_id: 'webhook-agent', role: 'member'}]}, 201);
  const identity = await request('/v1/agents/register', admin, 'POST', {agent_id: 'webhook-agent', display_name: 'Synthetic webhook agent',
    token_scopes: ['webhooks:read', 'webhooks:write', 'memories:write', 'memories:read', 'queue:read'], workspace_ids: ['webhook-test']}, 201);
  const token = identity.token;
  await request('/v1/admin/audit', token, 'GET', undefined, 403);
  const endpoint = await request('/v1/webhooks', token, 'POST', {url: destination, workspace_id: 'webhook-test', event_types: ['memory.created'], secret}, 201);
  assert(!JSON.stringify(endpoint).includes(secret));
  const queued = await request('/v1/webhooks/test', token, 'POST', {workspace_id: 'webhook-test', event_type: 'webhook.test', data: {synthetic: true}}, 202);
  assert.equal(queued.queued_deliveries, 1);
  const deliveryId = queued.delivery_ids[0];
  await eventually(async () => (await request('/v1/webhooks/deliveries/' + deliveryId, token)).status === 'delivered');
  const delivered = await request('/v1/webhooks/deliveries/' + deliveryId, token);
  assert.equal(delivered.response_status, 202); assert.equal(delivered.attempts, 1); assert(delivered.delivered_at);
  assert.equal(received.filter(item => item.eventId === queued.event_id).length, 1);
  await request('/v1/memories', token, 'POST', {workspace_id: 'webhook-test', content: 'Synthetic managed webhook worker acceptance.', type: 'semantic', scope: 'private'}, 201);
  await eventually(async () => (await request('/v1/webhooks/deliveries?workspace_id=webhook-test', token)).deliveries.some(item => item.event_type === 'memory.created' && item.status === 'delivered'));
  await request('/v1/webhooks', token, 'POST', {url: destination, workspace_id: 'default', secret}, 403);
  const beforeRestart = received.length;
  await stopChild(); start(); await eventually(async () => (await fetch(origin + '/v1/health/live')).ok);
  const persisted = await request('/v1/webhooks/deliveries/' + deliveryId, token);
  assert.equal(persisted.status, 'delivered'); assert.equal(persisted.attempts, 1); assert.equal(persisted.response_status, 202);
  await delay(1600); assert.equal(received.length, beforeRestart, 'Completed deliveries must not be re-enqueued on restart');
  receiverStatus = 503;
  const failedEvent = await request('/v1/webhooks/test', token, 'POST', {workspace_id: 'webhook-test', event_type: 'webhook.test', data: {syntheticFailure: true}}, 202);
  await eventually(async () => (await request('/v1/webhooks/deliveries/' + failedEvent.delivery_ids[0], token)).response_status === 503);
  const failed = await request('/v1/webhooks/deliveries/' + failedEvent.delivery_ids[0], token);
  assert.equal(failed.status, 'failed'); assert.equal(failed.delivered_at, null);
  await request('/v1/webhooks/' + endpoint.id, token, 'PUT', {enabled: false});
  const paused = await request('/v1/webhooks/test', token, 'POST', {workspace_id: 'webhook-test', event_type: 'webhook.test', data: {disabled: true}}, 202);
  assert.equal(paused.queued_deliveries, 0);
  await stopChild();
  console.log(JSON.stringify({webhookWorker: 'passed', actualNativeCli: true, actualQdrant: true, qdrantImage: image,
    scopedApiCredential: true, managedBackgroundWorker: true, verifiedHttpsHmac: true, memoryCreatedEvent: true,
    deliveryHistoryAfterRestart: true, completedDeliveryNotReplayed: true, httpFailureRecorded: true,
    disabledEndpointNotQueued: true, secretExcludedFromApi: true, existingResourcesSelected: false}));
} finally {
  await stopChild();
  if (receiver) {receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve));}
  if (created) docker(['rm', '-f', container]);
  rmSync(state, {recursive: true, force: true});
}

async function eventually(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {try {if (await check()) return;} catch {} await delay(200);}
  throw Error('Disposable worker acceptance did not complete within its deadline');
}

async function stopChild() {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  let forced = false;
  const exited = once(current, 'exit'), timer = setTimeout(() => {forced = true; current.kill('SIGKILL');}, 10000);
  current.kill('SIGTERM');
  try {await exited;} finally {clearTimeout(timer);}
  assert(!forced, 'Native worker must stop gracefully');
}
