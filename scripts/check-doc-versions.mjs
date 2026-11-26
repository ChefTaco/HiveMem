// Fails when a tracked document names a HiveMem release other than the current one, so version
// claims cannot go stale silently. Release history (CHANGELOG.md) is exempt.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

/** Version references a document may make, each tied to the package that owns the version. */
export const patterns = [
  { owner: 'server', pattern: /ghcr\.io\/cheftaco\/hivemem:v?(\d+\.\d+\.\d+)/g },
  { owner: 'sdk', pattern: /@hivemagnus\/hivemem-sdk@(\d+\.\d+\.\d+)/g },
];

/** Every stale version reference in `text`, as `line: found (current)` strings. */
export function staleReferences(text, versions) {
  const problems = [];
  const lines = text.split('\n');
  for (const { owner, pattern } of patterns) {
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        if (match[1] !== versions[owner]) problems.push(`${index + 1}: ${match[0]} (current ${owner} ${versions[owner]})`);
      }
    });
  }
  return problems;
}

export function currentVersions() {
  return {
    server: JSON.parse(read('ts-core/package.json')).version,
    sdk: JSON.parse(read('sdks/typescript/package.json')).version,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = execFileSync('git', ['ls-files', '*.md', 'docs/*.json'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((path) => path && !/(^|\/)CHANGELOG\.md$/.test(path));
  const versions = currentVersions();
  const problems = files.flatMap((path) => staleReferences(read(path), versions).map((problem) => `${path}:${problem}`));
  if (problems.length) {
    console.error('Stale HiveMem version references (update them, or name no version):\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log(`Document version references match server ${versions.server} and SDK ${versions.sdk}`);
}
