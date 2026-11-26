import { join, resolve } from 'node:path';
import { acquireWriterLock } from './writer-lock.js';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  findPackageRoot,
  guardedMigration,
  hash,
  home,
  metadata,
  migrationFlags,
  migrationReview,
  schemaCommit,
  schemaPlan,
  storeSpec,
  type Release,
} from './release/runtime.js';

export const memoryPackageRoot = findPackageRoot(import.meta.url, '@hivemagnus/hivemem-server');

/**
 * HiveMem's storage-format history, which `migrate` checks the data directory against. It used to
 * come from a Hive 1.2.2 bundle manifest frozen in package.json, which made `/v1/health` report
 * `release: "1.2.2"`. The memory entries are unchanged, so the schema checksum (and with it every
 * installation's recorded state) stays the same. Append entries here; never edit or reorder them.
 */
export const MEMORY_MIGRATIONS: Release['migrations'] = [
  {
    component: 'memory',
    id: 'managed-format-1',
    checksum: 'ed0f08de635923fe627dcf5e133555911da81f52157552cf8c0f5035e5b1dac7',
    impact: 'fast',
    readableBy: '^1.0.3',
    note: 'Adopt existing compatible state and record its format; no destructive conversion.',
  },
];
/** The oldest HiveMem whose code reads data written by this one. */
export const MEMORY_DATA_COMPATIBILITY = '^1.0.3';

/** This package's own release record for the migration engine, versioned with the package. */
export function memoryRelease(packageRoot = memoryPackageRoot): Release {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } };
  return {
    schema: 1,
    version: pkg.version,
    engineProtocol: 1,
    engines: { node: pkg.engines?.node ?? '*' },
    components: { '@hivemagnus/hivemem-server': pkg.version },
    optionalComponents: [],
    testedSdks: {},
    minUpgradeFrom: {},
    requiredIntermediates: [],
    newRequiredEnv: [],
    newOptionalEnv: [],
    removedEnv: [],
    migrations: MEMORY_MIGRATIONS,
    wireCompatibility: { memory: '^1.0.0' },
    dataCompatibility: { memory: MEMORY_DATA_COMPATIBILITY },
    summary: 'HiveMem storage format',
    notesUrl: 'https://github.com/ChefTaco/HiveMem/releases',
    breaking: false,
  };
}

export async function memoryMigration(args: readonly string[], automatic = false): Promise<void> {
  const flags = migrationFlags(args);
  const data = resolve(process.env.HIVEMEM_STORAGE_PATH || join(home(), 'memory'));
  const state = join(data, '.hive-memory-schema.json');
  const release = memoryRelease();
  const checksum = hash(
    JSON.stringify(
      release.migrations.filter((m) => m.component === 'memory').map((m) => [m.id, m.checksum]),
    ),
  );
  const plan = () => ({
    ...schemaPlan(state, checksum, metadata(memoryPackageRoot).version),
    dataChanged: false,
  });
  if (flags.plan) {
    console.log(JSON.stringify({ ...plan(), ...migrationReview(release, 'memory') }));
    return;
  }
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const releaseWriter = automatic ? () => {} : await acquireWriterLock(join(data, 'writer.lock'));
  try {
    await guardedMigration({
      service: 'memory',
      spec: storeSpec('memory', process.env, home()),
      lock: join(data, 'migration.lock'),
      pending: () => plan().pending.length > 0,
      automatic,
      release,
      ...(flags.backupDir ? { backupDir: flags.backupDir } : {}),
      ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}),
      apply: async () => {
        schemaCommit(state, checksum, release.version, release.dataCompatibility.memory!);
      },
    });
  } finally {
    releaseWriter();
  }
}
