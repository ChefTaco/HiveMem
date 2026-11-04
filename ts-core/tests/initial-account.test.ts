import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeAccount } from '../src/initial-account.js';
import { InMemoryHiveMemStore } from '../src/store.js';
import type { AuthPrincipal } from '../src/types.js';
const operator: AuthPrincipal = {
  agentId: 'synthetic-memory-operator',
  scopes: ['admin:all'],
  rawClaims: { role: 'admin' },
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hivemem-initial-account-')),
    file = join(directory, 'identity.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      id: 'synthetic-new-memory-account',
      displayName: 'Synthetic operator',
    }),
    { mode: 0o600 },
  );
  return { directory, file, env: { HIVEMEM_INITIAL_ACCOUNT_FILE: file } };
}
test('fresh memory identity persists once and retains ID, metadata and credential generation on retry', async () => {
  const { directory, file, env } = fixture();
  try {
    let store = new InMemoryHiveMemStore();
    await initializeAccount(store, directory, env);
    const before = store.snapshot();
    assert.equal(before.agents.length, 1);
    assert.equal(before.agents[0]?.agent_id, 'synthetic-new-memory-account');
    assert.equal(store.credentialGeneration('synthetic-new-memory-account'), 0);
    store = new InMemoryHiveMemStore({ snapshot: before });
    await initializeAccount(store, directory, env);
    assert.deepEqual(store.snapshot(), before);
    const receipt = readFileSync(
      join(directory, '.initial-account.json'),
      'utf8',
    );
    assert(!receipt.includes('token'));
    assert.equal(JSON.parse(receipt).schema, 1);
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        id: 'synthetic-other-memory-account',
        displayName: 'Other operator',
      }),
    );
    await assert.rejects(
      initializeAccount(store, directory, env),
      /configuration changed/,
    );
    assert.deepEqual(store.snapshot(), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('an existing store or missing persisted account is never silently enrolled again', async () => {
  const { directory, env } = fixture();
  try {
    const existing = new InMemoryHiveMemStore();
    existing.registerAgent(
      operator,
      { agent_id: 'retained-agent', display_name: 'Retained' },
      '',
    );
    const before = existing.snapshot();
    await assert.rejects(
      initializeAccount(existing, directory, env),
      /existing store/,
    );
    assert.deepEqual(existing.snapshot(), before);
    const fresh = new InMemoryHiveMemStore();
    await initializeAccount(fresh, directory, env);
    await assert.rejects(
      initializeAccount(new InMemoryHiveMemStore(), directory, env),
      /restore it instead/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('rehearsals do not enroll identities or write receipts', async () => {
  const { directory, env } = fixture();
  try {
    const store = new InMemoryHiveMemStore();
    await initializeAccount(store, directory, {
      ...env,
      HIVE_REHEARSAL: 'true',
    });
    assert.equal(store.snapshot().agents.length, 0);
    assert(!existsSync(join(directory, '.initial-account.json')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('invalid, public or linked bootstrap files and dangling receipts fail before store mutation', async () => {
  const { directory, file, env } = fixture();
  try {
    const store = new InMemoryHiveMemStore();
    chmodSync(file, 0o644);
    await assert.rejects(initializeAccount(store, directory, env), /mode-0600/);
    chmodSync(file, 0o600);
    symlinkSync(
      '/nonexistent-synthetic-target',
      join(directory, '.initial-account.json'),
    );
    await assert.rejects(
      initializeAccount(store, directory, env),
      /protected and owned/,
    );
    assert.equal(store.snapshot().agents.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('an unknown persistence outcome never records completed enrollment, including an in-process retry', async () => {
  const { directory, env } = fixture();
  try {
    let failing = true;
    const store = new InMemoryHiveMemStore({
      persistence: {
        kind: 'qdrant',
        load: async () => new InMemoryHiveMemStore().snapshot(),
        save: async () => {
          if (failing) throw Error('Synthetic persistence outage');
        },
      },
    });
    await assert.rejects(
      initializeAccount(store, directory, env),
      /indeterminate/,
    );
    await assert.rejects(
      initializeAccount(store, directory, env),
      /indeterminate/,
    );
    assert(!existsSync(join(directory, '.initial-account.json')));
    assert.equal(store.snapshot().agents.length, 1);
    failing = false;
    store.retryPersistence();
    await store.flushPersistence();
    await initializeAccount(store, directory, env);
    assert(existsSync(join(directory, '.initial-account.json')));
    assert.equal(store.snapshot().agents.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('rejects IDs outside the native memory account contract before enrollment', async () => {
 const { directory, file, env } = fixture();
 try {
  writeFileSync(file,JSON.stringify({schema:1,id:'a'.repeat(64),displayName:'Synthetic operator'}));
  const store=new InMemoryHiveMemStore();await assert.rejects(initializeAccount(store,directory,env));
  assert.equal(store.snapshot().agents.length,0);assert(!existsSync(join(directory,'.initial-account.json')));
 } finally { rmSync(directory,{recursive:true,force:true}); }
});
