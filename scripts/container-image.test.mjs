import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveConfig } from '../ts-core/dist/src/config.js';

// The runtime stage's environment, as `docker run` gives it to the server.
function runtimeEnvironment() {
  const stages = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').split(/^FROM /m);
  const runtime = stages.at(-1);
  const environment = {};
  for (const line of runtime.split('\n')) {
    if (!line.startsWith('ENV ')) continue;
    for (const pair of line.slice(4).trim().split(/\s+/)) {
      const at = pair.indexOf('=');
      environment[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  return environment;
}

test('the image listens on every interface, through the variable the server reads', () => {
  const environment = runtimeEnvironment();
  assert.equal(environment.HIVEMEM_TS_CORE_HOST, '0.0.0.0');
  assert.equal(environment.HIVEMEM_HOST, undefined, 'HIVEMEM_HOST is not read by the server');
  const { config, problems } = resolveConfig({ ...environment, HIVEMEM_JWT_SECRET: 'f'.repeat(64) });
  assert.deepEqual(problems, []);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 18790);
  // An explicit setting, as the suite and the README pass, still wins.
  assert.equal(resolveConfig({ ...environment, HIVEMEM_TS_CORE_HOST: '127.0.0.1', HIVEMEM_JWT_SECRET: 'f'.repeat(64) }).config.host, '127.0.0.1');
});
