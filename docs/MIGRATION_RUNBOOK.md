# Legacy migration runbook

## Safety rules

Treat every SQLite database and document directory as immutable evidence. Copy sources to an encrypted working drive, calculate hashes before processing, and never run cleanup or repair commands against the originals.

Run two complete rehearsals before the final cutover. Use a development project and synthetic or approved copies of business data.

## Prepare a review package

The output directory must be empty and outside every source directory:

```powershell
node scripts/Prepare_Legacy_Migration.js C:\Migration\Device-A\orders.db C:\Migration\Device-B\orders.db --output C:\Migration\Review-01
```

The tool opens SQLite read-only, records source size and SHA-256, checks monetary balance, normalizes phone numbers, hashes copied documents, and writes:

- `manifest.json`: source totals, hashes, exact-duplicate groups, and conflicts.
- `records.ndjson`: normalized records used by the importer.
- `documents\`: copied documents addressed by their recorded hash.

After preparation, hash the original sources again and confirm they did not change. Store the package and comparison report encrypted.

## Review before import

1. Compare source counts, total amounts, dates, phones, and document hashes.
2. Review every entry in `manifest.json.conflicts`.
3. Confirm exact duplicates are genuinely identical.
4. Create a private branch map from `config/migration-branch-map.example.json`.
5. Use keys in the form `source-001:<legacy-branch-id>`; use `source-001:*` only as an intentional fallback.
6. Never commit the filled branch map.

Conflicting historical rows keep their legacy number and provenance. They are not silently deleted or renumbered.

## Import a rehearsal

The application must already be configured for the development project. Sign in locally as an approved system administrator with verified TOTP, then run:

```powershell
node scripts/Import_Legacy_Package.js --package C:\Migration\Review-01 --branch-map C:\Migration\branch-map.json --app-root . --data-root C:\Migration\AdminSessionData
```

The importer registers immutable sources, performs idempotent record imports, preserves conflict provenance, uploads verified documents, and advances future year counters above parseable historical suffixes.

Re-running the same package must not create a second order or duplicate audit event.

## Reconciliation

Record evidence for:

- Source count versus `app.migration_sources.row_count`.
- Source amount totals versus imported order totals.
- Imported, exact-merged, and conflict counts.
- Every document size and SHA-256.
- Every source row represented in `app.order_migration_origins`.
- Every number conflict represented in `app.migration_conflicts`.
- Counter values after `api.admin_seed_order_counters_from_history`.

Do not accept a rehearsal with unexplained differences.

## Final cutover

1. Announce and enforce a write freeze on all legacy devices.
2. Copy and hash every source again.
3. Prepare the final package from the frozen copies.
4. Reconcile it before import.
5. Take a pre-cutover cloud backup.
6. Import once, reconcile again, and verify documents.
7. Enable central mode on the pilot devices, then the remaining devices.
8. Preserve encrypted source archives as read-only evidence.

Rollback means stopping central writes and returning users to the frozen legacy application with a documented reconciliation plan. Never merge two independently writable histories after rollback.
