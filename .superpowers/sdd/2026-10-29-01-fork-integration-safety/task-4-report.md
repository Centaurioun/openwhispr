# Task 4 report: local data safety and migration recovery

## Scope and evidence

- Worktree: `/Users/yusuf/.codex/worktrees/openwhispr-fork-safety-pr1`
- Starting commit: `8598a26f7163419305b93ede7573ada3af2368d1`
- Added `scripts/custom/backup-user-profile.md` and
  `test/helpers/customMigrationGuard.test.js`.
- The test creates a SQLite database only in an `os.tmpdir()` disposable
  directory. A synthetic migration adds a column, creates a second table, then
  throws. Running it without a transaction leaves the column behind (RED); the
  transaction-wrapped fixture rolls back both schema effects and verifies that
  the raw transcript remains readable, byte-identical, and hash-identical.
- This is a fixture only. It does not call DatabaseManager or app migrations,
  access Electron profile discovery, or certify upgrade behavior against an
  actual user profile.

## RED / GREEN

RED command:

```sh
/opt/homebrew/opt/node@24/bin/node --test test/helpers/customMigrationGuard.test.js
```

Result: exit 1 as expected. The schema assertion found actual columns
`['id', 'raw', 'migration_marker']` instead of `['id', 'raw']` after the
simulated migration error, demonstrating the partial effect without a
transaction.

GREEN command:

```sh
/opt/homebrew/opt/node@24/bin/node --test test/helpers/customMigrationGuard.test.js
```

Result: exit 0; 1 test passed, 0 failed. It checked the transcript bytes and
SHA-256, original schema, absence of the partial table, and SQLite integrity.

## Documentation and whitespace checks

The runbook documents runtime userData discovery via `app.getPath('userData')`,
illustrative macOS/Windows/Linux paths, versioned backups, closed-app copying
with WAL/SHM preservation or SQLite online backup, restore to a disposable
profile, readability/hash verification, and the automated-test prohibition on
production profiles.

```sh
/opt/homebrew/opt/node@24/bin/node -e "const fs=require('node:fs');const d=fs.readFileSync('scripts/custom/backup-user-profile.md','utf8').replace(/\\s+/g,' ');for(const s of ['macOS','Windows','Linux','app.getPath(\\'userData\\')','-wal','-shm','online backup','os.tmpdir()','production profile','does not invoke']){if(!d.includes(s))throw Error('missing: '+s)}console.log('documentation assertions: PASS (10 checks)')"
```

Result: `documentation assertions: PASS (10 checks)`.

```sh
git diff --check
```

Result: exit 0, no whitespace errors.
