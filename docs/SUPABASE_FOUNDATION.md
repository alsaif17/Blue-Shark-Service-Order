# Supabase foundation (not deployed)

Status: local foundation only. This repository is not linked to a Supabase project, contains no project URL or real API key, and has not changed any Supabase account.

## What is included

- A private `app` schema for business tables and a narrow `api` schema for RPC entry points.
- Forced row-level security on every business table.
- Global, transaction-safe service-order numbering in Riyadh time.
- Idempotent commands and optimistic version checks.
- Separate order, document, and external-action lifecycles.
- User, branch, device, session, audit, migration, and signed-release data models.
- Edge Functions for storage grants, user administration, and pre-login update checks.
- Per-Windows-user DPAPI protection plus AES-256-GCM encrypted local cache primitives.
- A manual, one-time bootstrap template for the first administrator and first device.

## Deliberate non-actions

The foundation does not create a cloud project, choose an organization, link the Supabase CLI, push migrations, deploy functions, create users, upload files, or store credentials.

Do not run `supabase link`, `supabase db push`, or `supabase functions deploy` until the owner selects the separate production account and explicitly authorizes deployment.

## Configuration boundary

Copy `config/cloud.example.json` to `config/cloud.json` only on a workstation during a controlled environment setup. The real file is ignored by Git. A publishable key may be installed on workstations; secret and service-role keys are rejected by the local runtime and must never be copied there.

For production, set `requireCloud` to `true`. Leaving it false keeps the current legacy local application available while integration work is incomplete.

## First administrator bootstrap

1. Apply migrations to a new, empty project.
2. Create the first Auth user from the Supabase dashboard.
3. Sign in once from the intended first Windows account so the device is registered as pending.
4. Make a private copy of `supabase/manual/bootstrap_first_admin.example.sql`, fill every variable, and run it once in the SQL editor.
5. Delete the filled copy. Never commit it.
6. Sign out, sign in again on the newly approved device, and enroll TOTP MFA immediately.
7. Verify `mfaVerified=true` before using any administrator Edge Function.

Every later device must be approved through the guarded API from an already approved administrator device.

## Validation available without an account

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-foundation.ps1
```

A full RLS and concurrency test still requires a local Supabase stack or the future development project. Docker is not currently installed in this workspace, so the repository can only receive static SQL parsing and source checks here.

## Future account handoff

When the separate account is ready:

1. Create a development project first, not production.
2. Record the chosen project reference and region in the private operations record.
3. Link the CLI interactively from a trusted administrator workstation.
4. Run a dry-run migration review, apply the migration, and run `supabase config push`.
5. Verify Auth settings and the exposed `api` schema, then run the pgTAP suite.
6. Deploy the three Edge Functions.
7. Create only synthetic test users and data.
8. Pass authorization, idempotency, concurrency, storage, recovery, and update-signature gates before creating production.

No production project should be connected while any workstation still relies on the public GitHub update channel.
