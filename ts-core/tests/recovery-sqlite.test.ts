import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '@photostructure/sqlite';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { backupSqlite } from '../src/release/runtime.js';

it('the bundled recovery engine backs up committed WAL records and refuses overwrite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-recovery-fixture-'));
  const source = join(directory, 'source.sqlite');
  const destination = join(directory, 'backup.sqlite');
  const writer = new DatabaseSync(source);
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO retained VALUES(1,'committed'); BEGIN IMMEDIATE; INSERT INTO retained VALUES(2,'uncommitted')");
    await backupSqlite(source, destination);
    const reader = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.deepEqual(reader.prepare('SELECT id,value FROM retained').all().map(row => ({ ...row })), [{ id: 1, value: 'committed' }]);
      assert.deepEqual({ ...reader.prepare('PRAGMA integrity_check').get() }, { integrity_check: 'ok' });
    } finally { reader.close(); }
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    await assert.rejects(backupSqlite(source, destination));
    writer.exec('ROLLBACK');
    assert.deepEqual({ ...writer.prepare('SELECT count(*) AS count FROM retained').get() }, { count: 1 });
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
