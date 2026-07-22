'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('../app/lib/update-signature');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

const repositoryRoot = path.resolve(__dirname, '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : '';
const passphrase = String(process.env.BLUE_SHARK_SIGNING_KEY_PASSPHRASE || '');
if (!target || target === repositoryRoot || target.startsWith(repositoryRoot + path.sep)) {
  fail('Choose an offline output directory outside the repository.');
}
if (passphrase.length < 20) fail('Set BLUE_SHARK_SIGNING_KEY_PASSPHRASE to at least 20 characters.');
if (fs.existsSync(target) && fs.readdirSync(target).length) fail('The signing output directory must be empty.');
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

function pair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
function privatePem(key) {
  return key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
}
function publicPem(key) {
  return key.export({ type: 'spki', format: 'pem' });
}
function write(name, value, mode) {
  fs.writeFileSync(path.join(target, name), value, { encoding: 'utf8', mode });
}

const root = pair();
const release = pair();
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const keyId = 'release-' + date;
const unsigned = {
  schema_version: 1,
  release_keys: [{
    key_id: keyId,
    status: 'active',
    public_key_pem: publicPem(release.publicKey),
    not_before: new Date(Date.now() - 3600000).toISOString(),
    not_after: new Date(Date.now() + 366 * 24 * 3600000).toISOString()
  }]
};
const signature = crypto.sign(
  'sha256',
  Buffer.from(canonicalize(unsigned), 'utf8'),
  { key: root.privateKey, dsaEncoding: 'der' }
).toString('base64');

write('root-private-key.pem', privatePem(root.privateKey), 0o600);
write('root-public-key.pem', publicPem(root.publicKey), 0o644);
write('release-private-key.pem', privatePem(release.privateKey), 0o600);
write('release-public-key.pem', publicPem(release.publicKey), 0o644);
write('trusted-keys.json', JSON.stringify({ ...unsigned, signature }, null, 2) + '\n', 0o644);
write('KEY_ID.txt', keyId + '\n', 0o600);
process.stdout.write(JSON.stringify({ ok: true, target, keyId }) + '\n');
