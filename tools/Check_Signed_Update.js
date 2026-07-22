'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { SecureStore } = require('../app/lib/secure-store');
const { loadCloudConfiguration } = require('../app/lib/cloud-runtime');
const { verifyTrustBundle, verifyReleaseManifest } = require('../app/lib/update-signature');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function atomicJson(filePath, value) {
  const temporary = filePath + '.' + process.pid + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

async function run() {
  const appRoot = path.resolve(argument('--app-root', path.join(__dirname, '..')));
  const dataRoot = path.resolve(argument('--data-root', path.join(appRoot, 'data')));
  const incoming = path.resolve(argument('--incoming', path.join(process.env.ProgramData || dataRoot, 'BlueShark', 'Incoming')));
  const configuration = loadCloudConfiguration(appRoot);
  if (!configuration.enabled) return { updateAvailable: false, reason: 'cloud-disabled' };

  const version = JSON.parse(await fsp.readFile(path.join(appRoot, 'version.json'), 'utf8'));
  const currentSequence = Number(version.releaseSequence || 0);
  const channel = String(version.updateChannel || 'stable');
  const rootPublicKey = await fsp.readFile(path.join(appRoot, 'config', 'update-root-public-key.pem'), 'utf8');
  const trustBundle = JSON.parse(await fsp.readFile(path.join(appRoot, 'config', 'trusted-keys.json'), 'utf8'));
  verifyTrustBundle(rootPublicKey, trustBundle);

  const secureStore = new SecureStore(path.join(dataRoot, 'protected'));
  const identity = await secureStore.get('device-identity');
  if (!identity?.deviceId || !identity?.deviceToken) {
    throw Object.assign(new Error('Device enrollment is required before update checks'), { code: 'DEVICE_IDENTITY_MISSING' });
  }

  const response = await fetch(configuration.url + '/functions/v1/update-check', {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: {
      apikey: configuration.publishableKey,
      'content-type': 'application/json',
      'x-device-id': identity.deviceId,
      'x-device-token': identity.deviceToken
    },
    body: JSON.stringify({ currentSequence })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw Object.assign(new Error('Update broker rejected the request'), { code: payload.code || 'UPDATE_CHECK_FAILED' });
  }
  if (!payload.updateAvailable) return { updateAvailable: false, serverTime: payload.serverTime };

  const manifest = payload.manifest;
  verifyReleaseManifest(trustBundle, manifest, {
    currentSequence,
    allowedChannels: channel === 'pilot' ? ['pilot', 'stable'] : ['stable']
  });
  if (Number(payload.releaseSequence) !== manifest.release_sequence
      || Number(payload.minimumSequence) !== manifest.minimum_sequence) {
    throw Object.assign(new Error('Update broker metadata does not match the signed manifest'), { code: 'UPDATE_BROKER_MISMATCH' });
  }
  const packageUrl = new URL(payload.packageUrl);
  if (packageUrl.origin !== new URL(configuration.url).origin || payload.packageUrlExpiresIn > 300) {
    throw Object.assign(new Error('Update package URL is not trusted'), { code: 'UPDATE_URL_REJECTED' });
  }

  await fsp.mkdir(incoming, { recursive: true });
  const temporary = path.join(incoming, 'package.zip.download');
  const finalPackage = path.join(incoming, 'package.zip');
  await fsp.rm(temporary, { force: true });
  const download = await fetch(packageUrl, { cache: 'no-store', signal: AbortSignal.timeout(300000) });
  if (!download.ok || !download.body) throw new Error('Update package download failed');
  const announced = Number(download.headers.get('content-length') || 0);
  if (announced && announced !== manifest.size) throw new Error('Update package size header mismatch');

  let bytes = 0;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > manifest.size) return callback(new Error('Update package exceeds signed size'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(download.body), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (bytes !== manifest.size || hash.digest('hex') !== manifest.sha256) {
    await fsp.rm(temporary, { force: true });
    throw Object.assign(new Error('Update package hash or size mismatch'), { code: 'UPDATE_PACKAGE_MISMATCH' });
  }
  await fsp.rm(finalPackage, { force: true });
  await fsp.rename(temporary, finalPackage);
  await atomicJson(path.join(incoming, 'manifest.json'), manifest);
  await atomicJson(path.join(incoming, 'ready.json'), {
    schemaVersion: 1,
    releaseSequence: manifest.release_sequence,
    packageFile: 'package.zip',
    manifestFile: 'manifest.json',
    stagedAt: new Date().toISOString()
  });
  return { updateAvailable: true, staged: true, releaseSequence: manifest.release_sequence, version: manifest.version };
}

run().then((result) => {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.staged ? 10 : 0;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'SIGNED_UPDATE_FAILED' }) + '\n');
  process.exitCode = 2;
});
