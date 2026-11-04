import type { InMemoryHiveMemStore } from './store.js';

/** Rehearsals preserve persisted claims as well as preventing background work. */
export function configureStartupWorker(store: Pick<InMemoryHiveMemStore, 'configureWorker' | 'recoverInterruptedJobs'>, env: NodeJS.ProcessEnv): boolean {
  const rehearsal = env.HIVE_REHEARSAL === 'true';
  const enabled = !rehearsal && env.HIVEMEM_WORKER_ENABLED !== 'false';
  store.configureWorker(enabled);
  if (!rehearsal) store.recoverInterruptedJobs();
  return enabled;
}
