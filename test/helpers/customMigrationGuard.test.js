'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const transcript = Buffer.from('synthetic raw transcript\u0000bytes\n', 'utf8');
const transcriptHash = createHash('sha256').update(transcript).digest('hex');

function runBrokenMigration(db) {
  db.exec('ALTER TABLE transcripts ADD COLUMN migration_marker TEXT');
  // Deliberately fail after a schema mutation to exercise rollback behavior.
  db.exec('CREATE TABLE migration_partial_effect (id INTEGER PRIMARY KEY)');
  throw new Error('simulated migration failure');
}

test('failed schema migration leaves disposable transcript readable and unchanged', (t) => {
  const profileDir = mkdtempSync(join(tmpdir(), 'openwhispr-migration-guard-'));
  const dbPath = join(profileDir, 'profile.sqlite');
  const db = new Database(dbPath);
  t.after(() => {
    db.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  db.exec('CREATE TABLE transcripts (id INTEGER PRIMARY KEY, raw BLOB NOT NULL)');
  db.prepare('INSERT INTO transcripts (raw) VALUES (?)').run(transcript);

  // This fixture models the atomicity contract; it does not call app migrations.
  const migrateTransactionally = db.transaction(() => runBrokenMigration(db));
  assert.throws(() => migrateTransactionally(), /simulated migration failure/);

  const saved = db.prepare('SELECT raw FROM transcripts WHERE id = 1').get().raw;
  assert.deepEqual(saved, transcript);
  assert.equal(createHash('sha256').update(saved).digest('hex'), transcriptHash);
  assert.deepEqual(db.prepare('PRAGMA table_info(transcripts)').all().map((column) => column.name), ['id', 'raw']);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_partial_effect'").get(), undefined);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
