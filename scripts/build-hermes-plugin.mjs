#!/usr/bin/env node
// Product-owned public plugin snapshot. Runtime profiles are never build inputs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = ['__init__.py', 'cli.py', 'plugin.yaml'];
export function buildHermesPlugin({ output, revision }) {
  if (!output || !/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('Select --output NEW_DIRECTORY --revision FULL_REVIEWED_REVISION');
  const git = args => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { maxBuffer: 4 * 1024 * 1024 });
  if (git(['rev-parse', revision + '^{commit}']).toString().trim() !== revision) throw Error('Exact reviewed source revision is required');
  const destination = resolve(output);
  if (existsSync(destination)) throw Error('Preserve existing artifacts and select a new output directory');
  const source = file => git(['show', revision + ':' + file]);
  const manifest = source('hermes-plugin/plugins/memory/hivemem/plugin.yaml').toString();
  const version = manifest.match(/^version: (\d+\.\d+\.\d+)$/m)?.[1];
  if (!version || !/^name: hivemem$/m.test(manifest)) throw Error('Reviewed plugin identity is missing');
  const scratch = mkdtempSync(join(tmpdir(), 'hivemem-public-plugin-'));
  try {
    mkdirSync(destination, { mode: 0o700 });
    mkdirSync(join(scratch, 'hivemem'), { mode: 0o700 });
    const files = [];
    for (const name of runtime) {
      const bytes = source('hermes-plugin/plugins/memory/hivemem/' + name);
      writeFileSync(join(scratch, 'hivemem', name), bytes, { mode: 0o600 });
      files.push({ path: 'hivemem/' + name, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    for (const name of ['LICENSE', 'NOTICE', 'provenance.json']) writeFileSync(join(scratch, name), source(name), { mode: 0o600 });
    const archive = `hivemem-hermes-plugin-${version}.tar.gz`;
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(destination, archive), '-C', scratch, '.']);
    chmodSync(join(destination, archive), 0o600);
    const descriptor = { schema: 1, product: 'hivemem-hermes-plugin', version, revision, archive,
      sha256: createHash('sha256').update(readFileSync(join(destination, archive))).digest('hex'),
      directory: 'hivemem', files, license: 'Apache-2.0', published: false };
    writeFileSync(join(destination, 'artifact.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
    return descriptor;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!['--output', '--revision'].includes(key) || !value || options[key.slice(2)]) throw Error('Select --output NEW_DIRECTORY --revision FULL_REVIEWED_REVISION');
      options[key.slice(2)] = value;
    }
    console.log(JSON.stringify(buildHermesPlugin(options)));
  } catch { console.error('Public HiveMem plugin artifact build failed; preserve existing artifacts and inspect protected diagnostics'); process.exitCode = 1; }
}
