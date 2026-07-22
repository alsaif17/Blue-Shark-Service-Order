'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyTrustBundle, verifyReleaseManifest } = require('../app/lib/update-signature');

const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const incoming = path.resolve(process.argv[3] || path.join(process.env.ProgramData || appRoot, 'BlueShark', 'Incoming'));

try {
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8'));
  const root = fs.readFileSync(path.join(appRoot, 'config', 'update-root-public-key.pem'), 'utf8');
  const bundle = JSON.parse(fs.readFileSync(path.join(appRoot, 'config', 'trusted-keys.json'), 'utf8'));
  const ready = JSON.parse(fs.readFileSync(path.join(incoming, 'ready.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(incoming, ready.manifestFile), 'utf8'));
  verifyTrustBundle(root, bundle);
  verifyReleaseManifest(bundle, manifest, {
    currentSequence: Number(version.releaseSequence || 0),
    allowedChannels: version.updateChannel === 'pilot' ? ['pilot', 'stable'] : ['stable']
  });
  if (ready.releaseSequence !== manifest.release_sequence || ready.packageFile !== 'package.zip' || ready.manifestFile !== 'manifest.json') {
    throw new Error('Ready marker does not match the manifest');
  }
  const packagePath = path.join(incoming, ready.packageFile);
  const stat = fs.statSync(packagePath);
  if (!stat.isFile() || stat.size !== manifest.size) throw new Error('Package size does not match the signed manifest');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');
  if (digest !== manifest.sha256) throw new Error('Package hash does not match the signed manifest');
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version, releaseSequence: manifest.release_sequence }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'UPDATE_VERIFICATION_FAILED' }) + '\n');
  process.exitCode = 2;
}
