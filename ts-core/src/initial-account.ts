import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { InMemoryHiveMemStore } from './store.js';
import type { AuthPrincipal } from './types.js';

const initialAccount = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-z0-9_-]{2,32}$/),
    displayName: z.string().min(1).max(200),
  })
  .strict();
const principal = (agentId: string): AuthPrincipal => ({
  agentId,
  scopes: ['admin:all'],
  rawClaims: { sub: agentId, role: 'admin' },
});

/** First-start identity enrollment is product-owned and issues no bearer token.
 * An existing account requires its exact bootstrap marker; no name/email merge. */
export async function initializeAccount(
  store: InMemoryHiveMemStore,
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const file = env.HIVEMEM_INITIAL_ACCOUNT_FILE;
  if (!file || env.HIVE_REHEARSAL === 'true') return;
  const state = lstatSync(file);
  if (
    !isAbsolute(file) ||
    !state.isFile() ||
    state.isSymbolicLink() ||
    realpathSync(file) !== file ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o077) !== 0
  )
    throw new Error(
      'Initial memory identity must be an owned mode-0600 regular file without symlinks',
    );
  const bytes = readFileSync(file),
    config = initialAccount.parse(JSON.parse(bytes.toString('utf8')));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const receipt = join(directory, '.initial-account.json');
  const marker = 'initial-account-v1:' + hash;
  const pending = receipt + '.pending';
  const protectedReceipt = (path: string): boolean => {
    let state;
    try {
      state = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.uid !== process.getuid?.() ||
      (state.mode & 0o077) !== 0
    )
      throw new Error(
        'Initial memory identity receipt must be protected and owned',
      );
    const previous: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !previous ||
      typeof previous !== 'object' ||
      !('schema' in previous) ||
      previous.schema !== 1 ||
      !('id' in previous) ||
      previous.id !== config.id ||
      !('sha256' in previous) ||
      previous.sha256 !== hash
    )
      throw new Error(
        'Initial memory identity configuration changed; use reviewed product enrollment',
      );
    return true;
  };
  const completed = protectedReceipt(receipt),
    prepared = protectedReceipt(pending);
  const snapshot = store.snapshot(),
    existing = snapshot.agents.find((agent) => agent.agent_id === config.id);
  if (existing) {
    if (existing.metadata.operation_id !== marker || existing.active === false)
      throw new Error(
        'Existing memory identity does not match the first-start receipt; use reviewed account linking',
      );
  } else {
    if (
      completed ||
      Object.values(snapshot).some((records) => records.length > 0)
    )
      throw new Error(
        'Initial memory identity is missing from an existing store; restore it instead of reenrolling',
      );
    store.registerAgent(
      principal(config.id),
      {
        agent_id: config.id,
        display_name: config.displayName,
        operation_id: marker,
      },
      '',
    );
  }
  await store.flushPersistence();
  if (!completed) {
    // Deterministic receipt bytes allow a retry after a completed persistence
    // write without issuing a new credential or changing the account ID.
    if (!prepared) {
      const fd = openSync(pending, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ schema: 1, id: config.id, sha256: hash }) + '\n',
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(pending, receipt);
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
