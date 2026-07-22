# Signed update runbook

## Trust model

GitHub repository visibility is not the update trust anchor. Devices trust an offline ECDSA P-256 root public key, a root-signed release-key list, and a release-signed canonical manifest. Packages are accepted only when channel, sequence, path, size, SHA-256, key state, and signatures all validate.

Private keys must never enter this repository, GitHub Actions, Supabase, ordinary workstations, or release packages.

## One-time offline ceremony

Use an encrypted offline machine and an empty directory outside the repository:

```powershell
$env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE = '<FROM_PASSWORD_MANAGER>'
node tools/Initialize_Signing_Keys.js E:\BlueShark-Offline-Signing
Remove-Item Env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE
```

Keep the root private key offline in two encrypted copies at separate controlled locations. Put the release private key on the dedicated publishing workstation only. Copy only `root-public-key.pem` and `trusted-keys.json` into the build workstation as:

```text
config/update-root-public-key.pem
config/trusted-keys.json
```

These deployment-specific files are ignored by Git.

## Build, manifest, and sign

Build the reviewed commit with a new monotonically increasing sequence:

```powershell
powershell -ExecutionPolicy Bypass -File tools/Build_Portable.ps1 -ReleaseSequence 42 -UpdateChannel stable
```

Create the unsigned manifest:

```powershell
node tools/New_Release_Manifest.js --package outputs/Blue_Shark_WhatsApp_Sender_Portable.zip --output C:\Release\manifest.json --sequence 42 --version 1.4.0 --channel stable --minimum-sequence 38 --signing-key-id release-YYYYMMDD
```

Sign it on the dedicated publishing workstation:

```powershell
$env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE = '<FROM_PASSWORD_MANAGER>'
node tools/Sign_Update_Manifest.js C:\Release\manifest.json E:\Keys\release-private-key.pem
Remove-Item Env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE
```

Verify before upload:

```powershell
node tools/Verify_Signed_Package.js outputs/Blue_Shark_WhatsApp_Sender_Portable.zip C:\Release\manifest.json config/update-root-public-key.pem config/trusted-keys.json
```

## Publish

Sign in through the local application as an approved release publisher with verified TOTP. Publish through the guarded tool:

```powershell
node tools/Publish_Signed_Release.js --package outputs/Blue_Shark_WhatsApp_Sender_Portable.zip --manifest C:\Release\manifest.json --app-root . --data-root C:\Release\PublisherSession
```

Upload is immutable. A conflict is accepted only when the existing object has the exact expected size and hash.

## Device transition

Install the transition package manually as administrator on every company device. The installer places the app under Program Files and registers the LocalSystem task through `tools/Install_Update_Agent.ps1`.

The unprivileged app may download only into the fixed ProgramData incoming directory. The LocalSystem agent ignores caller-provided URLs and paths, verifies the package again, backs up the installed version, performs an isolated health check, and rolls back on failure.

Retain the current and previous signed packages. Move the GitHub repository to private only after the server shows every authorized device on the signed channel. Any missed device requires manual reinstall from trusted media.
## Rotate or revoke a release key

Perform trust-list changes on the offline root machine. Keep the old release key active during the overlap package:

```powershell
$env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE = '<FROM_PASSWORD_MANAGER>'
node tools/Manage_Trusted_Keys.js --bundle E:\Keys\trusted-keys.json --root-private-key E:\Keys\root-private-key.pem --output E:\Keys\trusted-keys-next.json --add-public-key E:\Keys\release-next-public-key.pem --key-id release-next --not-before 2026-07-22T00:00:00Z --not-after 2027-07-22T00:00:00Z
Remove-Item Env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE
```

Copy the new public bundle into `config/trusted-keys.json`, build a signed overlap release with the old key, and install it everywhere. The update agent verifies the new bundle with the installed root key, changes only that bundle, and rolls it back if the application health check fails.

After every device trusts the new key, issue another root-signed bundle that revokes the old key:

```powershell
$env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE = '<FROM_PASSWORD_MANAGER>'
node tools/Manage_Trusted_Keys.js --bundle E:\Keys\trusted-keys-next.json --root-private-key E:\Keys\root-private-key.pem --output E:\Keys\trusted-keys-revoked.json --revoke release-YYYYMMDD
Remove-Item Env:BLUE_SHARK_SIGNING_KEY_PASSPHRASE
```

Deliver the revocation bundle in a release signed by the new key. Never revoke the only key that an offline device currently trusts; a missed device must be recovered manually from trusted media.
