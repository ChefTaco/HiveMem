#!/usr/bin/env node
// Export a reviewed immutable public API snapshot, never working-tree state.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--revision' || !/^[a-f0-9]{40}$/.test(args[1]) || args[2] !== '--output')
  throw Error('Select --revision FULL_REVIEWED_REVISION --output NEW_DIRECTORY');
const revision = args[1], output = resolve(args[3]);
const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { maxBuffer: 4 * 1024 * 1024 });
if (git('rev-parse', revision + '^{commit}').toString().trim() !== revision || existsSync(output))
  throw Error('Select an exact reviewed commit and preserve existing artifact directories');
const source = 'docs/openapi.json';
const bytes = git('show', revision + ':' + source);
const spec = JSON.parse(bytes);
if (spec.openapi !== '3.1.0' || !spec.components?.schemas?.MemoryRecord) throw Error('Owned browser contract is missing');
const productVersion = JSON.parse(git('show', revision + ':package.json')).version;
mkdirSync(output, { mode: 0o700 });
writeFileSync(resolve(output, 'hivemem.openapi.json'), bytes, { mode: 0o600 });
writeFileSync(resolve(output, 'hivemem.provenance.json'), JSON.stringify({
  schema: 1, product: 'hivemem', contractVersion: 1, productVersion,
  repository: 'https://github.com/ChefTaco/HiveMem', revision, source,
  sha256: createHash('sha256').update(bytes).digest('hex'), license: 'Apache-2.0',
}, null, 2) + '\n', { mode: 0o600 });
for (const name of ['LICENSE', 'NOTICE']) writeFileSync(resolve(output, name), git('show', revision + ':' + name), { mode: 0o600 });
console.log('Exported immutable HiveMem browser API contract with attribution.');
