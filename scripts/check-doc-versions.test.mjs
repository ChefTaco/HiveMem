import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { currentVersions, staleReferences } from './check-doc-versions.mjs';

const versions = { server: '1.10.0', sdk: '1.3.0' };

test('only references to the current server image and SDK version pass', () => {
  assert.deepEqual(staleReferences('docker run ghcr.io/cheftaco/hivemem:1.10.0 check\nnpm i @hivemagnus/hivemem-sdk@1.3.0', versions), []);
  assert.deepEqual(staleReferences('a\nghcr.io/cheftaco/hivemem:1.9.1\n@hivemagnus/hivemem-sdk@1.2.1', versions), [
    '2: ghcr.io/cheftaco/hivemem:1.9.1 (current server 1.10.0)',
    '3: @hivemagnus/hivemem-sdk@1.2.1 (current sdk 1.3.0)',
  ]);
  // The legacy npm server package and other products' versions are not HiveMem release claims.
  assert.deepEqual(staleReferences('@hivemagnus/hivemem-server@1.2.2 and qdrant:v1.18.1', versions), []);
});

test('the repository documents name only current versions', () => {
  assert.equal(typeof currentVersions().server, 'string');
  execFileSync(process.execPath, [new URL('./check-doc-versions.mjs', import.meta.url).pathname], { stdio: 'pipe' });
});
