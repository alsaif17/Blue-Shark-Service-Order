'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, verifyTrustBundle } = require('../app/lib/update-signature');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : '';
}

function options(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function outsideRepository(candidate, repositoryRoot) {
  const relative = path.relative(repositoryRoot, candidate);
  return relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative);
}

function iso(value, label) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) fail(label + ' must be an ISO-8601 timestamp');
  return new Date(timestamp).toISOString();
}

const repositoryRoot = path.resolve(__dirname, '..');
const bundlePath = path.resolve(option('--bundle'));
const rootPrivatePath = path.resolve(option('--root-private-key'));
const outputPath = path.resolve(option('--output'));
const addPublicPath = option('--add-public-key') ? path.resolve(option('--add-public-key')) : '';
const addKeyId = option('--key-id');
const revokeIds = options('--revoke');
const passphrase = String(process.env.BLUE_SHARK_SIGNING_KEY_PASSPHRASE || '');

if (!option('--bundle') || !option('--root-private-key') || !option('--output')) {
  fail('Usage: node tools/Manage_Trusted_Keys.js --bundle <trusted-keys.json> --root-private-key <root-private-key.pem> --output <new-trusted-keys.json> [--revoke <key-id>] [--add-public-key <release-public-key.pem> --key-id <id> --not-before <iso> --not-after <iso>]');
}
if (!fs.existsSync(bundlePath) || !fs.existsSync(rootPrivatePath)) fail('Trust bundle or root private key was not found');
if (!outsideRepository(bundlePath, repositoryRoot)
    || !outsideRepository(rootPrivatePath, repositoryRoot)
    || !outsideRepository(outputPath, repositoryRoot)
    || (addPublicPath && !outsideRepository(addPublicPath, repositoryRoot))) {
  fail('Signing inputs and output must remain outside the repository');
}
if (bundlePath === outputPath || fs.existsSync(outputPath)) fail('Output must be a new file distinct from the input bundle');
if (passphrase.length < 20) fail('Set BLUE_SHARK_SIGNING_KEY_PASSPHRASE to at least 20 characters');
if (!revokeIds.length && !addPublicPath) fail('Specify at least one --revoke or --add-public-key operation');
if (addPublicPath && (!fs.existsSync(addPublicPath)
    || !/^[A-Za-z0-9._-]{3,80}$/.test(addKeyId)
    || !option('--not-before') || !option('--not-after'))) {
  fail('Adding a key requires a public key, valid key ID, not-before, and not-after');
}

const rootPrivateKey = crypto.createPrivateKey({
  key: fs.readFileSync(rootPrivatePath),
  format: 'pem',
  passphrase
});
if (rootPrivateKey.asymmetricKeyType !== 'ec'
    || rootPrivateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
  fail('Root key must be ECDSA P-256');
}
const rootPublicKey = crypto.createPublicKey(rootPrivateKey);
const rootPublicPem = rootPublicKey.export({ type: 'spki', format: 'pem' });
const current = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
verifyTrustBundle(rootPublicPem, current);

const releaseKeys = current.release_keys.map((key) => ({ ...key }));
for (const keyId of new Set(revokeIds)) {
  const key = releaseKeys.find((candidate) => candidate.key_id === keyId);
  if (!key) fail('Cannot revoke unknown key: ' + keyId);
  key.status = 'revoked';
}

if (addPublicPath) {
  if (releaseKeys.some((key) => key.key_id === addKeyId)) fail('Release key ID already exists: ' + addKeyId);
  const releasePublicPem = fs.readFileSync(addPublicPath, 'utf8');
  const releasePublicKey = crypto.createPublicKey(releasePublicPem);
  if (releasePublicKey.asymmetricKeyType !== 'ec'
      || releasePublicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    fail('Release key must be ECDSA P-256');
  }
  const notBefore = iso(option('--not-before'), 'not-before');
  const notAfter = iso(option('--not-after'), 'not-after');
  if (Date.parse(notAfter) <= Date.parse(notBefore)) fail('not-after must be later than not-before');
  releaseKeys.push({
    key_id: addKeyId,
    status: 'active',
    public_key_pem: releasePublicPem,
    not_before: notBefore,
    not_after: notAfter
  });
}

const unsigned = { schema_version: 1, release_keys: releaseKeys };
const signature = crypto.sign(
  'sha256',
  Buffer.from(canonicalize(unsigned), 'utf8'),
  { key: rootPrivateKey, dsaEncoding: 'der' }
).toString('base64');
const result = { ...unsigned, signature };
verifyTrustBundle(rootPublicPem, result);

fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({
  ok: true,
  output: outputPath,
  active: releaseKeys.filter((key) => key.status === 'active').map((key) => key.key_id),
  revoked: releaseKeys.filter((key) => key.status === 'revoked').map((key) => key.key_id)
}) + '\n');
