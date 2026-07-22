'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyTrustBundle } = require('../app/lib/update-signature');

const rootPublicKeyPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const bundlePath = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (!rootPublicKeyPath || !bundlePath
    || !fs.existsSync(rootPublicKeyPath) || !fs.existsSync(bundlePath)) {
  process.stderr.write('Usage: node tools/Verify_Trust_Bundle.js <root-public-key.pem> <trusted-keys.json>\n');
  process.exit(2);
}

try {
  const rootPublicKey = fs.readFileSync(rootPublicKeyPath, 'utf8');
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  verifyTrustBundle(rootPublicKey, bundle);
  process.stdout.write(JSON.stringify({
    ok: true,
    keys: bundle.release_keys.map((key) => ({ id: key.key_id, status: key.status }))
  }) + '\n');
} catch (error) {
  process.stderr.write((error.code || error.message || 'TRUST_BUNDLE_INVALID') + '\n');
  process.exitCode = 1;
}
