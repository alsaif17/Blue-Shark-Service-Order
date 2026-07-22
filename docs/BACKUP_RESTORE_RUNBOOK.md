# Backup and restore runbook

## Scope

The backup captures the Postgres database plus both private Storage buckets: `order-documents` and `app-updates`. Database platform backups alone do not contain Storage objects.

The output is encrypted with AES-256-GCM using a key derived by scrypt. Keep the passphrase in the company password manager, separate from backup files.

## Prerequisites

Install `pg_dump`, `pg_restore`, `rclone`, `tar`, and Node.js 24. Set these only in the current secured operator session:

```text
PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD
PGSSLMODE=require
BLUE_SHARK_STORAGE_S3_ENDPOINT
BLUE_SHARK_STORAGE_S3_ACCESS_KEY
BLUE_SHARK_STORAGE_S3_SECRET_KEY
BLUE_SHARK_BACKUP_PASSPHRASE
```

Use a database credential and S3 access key dedicated to backup operations. Never save them in the repository or a reusable command-history file.

## Create a backup

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Backup_Supabase.ps1 -DestinationDirectory D:\BlueSharkBackups\Daily
```

Copy the resulting `.bsbak` file to two company-controlled locations. Keep one weekly copy on a separately controlled medium. Record filename, SHA-256, creation time, project reference, operator, and retention class.

## Restore drill

Restore only into a new, empty, isolated project. The confirmation switch is intentionally explicit:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Restore_Supabase.ps1 -BackupFile D:\BlueSharkBackups\Daily\BlueShark-YYYYMMDD-HHMMSS.bsbak -IUnderstandThisRestoresIntoAnEmptyProject
```

The restore tool decrypts into a temporary directory, rejects unsafe archive paths, verifies every manifest size and hash, restores Postgres, and copies both Storage buckets.

## Acceptance after restore

- Run the database test suite and security advisors.
- Compare table counts, order totals, latest audit event, and migration-source counts.
- Download a sample of old and recent documents and verify SHA-256.
- Download the current and previous signed update packages and verify signatures.
- Sign in with synthetic recovery users from two branches and prove cross-branch denial.
- Record elapsed time and the newest restored event timestamp.

Run this drill monthly. The operating targets are an RPO of at most 24 hours and an RTO of at most 4 hours. A backup is not considered valid until a restore drill has succeeded.
