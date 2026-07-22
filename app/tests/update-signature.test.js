'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  canonicalize,
  withoutSignature,
  verifyTrustBundle,
  verifyReleaseManifest
} = require('../lib/update-signature');

function keyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function publicPem(key) {
  return key.export({ type: 'spki', format: 'pem' });
}

function sign(privateKey, value) {
  return crypto.sign('sha256', Buffer.from(canonicalize(value)), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
}

function fixture() {
  const root = keyPair();
  const release = keyPair();
  const unsignedBundle = {
    schema_version: 1,
    release_keys: [{
      key_id: 'release-test',
      status: 'active',
      public_key_pem: publicPem(release.publicKey),
      not_before: '2026-01-01T00:00:00.000Z',
      not_after: '2027-01-01T00:00:00.000Z'
    }]
  };
  const bundle = { ...unsignedBundle, signature: sign(root.privateKey, unsignedBundle) };
  const unsignedManifest = {
    schema_version: 1,
    release_sequence: 42,
    version: '1.4.0',
    channel: 'stable',
    minimum_sequence: 38,
    package_path: 'stable/42/package.zip',
    size: 65245298,
    sha256: 'a'.repeat(64),
    published_at: '2026-07-22T10:00:00.000Z',
    rollout_cohort: 'all',
    mandatory_after: null,
    signing_key_id: 'release-test'
  };
  const manifest = { ...unsignedManifest, signature: sign(release.privateKey, unsignedManifest) };
  return { root, release, bundle, manifest };
}

test('root signature and release signature verify with canonical key ordering', () => {
  const value = fixture();
  verifyTrustBundle(publicPem(value.root.publicKey), value.bundle, new Date('2026-07-22T11:00:00Z'));
  assert.equal(
    verifyReleaseManifest(value.bundle, value.manifest, {
      currentSequence: 41,
      allowedChannels: ['stable'],
      now: new Date('2026-07-22T11:00:00Z')
    }).release_sequence,
    42
  );
});

test('modified package metadata, rollback, wrong channel, and revoked key are rejected', () => {
  const value = fixture();
  assert.throws(() => verifyReleaseManifest(value.bundle, { ...value.manifest, size: 1 }, {
    currentSequence: 41, now: new Date('2026-07-22T11:00:00Z')
  }), /signature/i);
  assert.throws(() => verifyReleaseManifest(value.bundle, value.manifest, {
    currentSequence: 42, now: new Date('2026-07-22T11:00:00Z')
  }), /newer/i);
  assert.throws(() => verifyReleaseManifest(value.bundle, value.manifest, {
    currentSequence: 41, allowedChannels: ['pilot'], now: new Date('2026-07-22T11:00:00Z')
  }), /channel/i);
  const revoked = { ...value.bundle, release_keys: value.bundle.release_keys.map((key) => ({ ...key, status: 'revoked' })) };
  assert.throws(() => verifyReleaseManifest(revoked, value.manifest, {
    currentSequence: 41, now: new Date('2026-07-22T11:00:00Z')
  }), /revoked/i);
});

test('trust bundle replacement and unknown manifest fields are rejected', () => {
  const value = fixture();
  const attacker = keyPair();
  assert.throws(() => verifyTrustBundle(publicPem(attacker.publicKey), value.bundle), /root signature/i);
  assert.throws(() => verifyReleaseManifest(value.bundle, { ...value.manifest, download_url: 'https://attacker.invalid' }, {
    currentSequence: 41, now: new Date('2026-07-22T11:00:00Z')
  }), /unknown manifest field/i);
});

test('canonical JSON is deterministic for supported release values', () => {
  assert.equal(canonicalize({ z: 1, a: ['x', true, null] }), '{"a":["x",true,null],"z":1}');
});

test('offline trust tool adds a P-256 release key and revokes the previous key', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-trust-'));
  const passphrase = 'correct horse battery staple';
  try {
    const root = keyPair();
    const previous = keyPair();
    const next = keyPair();
    const unsigned = {
      schema_version: 1,
      release_keys: [{
        key_id: 'release-previous',
        status: 'active',
        public_key_pem: publicPem(previous.publicKey),
        not_before: '2026-01-01T00:00:00.000Z',
        not_after: '2027-01-01T00:00:00.000Z'
      }]
    };
    const bundle = { ...unsigned, signature: sign(root.privateKey, unsigned) };
    const bundlePath = path.join(temporary, 'trusted-keys.json');
    const rootPrivatePath = path.join(temporary, 'root-private-key.pem');
    const nextPublicPath = path.join(temporary, 'next-public-key.pem');
    const outputPath = path.join(temporary, 'trusted-keys-next.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    fs.writeFileSync(rootPrivatePath, root.privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase
    }));
    fs.writeFileSync(nextPublicPath, publicPem(next.publicKey));

    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', '..', 'tools', 'Manage_Trusted_Keys.js'),
      '--bundle', bundlePath,
      '--root-private-key', rootPrivatePath,
      '--output', outputPath,
      '--revoke', 'release-previous',
      '--add-public-key', nextPublicPath,
      '--key-id', 'release-next',
      '--not-before', '2026-07-22T00:00:00.000Z',
      '--not-after', '2027-07-22T00:00:00.000Z'
    ], {
      env: { ...process.env, BLUE_SHARK_SIGNING_KEY_PASSPHRASE: passphrase },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const updated = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    verifyTrustBundle(publicPem(root.publicKey), updated);
    assert.equal(updated.release_keys.find((key) => key.key_id === 'release-previous').status, 'revoked');
    assert.equal(updated.release_keys.find((key) => key.key_id === 'release-next').status, 'active');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
