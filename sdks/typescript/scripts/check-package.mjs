// Packs the SDK, checks the published file list against an allowlist, installs the tarball
// into a disposable prefix and imports the package by name from the installed copy.
// Run after `npm run build`.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).slice(-2000) || error.message}`));
    else resolvePromise(String(stdout));
  });
});

export const ALLOWED_FILES = [
  /^dist\/[A-Za-z0-9_-]+\.(?:js|d\.ts)$/,
  /^README\.md$/, /^LICENSE$/, /^CHANGELOG\.md$/, /^package\.json$/,
];

export function checkPackedFiles(files, source) {
  const unexpected = files.filter(path => !ALLOWED_FILES.some(pattern => pattern.test(path)));
  if (unexpected.length) throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  const required = ['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'];
  for (const [subpath, entry] of Object.entries(source.exports)) {
    if (subpath === './package.json') continue;
    for (const target of [entry.types, entry.import, entry.default]) if (target) required.push(target.replace(/^\.\//, ''));
  }
  for (const file of required) if (!files.includes(file)) throw new Error(`Packed file missing: ${file}`);
  if (files.length > 64) throw new Error(`Too many packed files (${files.length})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const temporary = await mkdtemp(join(tmpdir(), 'hivemem-sdk-package-check-'));
  try {
    const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent', '--ignore-scripts']));
    const files = listing[0].files.map(file => file.path);
    checkPackedFiles(files, source);

    const filename = (await run('npm', ['pack', '--pack-destination', temporary, '--silent', '--ignore-scripts'])).trim().split('\n').at(-1);
    if (!filename || !/^hivemagnus-hivemem-sdk-[0-9][A-Za-z0-9.-]*\.tgz$/.test(filename)) throw new Error('Pack did not produce the expected tarball');
    const install = join(temporary, 'install');
    await run('npm', ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', '--no-save', '--ignore-scripts',
      join(temporary, filename)], { timeout: 5 * 60_000 });
    const packageDir = join(install, 'node_modules/@hivemagnus/hivemem-sdk');
    if (!(await realpath(packageDir)).startsWith(`${install}/`)) throw new Error('Installed package resolves outside the disposable prefix');
    const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (installed.name !== source.name || installed.version !== source.version) throw new Error('Installed package identity differs');

    // Import through the package name, as a consumer would, so the exports map is exercised.
    const probe = join(install, 'probe.mjs');
    await writeFile(probe, `
      const module = await import('@hivemagnus/hivemem-sdk');
      for (const name of ['HiveMem', 'ContextPackage', 'HiveMemError', 'HiveMemHTTPError', 'verifyHiveMemWebhook']) {
        if (!(name in module)) throw new Error('Missing export ' + name);
      }
      console.log(Object.keys(module).length);
    `);
    const exportsCount = Number((await run(process.execPath, [probe], { cwd: install })).trim());
    console.log(JSON.stringify({ package: filename, files: files.length, version: installed.version, exports: exportsCount }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
