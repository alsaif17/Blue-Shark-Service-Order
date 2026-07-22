# Supabase handoff checklist

## Current state

This repository contains a complete local integration foundation. It is intentionally unlinked: no Supabase organization, project reference, URL, API key, database password, access token, or remote migration state is stored here.

The next operator must use a separate company-controlled Supabase account. Start with a development project. Do not point the application at production until every gate in `docs/PRODUCTION_GATES.md` is evidenced.

## Delivered foundation

- Private `app` business schema and exposed `api` RPC schema.
- Forced RLS, explicit grants, branch authorization, approved-device checks, and short session validation.
- Transactional global order numbering and idempotent/versioned commands.
- Auth, TOTP MFA, device approval, administration, encrypted per-user cache, and offline trust-window support.
- Private order-document and update buckets.
- Narrow Edge Functions for storage URLs, Auth administration, and pre-login update checks.
- Legacy SQLite preparation/import tooling with immutable source hashes and conflict provenance.
- Encrypted database-plus-storage backup and empty-project restore tooling.
- Independently signed updates, protected Windows update agent, health check, and rollback.
- Static and local behavioral tests that do not require a cloud account.

## Operator prerequisites

Install the current Supabase CLI, Docker Desktop for the local stack, Node.js 24, PostgreSQL client tools, rclone, and Git. Before using any CLI command, inspect its current interface:

The current handoff folder also contains the ignored portable Node runtime, launcher, and vetted WhatsApp web cache needed by `tools/Build_Portable.ps1`. They are intentionally excluded from Git because they are large third-party/runtime artifacts. If the handoff is reconstructed from a fresh clone instead of this folder, restore those exact vetted artifacts from the transition media and verify their hashes before building.

Do not substitute an arbitrary browser profile or cache. No WhatsApp session, employee data, cloud configuration, signing private key, or database belongs in a release package.

```powershell
supabase --version
supabase --help
supabase db push --help
supabase config push --help
supabase functions deploy --help
```

Run the repository-only verification before linking anything:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-foundation.ps1
```

## Create and link only the development environment

1. Sign in to the separate company Supabase account.
2. Create an empty development project with the selected region.
3. Disable automatic public table exposure if the project-creation screen offers it.
4. Keep the generated publishable key; do not distribute a secret or service-role key.
5. From a trusted administrator workstation, link this repository:

```powershell
supabase login
supabase link --project-ref <DEVELOPMENT_PROJECT_REF>
supabase migration list --linked
supabase db push --dry-run
```

Review the dry-run. Only then apply it:

```powershell
supabase db push
supabase config push
supabase test db
supabase db advisors
```

The configuration push is required: database migrations do not apply Auth settings or the Data API schema list. After it completes, verify in the dashboard that only `api` is exposed, self-signup is disabled, JWT expiry is 900 seconds, and TOTP enrollment/verification are enabled.

No custom Edge Function secret is required by this implementation. Hosted functions receive Supabase URL and privileged runtime keys from the platform. Never place any privileged key in `config/cloud.json`.

## Deploy the narrow Edge Functions

Confirm the CLI help first, then deploy exactly these three functions:

```powershell
supabase functions deploy storage-broker
supabase functions deploy admin-users
supabase functions deploy update-check
```

The checked-in `supabase/config.toml` keeps JWT verification enabled for user functions and disabled only for `update-check`, which performs its own approved-device verification.

## Configure one workstation

Create `config/cloud.json` from the example. This real file is ignored by Git:

```json
{
  "supabaseUrl": "https://PROJECT_REF.supabase.co",
  "supabasePublishableKey": "sb_publishable_REPLACE_ME",
  "requireCloud": true
}
```

The desktop application may contain a publishable key. It must reject secret-key-shaped and service-role values. Never add real values to source control, release manifests, logs, screenshots, or tickets.

## Bootstrap the first administrator

1. Create the first Auth user in the Supabase dashboard.
2. Start the application from the intended Windows account and sign in once. The device should become `pending`.
3. Copy `supabase/manual/bootstrap_first_admin.example.sql` outside this repository.
4. Fill all variables using the Auth user ID and pending device ID, then run it once in the SQL editor.
5. Destroy the filled copy.
6. Sign out and sign in again on the approved device.
7. Enroll and verify TOTP immediately.
8. Confirm the session reports `systemAdmin=true`, `deviceState=approved`, and `mfaVerified=true`.
9. Create every later branch, user, membership, and device through the guarded application APIs.

The bootstrap is the sole intentional chicken-and-egg exception. It must be recorded in the private operations log.

## Before production

- Complete both migration rehearsals and resolve every historical conflict.
- Run remote RLS, idempotency, concurrency, storage, revocation, and MFA rejection tests.
- Perform an encrypted backup and restore it into a separate empty project.
- Create the offline update-signing trust root and deploy the transition installer to all devices.
- Complete the five-day one-branch/two-device pilot.
- Confirm every device uses the signed private update channel.
- Rotate any credential ever exposed in repository history.
- Make the GitHub repository private only after the transition check reaches every device.

Production remains blocked until `docs/PRODUCTION_GATES.md` contains evidence for every mandatory gate.
