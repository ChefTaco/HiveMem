import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('browser export binds reviewed committed bytes and attribution, refuses overwrites and non-exact revisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemem-browser-export-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'docs'));
    copyFileSync(new URL('./export-browser-contract.mjs', import.meta.url), join(root, 'scripts/export-browser-contract.mjs'));
    const bytes = JSON.stringify({ openapi: '3.1.0', components: { schemas: { MemoryRecord: { type: 'object' } } } }) + '\n';
    writeFileSync(join(root, 'docs/openapi.json'), bytes);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    writeFileSync(join(root, 'LICENSE'), 'Apache-2.0 synthetic fixture\n');
    writeFileSync(join(root, 'NOTICE'), 'Synthetic source attribution\n');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Contract Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'test: synthetic contract');
    const revision = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'docs/openapi.json'), 'unreviewed working-tree change');
    const output = join(root, 'artifact');
    const run = selected => spawnSync(process.execPath, [join(root, 'scripts/export-browser-contract.mjs'), '--revision', selected, '--output', output], { encoding: 'utf8' });
    assert.equal(run('HEAD').status, 1);
    assert.equal(run(revision).status, 0);
    assert.equal(readFileSync(join(output, 'hivemem.openapi.json'), 'utf8'), bytes);
    const provenance = JSON.parse(readFileSync(join(output, 'hivemem.provenance.json')));
    assert.equal(provenance.revision, revision);
    assert.equal(provenance.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(provenance.productVersion, '0.0.1');
    assert.equal(readFileSync(join(output, 'NOTICE'), 'utf8'), 'Synthetic source attribution\n');
    assert.equal(run(revision).status, 1);
    assert.equal(readFileSync(join(output, 'hivemem.openapi.json'), 'utf8'), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
