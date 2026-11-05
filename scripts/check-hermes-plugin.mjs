#!/usr/bin/env node
// Actual public Hermes discovery and native CLI against a disposable HiveMem API.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer, request as httpsRequest } from 'node:https';
import { createHiveMemHandler } from '../ts-core/dist/src/server.js';
import { InMemoryHiveMemStore } from '../ts-core/dist/src/store.js';
import { signToken } from '../ts-core/dist/src/auth.js';
const exec = promisify(execFile);
const run = async (command, args, options = {}) => (await exec(command, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout.trim();
const option = name => { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1], name + ' is required'); return resolve(process.argv[index + 1]); };
const nativeFile = option('--hermes-artifact'), pluginFile = option('--plugin-artifact');
const native = JSON.parse(await readFile(nativeFile)), plugin = JSON.parse(await readFile(pluginFile));
assert.equal(native.product, 'hermes-agent'); assert.equal(plugin.product, 'hivemem-hermes-plugin');
const scratch = await mkdtemp(join(tmpdir(), 'hivemem-public-hermes-proof-'));
let server;
try {
  const home = join(scratch, 'home'), profile = join(scratch, 'profile'), runtime = join(scratch, 'runtime'), plugins = join(scratch, 'plugin');
  for (const path of [home, profile, runtime, plugins]) await mkdir(path, { mode: 0o700 });
  const unpack = async (descriptor, file, target) => {
    assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
    const archive = join(dirname(file), descriptor.archive);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), descriptor.sha256);
    assert((await run('tar', ['-tzf', archive])).split('\n').every(name => !name.startsWith('/') && !name.includes('..') && !name.includes('\\') && !/\.(gguf|ggml|safetensors)$/i.test(name)));
    assert((await run('tar', ['-tvzf', archive])).split('\n').every(line => ['-', 'd'].includes(line[0])));
    await run('tar', ['-xzf', archive, '-C', target, '--no-same-owner', '--no-same-permissions']);
  };
  await unpack(native, nativeFile, runtime); await unpack(plugin, pluginFile, plugins);
  for (const file of plugin.files) assert.equal(createHash('sha256').update(await readFile(join(plugins, file.path))).digest('hex'), file.sha256);
  await mkdir(join(profile, 'plugins'), { mode: 0o700 });
  await cp(join(plugins, 'hivemem'), join(profile, 'plugins/hivemem'), { recursive: true, errorOnExist: true, force: false });
  const ca = join(scratch, 'ca.pem'), caKey = join(scratch, 'ca.key'), certificate = join(scratch, 'server.pem'), key = join(scratch, 'server.key'), csr = join(scratch, 'server.csr'), extensions = join(scratch, 'extensions');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-subj', '/CN=Synthetic plugin authority', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-days', '1']);
  await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=IP:127.0.0.1\n', { mode: 0o600 });
  await run('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-set_serial', '12345', '-out', certificate, '-days', '1', '-extfile', extensions]);
  const secret = randomBytes(48).toString('base64url'), store = new InMemoryHiveMemStore();
  const handler = createHiveMemHandler({ store, jwtSecret: secret });
  let prefixedCalls = 0;
  server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    if (request.url?.startsWith('/memory/')) { prefixedCalls++; request.url = request.url.slice('/memory'.length); }
    return handler(request, response);
  }).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const origin = 'https://127.0.0.1:' + server.address().port, authority = await readFile(ca);
  const admin = signToken(secret, { sub: 'synthetic-operator', role: 'admin', scope: 'admin:all', exp: Math.floor(Date.now() / 1000) + 600 });
  const call = (path, body, token = admin) => new Promise((done, reject) => {
    const request = httpsRequest(origin + path, { method: body ? 'POST' : 'GET', ca: authority, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, response => {
      const chunks = []; response.on('data', part => chunks.push(part)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); done({ status: response.statusCode, body: text ? JSON.parse(text) : null }); });
    }); request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
  });
  const agent = 'synthetic-native-hermes', workspace = 'synthetic-plugin-workspace';
  assert.equal((await call('/v1/workspaces', { workspace_id: workspace, title: 'Synthetic plugin workspace', members: [{ agent_id: agent, role: 'member' }] })).status, 201);
  const enrollment = await call('/v1/agents/register', { agent_id: agent, display_name: 'Synthetic native Hermes', token_scopes: ['memories:read', 'memories:write'], workspace_ids: [workspace], expires_hours: 1 });
  assert.equal(enrollment.status, 201);
  const token = enrollment.body.token, claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.equal(claims.role, 'agent'); assert.deepEqual(claims.workspace_ids, [workspace]); assert(!claims.scope.includes('admin:') && !claims.scope.includes('*'));
  const envFile = join(scratch, 'native.env'), config = 'memory:\n  provider: hivemem\n';
  const values = { HERMES_HIVEMEM_API_URL: origin + '/memory', HERMES_HIVEMEM_TOKEN: token, HERMES_HIVEMEM_CA_FILE: ca, HERMES_HIVEMEM_WORKSPACE_ID: workspace };
  await writeFile(envFile, Object.entries(values).map(([name, value]) => name + '=' + value).join('\n') + '\n', { mode: 0o600 });
  await writeFile(join(profile, 'config.yaml'), config, { mode: 0o600 });
  await writeFile(join(profile, 'hivemem.json'), JSON.stringify({ enabled: true, workspace_id: workspace, capture_turns: false, recall_mode: 'tools' }), { mode: 0o600 });
  const original = await readFile(envFile), env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
  const executable = join(runtime, native.executable), args = ['--env-file', envFile, '--profile-path', profile];
  await run(executable, [...args, '--native-init-profile'], { env });
  const python = join(runtime, 'app/python', 'cpython-3.13.13-linux-' + ({ amd64: 'x86_64', arm64: 'aarch64' }[native.architecture]) + '-gnu/bin/python3.13');
  const discovery = join(scratch, 'registration.py');
  await writeFile(discovery, `import sys, site, json\nfrom pathlib import Path\napp=Path(sys.argv[1])\nsite.addsitedir(str(app/'dependencies'))\nsys.path.insert(0,str(app/'source'))\nfrom plugins.memory import load_memory_provider\nfrom agent.memory_provider import MemoryProvider\nprovider=load_memory_provider('hivemem')\nassert isinstance(provider,MemoryProvider)\nassert provider.is_available()\nprovider.initialize('synthetic-registration',hermes_home=sys.argv[2],platform='cli')\nassert provider.name=='hivemem' and provider.get_tool_schemas()\nprovider.shutdown()\nprint(json.dumps({'registered':True}))\n`, { mode: 0o600 });
  const registered = await run(python, ['-I', '-B', discovery, join(runtime, 'app'), profile], { env: { ...env, ...values, HERMES_HOME: profile, HERMES_MANAGED: 'magnus', HERMES_DISABLE_LAZY_INSTALLS: '1' } });
  assert.equal(JSON.parse(registered).registered, true);
  const result = await run(executable, [...args, 'hivemem', 'test', '--write-check'], { env });
  assert(result.includes('disposable write/search/delete check... OK'));
  assert(prefixedCalls >= 4, 'The native client must use the explicitly selected ingress prefix');
  const memories = store.snapshot().memories.filter(memory => memory.agent_id === agent);
  assert.equal(memories.length, 1); assert.equal(memories[0].workspace_id, workspace); assert(memories[0].deleted_at);
  assert.equal((await call('/v1/agents/register', { agent_id: 'forbidden', display_name: 'Forbidden' }, token)).status, 403);
  assert.equal((await call('/v1/memories', { content: 'Forbidden workspace', type: 'semantic', scope: 'private', workspace_id: 'default' }, token)).status, 403);
  await assert.rejects(run(executable, [...args, 'hivemem', 'test', '--write-check'], { env: { ...env, HERMES_HIVEMEM_TOKEN: 'obviously-fake-invalid-token' } }));
  await assert.rejects(run(executable, [...args, 'hivemem', 'test', '--write-check'], { env: { ...env, HERMES_HIVEMEM_CA_FILE: join(runtime, 'MAGNUS-LICENSE') } }));
  assert.deepEqual(await readFile(envFile), original); assert.equal(await readFile(join(profile, 'config.yaml'), 'utf8'), config);
  console.log(JSON.stringify({ ok: true, nativeVersion: native.version, pluginVersion: plugin.version, pluginSHA256: plugin.sha256,
    actualNativeCLI: true, nativeProviderRegistration: true, explicitIngressPrefix: true, scopedIdentity: true, workspaceIsolation: true, verifiedHTTPS: true, writeSearchDelete: true, invalidCredentialAndTrustRefused: true,
    originalProfileBytesRetained: true, productionCutover: false }));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await rm(scratch, { recursive: true, force: true });
}
