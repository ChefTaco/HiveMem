import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { assertPublishEnvironment, checkPublishEnvironment } from '../scripts/check-publish-environment.mjs';
import { assertReleaseRef, publishedVersionExists, publishPackage } from '../scripts/publish-package.mjs';
import { checkPackedFiles } from '../scripts/check-package.mjs';

const protectedEnvironment = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 123 } }] }] };
const sdkManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function releaseFixture(t, manifest = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hivemem-sdk-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@hivemagnus/hivemem-sdk', version: '1.1.0', publishConfig: { access: 'public' }, ...manifest,
  }));
  return root;
}

test('publication requires an actual required reviewer rather than an environment name', () => {
  for (const value of [null, {}, { protection_rules: [] }, { protection_rules: [{ type: 'wait_timer' }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }]) {
    assert.throws(() => assertPublishEnvironment(value), /required reviewer/);
  }
  assert.doesNotThrow(() => assertPublishEnvironment(protectedEnvironment));
});

test('GitHub environment checks fail closed and send the credential only to the API', async () => {
  const env = { GITHUB_REPOSITORY: 'example/hivemem', GH_TOKEN: 'fixture-github-token' };
  await checkPublishEnvironment(env, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/hivemem/environments/npm-publish');
    assert.equal(options.headers.Authorization, 'Bearer fixture-github-token');
    assert.equal(options.redirect, 'error');
    return Response.json(protectedEnvironment);
  });
  await assert.rejects(checkPublishEnvironment(env, async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(checkPublishEnvironment(env, async () => Response.json({ protection_rules: [] })), /required reviewer/);
  await assert.rejects(checkPublishEnvironment({}), /required/);
});

test('only an explicit 404 means a version is absent; other registry failures stop publication', async () => {
  assert.equal(await publishedVersionExists('@example/package', '1.1.0', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40example%2Fpackage/1.1.0');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response('', { status: 404 });
  }), false);
  assert.equal(await publishedVersionExists('@example/package', '1.1.0', async () =>
    Response.json({ name: '@example/package', version: '1.1.0' })), true);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishedVersionExists('@example/package', '1.1.0', async () => new Response('', { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(publishedVersionExists('@example/package', '1.1.0', async () => Response.json({})), /Unexpected npm metadata/);
  await assert.rejects(publishedVersionExists('@example/package', '1.1.0', async () => { throw new Error('connection failed'); }), /connection failed/);
});

test('the workflow publishes the SDK only from sdk-v tags in the protected environment, with OIDC and no stored npm credential', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/publish-sdk.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.on.push, { tags: ['sdk-v*'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['publish']);
  const job = workflow.jobs.publish;
  assert.equal(job.environment, 'npm-publish');
  assert.equal(job.permissions['id-token'], 'write');
  assert.equal(job.defaults.run['working-directory'], 'sdks/typescript');
  assert.equal(job.env.DRY_RUN, 'false');
  const steps = job.steps;
  const index = run => steps.findIndex(step => step.run === run);
  const gates = steps.find(step => step.name === 'Gates').run;
  for (const command of ['npm audit --omit=dev', 'npm run typecheck', 'npm run build', 'npm test',
    'npm pack --dry-run --ignore-scripts', 'npm run pack:check']) {
    assert.ok(gates.split('\n').includes(command), `gate missing: ${command}`);
  }
  const environmentCheck = index('node scripts/check-publish-environment.mjs');
  const tagCheck = index('node scripts/publish-package.mjs --check-tag');
  assert.ok(environmentCheck >= 0 && steps[environmentCheck].if === undefined);
  assert.ok(tagCheck > environmentCheck);
  assert.ok(steps.indexOf(steps.find(step => step.name === 'Gates')) > tagCheck);
  assert.equal(steps.at(-1).run, 'node scripts/publish-package.mjs');
  for (const step of steps.filter(step => step.uses)) {
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `action not pinned by commit: ${step.uses}`);
  }
  assert.equal(steps[0].with['persist-credentials'], false);
  const text = JSON.stringify(workflow);
  assert.ok(!text.includes('secrets.'));
  assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN/.test(text));
});

test('the release tag must name the package version exactly', () => {
  assert.doesNotThrow(() => assertReleaseRef('refs/tags/sdk-v1.1.0', '1.1.0'));
  for (const ref of [undefined, 'refs/heads/main', 'refs/tags/v1.1.0', 'refs/tags/sdk-v1.0.0', 'refs/tags/sdk-v1.1.0-rc.1', 'refs/tags/sdk-v1.1.00']) {
    assert.throws(() => assertReleaseRef(ref, '1.1.0'), /matching release tag sdk-v1\.1\.0/);
  }
});

test('real publication requires the sdk tag and a definite registry answer before publishing', async t => {
  const root = releaseFixture(t);
  let publications = 0;
  const run = () => { publications++; };
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/heads/main', run }), /matching release tag/);
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.1.0', run }), /matching release tag/);
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/sdk-v1.0.0', run }), /matching release tag/);
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/sdk-v1.1.0', run,
    fetcher: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  assert.equal(publications, 0);
});

test('dry runs validate the package without registry access or provenance publication', async t => {
  const root = releaseFixture(t);
  const calls = [];
  await publishPackage({ root, dryRun: true, ref: 'refs/heads/main', fetcher: () => { throw new Error('unexpected registry lookup'); },
    run: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--registry', 'https://registry.npmjs.org/']);
  assert.equal(calls[0][2].cwd, root);
});

test('real publication skips an existing version and otherwise publishes with provenance', async t => {
  const root = releaseFixture(t);
  const calls = [];
  const run = (...args) => calls.push(args);
  await publishPackage({ root, dryRun: false, ref: 'refs/tags/sdk-v1.1.0', run,
    fetcher: async () => Response.json({ name: '@hivemagnus/hivemem-sdk', version: '1.1.0' }) });
  assert.equal(calls.length, 0);
  await publishPackage({ root, dryRun: false, ref: 'refs/tags/sdk-v1.1.0', run, fetcher: async () => new Response('', { status: 404 }) });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes('--provenance'));
  assert.ok(calls[0][1].includes('--ignore-scripts'));
});

test('package metadata mismatches stop before calling npm', async t => {
  const options = root => ({ root, dryRun: true, run: () => assert.fail('npm must not run') });
  await assert.rejects(publishPackage(options(releaseFixture(t, { private: true }))), /public @hivemagnus\/hivemem-sdk/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { publishConfig: {} }))), /public @hivemagnus\/hivemem-sdk/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { name: '@example/other' }))), /public @hivemagnus\/hivemem-sdk/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { version: 'next' }))), /valid version/);
  await assert.rejects(publishPackage({ root: releaseFixture(t), dryRun: undefined }), /explicit boolean/);
});

test('the real SDK manifest is publishable and its packed file list is checked against an allowlist', () => {
  assert.equal(sdkManifest.name, '@hivemagnus/hivemem-sdk');
  assert.equal(sdkManifest.publishConfig.access, 'public');
  assert.equal(sdkManifest.private, undefined);
  assert.deepEqual(Object.keys(sdkManifest.dependencies ?? {}), []);
  const good = ['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/client.js'];
  assert.doesNotThrow(() => checkPackedFiles(good, sdkManifest));
  assert.throws(() => checkPackedFiles([...good, 'src/index.ts'], sdkManifest), /Unexpected packed files: src\/index\.ts/);
  assert.throws(() => checkPackedFiles([...good, '.npmrc'], sdkManifest), /Unexpected/);
  assert.throws(() => checkPackedFiles([...good, 'scripts/publish-package.mjs'], sdkManifest), /Unexpected/);
  assert.throws(() => checkPackedFiles([...good, 'dist/index.js.map'], sdkManifest), /Unexpected/);
  assert.throws(() => checkPackedFiles(good.filter(file => file !== 'dist/index.d.ts'), sdkManifest), /missing: dist\/index\.d\.ts/);
  assert.throws(() => checkPackedFiles(good.filter(file => file !== 'LICENSE'), sdkManifest), /missing: LICENSE/);
});
