# Production gates

Production is blocked by default. Each gate needs a dated evidence record containing environment, exact command or scenario, expected result, actual result, artifact link or hash, reviewer, and approval.

## Local foundation gates

- `scripts/verify-foundation.ps1` passes from a clean checkout.
- All Node tests pass.
- All JavaScript and PowerShell source files parse.
- SQL migration and pgTAP files parse.
- No real URL, credential, private signing key, filled branch map, or generated migration package is tracked.
- The updater contains no public GitHub release fallback.

## Remote development gates

- Migration applies to a new empty project without manual edits.
- Database tests and security advisors pass.
- Every exposed RPC has an explicit grant and an explicit denial test where applicable.
- Direct table access is denied; cross-branch access is denied.
- Correct user plus pending/revoked device is denied.
- Approved device plus disabled user or revoked session is denied on the next request.
- System administration and release publishing require AAL2.
- One hundred concurrent finalizations from ten simulated devices produce unique numbers.
- Reusing a command ID returns the same result without duplicate rows or audit events.
- Stale expected versions are rejected.
- Private Storage upload/download grants expire and cannot escape the authorized object path.

## Migration gates

- Two rehearsals complete with immutable source hashes.
- Counts, amounts, dates, phones, files, and hashes reconcile.
- Every number conflict receives a human disposition.
- Exact duplicates merge idempotently.
- Future counters start above parseable historical suffixes.
- Final sources are frozen, copied, hashed, and archived before cutover.

## Client and offline gates

- Separate Windows users cannot decrypt one another's cache.
- Sign-out closes the database and removes working keys from memory.
- Offline access expires 24 hours after the last server verification.
- Local activity cannot extend the trust window.
- Clock rollback is detected.
- Offline mode cannot finalize, number, print, send, or modify a final order.
- A newly finalized order appears on another active device within one minute.

## Side-effect gates

- Crashes are injected before and after finalization, document upload, print, and WhatsApp send.
- No final order or document is duplicated.
- An uncertain WhatsApp outcome is never retried automatically.
- Supervisors have a visible queue and operating procedure for uncertain attempts.

## Update gates

- Modified manifests, wrong hashes, revoked/expired keys, wrong channels, expired URLs, and rollback sequences are rejected.
- A failed health check restores the previous signed version.
- Pilot rollout succeeds before stable rollout.
- Every device is on the signed private channel before GitHub visibility changes.
- Historical repository, Actions logs, and releases are scanned; exposed credentials are rotated.

## Recovery and operations gates

- Daily encrypted database and Storage backup is scheduled and monitored.
- Two restorable copies exist; one weekly copy is separately controlled.
- A monthly restore into an empty environment meets RPO <= 24 hours and RTO <= 4 hours.
- Twelve-month projected usage remains below 75 percent of approved capacity or an upgrade is approved.
- Standard Windows accounts, BitLocker, Secure Boot, screen lock, and no shared logins are enforced.
- Incident response names the owner for user/device revocation, key rotation, restore, and branch outage communication.

No waiver is implicit. Any accepted exception must name the risk owner, expiry date, compensating control, and rollback trigger.
