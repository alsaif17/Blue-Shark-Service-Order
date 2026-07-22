'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { CloudRuntime } = require('../app/lib/cloud-runtime');
const { verifyTrustBundle, verifyReleaseManifest } = require('../app/lib/update-signature');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function run() {
  const appRoot = path.resolve(argument('--app-root') || path.join(__dirname, '..'));
  const packagePath = path.resolve(argument('--package'));
  const manifestPath = path.resolve(argument('--manifest'));
  const dataRoot = path.resolve(argument('--data-root') || process.env.BLUE_SHARK_DATA_DIR || path.join(appRoot, 'data'));
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const bytes = await fsp.readFile(packagePath);
  if (bytes.length !== manifest.size || crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('Package does not match the signed manifest');
  }
  const rootKey = await fsp.readFile(path.join(appRoot, 'config', 'update-root-public-key.pem'), 'utf8');
  const trust = JSON.parse(await fsp.readFile(path.join(appRoot, 'config', 'trusted-keys.json'), 'utf8'));
  verifyTrustBundle(rootKey, trust);
  verifyReleaseManifest(trust, manifest, {
    currentSequence: manifest.release_sequence - 1,
    allowedChannels: [manifest.channel]
  });

  const runtime = new CloudRuntime(appRoot, dataRoot);
  await runtime.initialize();
  try {
    const status = await runtime.status({ allowOffline: false });
    if (!status.authenticated || !status.mfaVerified || status.deviceState !== 'approved') {
      throw new Error('An approved online release-publisher session with MFA is required');
    }
    const upload = await runtime.client.storage.from('app-updates').upload(manifest.package_path, bytes, {
      contentType: 'application/zip',
      upsert: false
    });
    if (upload.error) {
      const statusCode = Number(upload.error.statusCode || upload.error.status || 0);
      if (statusCode !== 409) throw upload.error;
      const existing = await runtime.client.storage.from('app-updates').download(manifest.package_path);
      if (existing.error || !existing.data) throw upload.error;
      const existingBytes = Buffer.from(await existing.data.arrayBuffer());
      if (existingBytes.length !== manifest.size
          || crypto.createHash('sha256').update(existingBytes).digest('hex') !== manifest.sha256) {
        throw new Error('An existing update object conflicts with the signed package');
      }
    const published = await runtime.callRpc('publish_release', { p_manifest: manifest });
    }
    return { uploaded: true, published };
  } finally {
    runtime.close();
  }
}

run().then((result) => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch((error) => {
  process.stderr.write((error.code || error.message || 'RELEASE_PUBLISH_FAILED') + '\n');
  process.exitCode = 1;
});
