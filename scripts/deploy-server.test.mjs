import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageNodeRange } from './check-node-runtime.mjs';

const script = new URL('./deploy_server.sh', import.meta.url);

test('deploy_server.sh parses as bash', () => {
  const child = spawnSync('bash', ['-n', script.pathname], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

// The server reads neither a CORS allowlist nor a local model file
// (`hivemem-server env-schema`), so the deploy script must not stage either.
test('deploy_server.sh has no CORS or model-file settings', () => {
  const source = readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /CORS/i);
  assert.doesNotMatch(source, /EMBEDDING_MODEL|gguf|\/models\b/i);
});

const stub = (path, body) => writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });

/** Runs a full deployment against stubbed ssh/scp/rsync and returns everything sent to the target. */
function deploy(preserveRemoteEnv) {
  const temporary = mkdtempSync(join(tmpdir(), 'hivemem-deploy-'));
  try {
    const root = join(temporary, 'product'), bin = join(temporary, 'bin'), log = join(temporary, 'remote.log');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'ts-core'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(root, 'ts-core/package.json'), JSON.stringify({ engines: { node: packageNodeRange() } }));
    for (const name of ['deploy_server.sh', 'check-node-runtime.mjs']) copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name));
    // Legacy settings an older env file may still carry; none of them may reach the target.
    writeFileSync(join(root, '.env'), [
      'SSH_HOST=node.example.com', 'SSH_USERNAME=deploy', `HIVEMEM_JWT_SECRET=${'ab'.repeat(32)}`,
      'HIVEMEM_CORS_ORIGINS=https://console.example.com',
      'HIVEMEM_EMBEDDING_MODEL_PATH=/srv/models/embed.gguf', 'HIVEMEM_EMBEDDING_MODEL_SOURCE=/srv/shared/embed.gguf', '',
    ].join('\n'));
    stub(join(bin, 'ssh'), [
      'printf "SSH %s\\n" "$*" >> "$DEPLOY_LOG"', 'cat >> "$DEPLOY_LOG"',
      'case "$*" in',
      '  *"hostname -I"*) echo 192.0.2.10 ;;',
      '  *curl*) echo \'{"status":"ok"}\' ;;',
      '  *"test -f \'/opt/hive-router"*) exit 1 ;;',
      'esac', 'exit 0', '',
    ].join('\n'));
    stub(join(bin, 'scp'), 'printf "SCP %s\\n" "$*" >> "$DEPLOY_LOG"\n');
    stub(join(bin, 'rsync'), 'printf "RSYNC %s\\n" "$*" >> "$DEPLOY_LOG"\n');
    stub(join(bin, 'ssh-keygen'), 'exit 0\n');
    const child = spawnSync('bash', [join(root, 'scripts', 'deploy_server.sh')], { encoding: 'utf8', input: '', env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: temporary, DEPLOY_LOG: log,
      HIVEMEM_PRESERVE_REMOTE_ENV: String(preserveRemoteEnv), HIVEMEM_REFRESH_ADMIN_TOKEN: 'false',
      HIVEMEM_DEPLOY_CORS_ORIGINS: 'https://console.example.com', HIVEMEM_DEPLOY_API_URL: 'https://memory.example.com',
    } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return readFileSync(log, 'utf8');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

for (const preserveRemoteEnv of [false, true]) {
  test(`a full deployment (${preserveRemoteEnv ? 'preserved' : 'copied'} env) stages no model file and writes no CORS setting`, () => {
    const remote = deploy(preserveRemoteEnv);
    assert.doesNotMatch(remote, /CORS/i);
    assert.doesNotMatch(remote, /EMBEDDING_MODEL|gguf|\/models\b/i);
    // The settings the deployment does own still reach the target env file.
    assert.match(remote, /HIVEMEM_API_URL=https:\/\/memory\.example\.com/);
    assert.match(remote, /HIVEMEM_RUNTIME=typescript/);
    if (!preserveRemoteEnv) assert.match(remote, /HIVEMEM_WEB_PORT=18443/);
    assert.match(remote, /mkdir -p \/var\/opt\/hivemem \/var\/opt\/hivemem\/backups \/var\/opt\/hivemem\/lib \/var\/log\/hivemem && /);
    assert.match(remote, /systemctl restart hivemem/);
  });
}
