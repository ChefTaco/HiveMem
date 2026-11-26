import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, releaseSchema } from '../src/release/runtime.js';
import { MEMORY_MIGRATIONS, memoryPackageRoot, memoryRelease } from '../src/upgrade.js';
import { createHiveMemServer } from '../src/server.js';

const pkg = JSON.parse(readFileSync(join(memoryPackageRoot, 'package.json'), 'utf8')) as { version: string; hiveRelease?: unknown };

test('the migration release is this package, and its memory schema checksum is unchanged', () => {
  assert.equal(pkg.hiveRelease, undefined, 'package.json carries no frozen bundle manifest');
  const release = releaseSchema.parse(memoryRelease());
  assert.equal(release.version, pkg.version);
  // The checksum every installation recorded under the legacy 1.2.2 manifest: changing it would
  // make migrate treat current data as pending.
  const checksum = hash(JSON.stringify(MEMORY_MIGRATIONS.filter((m) => m.component === 'memory').map((m) => [m.id, m.checksum])));
  assert.equal(checksum, hash(JSON.stringify([['managed-format-1', 'ed0f08de635923fe627dcf5e133555911da81f52157552cf8c0f5035e5b1dac7']])));
  assert.equal(release.dataCompatibility.memory, '^1.0.3');
});

test('health reports this release, not a legacy bundle', async () => {
  const server = createHiveMemServer({ jwtSecret: randomBytes(32).toString('hex') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const body = await (await fetch(`http://127.0.0.1:${address.port}/v1/health`)).json() as { version: string; release: string };
    assert.equal(body.version, pkg.version);
    assert.equal(body.release, pkg.version);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
