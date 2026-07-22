'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, withoutSignature, validateManifest } = require('../app/lib/update-signature');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const privateKeyPath = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (!manifestPath || !privateKeyPath) fail('Usage: node tools/Sign_Update_Manifest.js <manifest.json> <release-private-key.pem>');
if (!fs.existsSync(manifestPath) || !fs.existsSync(privateKeyPath)) fail('Manifest or private key was not found');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
delete manifest.signature;
manifest.signature = 'AA==';
validateManifest(manifest);
delete manifest.signature;

const privateKey = crypto.createPrivateKey({
  key: fs.readFileSync(privateKeyPath),
  format: 'pem',
  passphrase: process.env.BLUE_SHARK_SIGNING_KEY_PASSPHRASE
});
const signature = crypto.sign(
  'sha256',
  Buffer.from(canonicalize(withoutSignature(manifest)), 'utf8'),
  { key: privateKey, dsaEncoding: 'der' }
).toString('base64');
const output = { ...manifest, signature };
fs.writeFileSync(manifestPath, JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
process.stdout.write(JSON.stringify({ manifestPath, releaseSequence: output.release_sequence, sha256: output.sha256 }) + '\n');
