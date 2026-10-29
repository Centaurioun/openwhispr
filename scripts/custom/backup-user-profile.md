# Back up and restore a user profile before schema upgrades

Use this procedure when validating an upgrade that may change the local user
database. Never point automated migration tests at a real user profile.

## Before upgrading a real profile

1. Close OpenWhispr completely and confirm its process has exited. Do not copy a
   database while the app may still be writing to it.
2. Discover the active profile directory from the running Electron app's
   configured runtime, using `app.getPath('userData')` (for example, log that
   value from the main process or inspect the app's supported diagnostics).
   Do not guess from an OS default: app name, packaging, and user overrides can
   change the location. Illustrative defaults include `~/Library/Application
   Support/<app>` on macOS, `%APPDATA%\\<app>` on Windows, and
   `~/.config/<app>` on Linux.
3. Create a versioned backup outside the profile directory, recording the app
   version, profile path, date, and backup method. Keep prior backups until the
   upgraded profile has been verified.
4. Make the copy SQLite-consistent. With the app closed, copy the database and
   any associated `-wal` and `-shm` files together, preserving their names and
   relative layout. Alternatively, use SQLite's online backup API/command while
   the database is open and follow that tool's documented completion semantics.
   A plain copy of only the main database file while writers are active is not
   a reliable backup.
5. Restore the backup into a separate disposable profile directory, configure
   the app/test harness to use that directory, and exercise the intended
   upgrade there. Check that the database opens, run an SQLite integrity check,
   and verify representative raw transcript records remain readable. Compare
   hashes of raw transcript bytes before and after when validating preservation.
6. Keep the original backup untouched. If the disposable restore fails, stop
   and investigate before upgrading the original profile.

## Automated migration tests

Tests must create their own databases under `os.tmpdir()` (or another dedicated
temporary test root), seed synthetic data, and remove only the fixture they
created. They must never discover, open, mutate, migrate, or delete a production
profile. Do not use a developer's normal Electron `userData` directory in CI or
local automated tests.

Run the focused synthetic transaction fixture from the repository root with
the project's supported Node version:

```sh
node --test test/helpers/customMigrationGuard.test.js
```

`test/helpers/customMigrationGuard.test.js` forces an error after a schema
mutation inside a SQLite transaction and checks rollback, database integrity,
and exact raw transcript bytes/hash. It is a disposable SQLite fixture. It does
not invoke `DatabaseManager`, app migration code, Electron profile discovery,
backup tooling, or any live profile; passing it does not certify actual app
migrations or the operational backup procedure.
