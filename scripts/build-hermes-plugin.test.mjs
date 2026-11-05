import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHermesPlugin } from './build-hermes-plugin.mjs';

test('plugin artifact is an allowlisted immutable snapshot with attribution and no profile inputs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plugin-release-test-'));
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const profile = join(scratch, 'profile'); mkdirSync(profile);writeFileSync(join(profile, '.env'), 'NEVER_PACK=obviously-fake-fixture');
    const first = buildHermesPlugin({ output: join(scratch, 'one'), revision });
    const second = buildHermesPlugin({ output: join(scratch, 'two'), revision });
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.product, 'hivemem-hermes-plugin');
    assert.equal(first.revision, revision);
    const archive = join(scratch, 'one', first.archive);
    assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), first.sha256);
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listing, ['./', './LICENSE', './NOTICE', './hivemem/', './hivemem/__init__.py', './hivemem/cli.py', './hivemem/plugin.yaml', './provenance.json'].sort());
    assert(execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n').every(line => ['-', 'd'].includes(line[0])));
    assert.throws(() => buildHermesPlugin({ output: join(scratch, 'one'), revision }), /Preserve/);
    assert.throws(() => buildHermesPlugin({ output: join(scratch, 'bad'), revision: 'HEAD' }), /FULL_REVIEWED/);
    assert.equal(existsSync(join(scratch, 'bad')), false);
    assert.equal(readFileSync(join(profile, '.env'), 'utf8'), 'NEVER_PACK=obviously-fake-fixture');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
