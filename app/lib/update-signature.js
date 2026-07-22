'use strict';

const crypto = require('crypto');

const MANIFEST_FIELDS = new Set([
  'schema_version',
  'release_sequence',
  'version',
  'channel',
  'minimum_sequence',
  'package_path',
  'size',
  'sha256',
  'published_at',
  'rollout_cohort',
  'mandatory_after',
  'signing_key_id',
  'signature'
]);

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new TypeError('Only safe integer numbers are allowed');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Only plain JSON values are allowed');
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function verifyEcdsa(publicKeyPem, payload, signature) {
  if (!/^-----BEGIN PUBLIC KEY-----/.test(String(publicKeyPem || ''))) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(signature || ''))) return false;
  return crypto.verify(
    'sha256',
    Buffer.from(canonicalize(payload), 'utf8'),
    { key: publicKeyPem, dsaEncoding: 'der' },
    Buffer.from(signature, 'base64')
  );
}

function verifyTrustBundle(rootPublicKeyPem, bundle, now = new Date()) {
  if (!bundle || bundle.schema_version !== 1 || !Array.isArray(bundle.release_keys)) {
    throw Object.assign(new Error('Invalid trusted key bundle'), { code: 'INVALID_TRUST_BUNDLE' });
  }
  if (!verifyEcdsa(rootPublicKeyPem, withoutSignature(bundle), bundle.signature)) {
    throw Object.assign(new Error('Root signature on trusted key bundle is invalid'), { code: 'INVALID_ROOT_SIGNATURE' });
  }
  const ids = new Set();
  for (const key of bundle.release_keys) {
    if (!/^[A-Za-z0-9._-]{3,80}$/.test(String(key?.key_id || '')) || ids.has(key.key_id)) {
      throw Object.assign(new Error('Trusted key identifiers are invalid'), { code: 'INVALID_TRUST_BUNDLE' });
    }
    ids.add(key.key_id);
    if (!['active', 'revoked'].includes(key.status)) {
      throw Object.assign(new Error('Trusted key status is invalid'), { code: 'INVALID_TRUST_BUNDLE' });
    }
    if (!/^-----BEGIN PUBLIC KEY-----/.test(String(key.public_key_pem || ''))) {
      throw Object.assign(new Error('Trusted release public key is invalid'), { code: 'INVALID_TRUST_BUNDLE' });
    }
    if (key.not_before && Number.isNaN(Date.parse(key.not_before))) throw new Error('Invalid key not_before');
    if (key.not_after && Number.isNaN(Date.parse(key.not_after))) throw new Error('Invalid key not_after');
  }
  if (Number.isNaN(now.getTime())) throw new TypeError('Invalid verification time');
  return bundle;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be an object');
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) throw Object.assign(new Error('Unknown manifest field'), { code: 'UNKNOWN_MANIFEST_FIELD' });
  }
  if (manifest.schema_version !== 1
      || !Number.isSafeInteger(manifest.release_sequence) || manifest.release_sequence < 1
      || !Number.isSafeInteger(manifest.minimum_sequence) || manifest.minimum_sequence < 0
      || manifest.minimum_sequence > manifest.release_sequence
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))
      || !['pilot', 'stable'].includes(manifest.channel)
      || !/^(pilot|stable)\/[1-9][0-9]*\/package\.zip$/.test(manifest.package_path)
      || !String(manifest.package_path).startsWith(manifest.channel + '/')
      || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 157286400
      || !/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ''))
      || Number.isNaN(Date.parse(manifest.published_at))
      || !/^[A-Za-z0-9._-]{1,80}$/.test(String(manifest.rollout_cohort || ''))
      || (manifest.mandatory_after !== null && manifest.mandatory_after !== '' && Number.isNaN(Date.parse(manifest.mandatory_after)))
      || !/^[A-Za-z0-9._-]{3,80}$/.test(String(manifest.signing_key_id || ''))
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(manifest.signature || ''))) {
    throw Object.assign(new Error('Release manifest is invalid'), { code: 'INVALID_RELEASE_MANIFEST' });
  }
  return manifest;
}

function verifyReleaseManifest(bundle, manifest, options = {}) {
  validateManifest(manifest);
  const now = options.now || new Date();
  const currentSequence = Number(options.currentSequence || 0);
  if (!Number.isSafeInteger(currentSequence) || currentSequence < 0) throw new TypeError('Invalid current sequence');
  if (manifest.release_sequence <= currentSequence) {
    throw Object.assign(new Error('Release sequence is not newer'), { code: 'UPDATE_ROLLBACK_REJECTED' });
  }
  const channels = new Set(options.allowedChannels || ['stable']);
  if (!channels.has(manifest.channel)) throw Object.assign(new Error('Release channel is not allowed'), { code: 'UPDATE_CHANNEL_REJECTED' });
  const key = bundle.release_keys.find((candidate) => candidate.key_id === manifest.signing_key_id);
  if (!key || key.status !== 'active') throw Object.assign(new Error('Release key is unknown or revoked'), { code: 'RELEASE_KEY_REJECTED' });
  const timestamp = now.getTime();
  if ((key.not_before && timestamp < Date.parse(key.not_before)) || (key.not_after && timestamp > Date.parse(key.not_after))) {
    throw Object.assign(new Error('Release key is outside its validity window'), { code: 'RELEASE_KEY_EXPIRED' });
  }
  if (!verifyEcdsa(key.public_key_pem, withoutSignature(manifest), manifest.signature)) {
    throw Object.assign(new Error('Release manifest signature is invalid'), { code: 'INVALID_RELEASE_SIGNATURE' });
  }
  return manifest;
}

module.exports = {
  canonicalize,
  withoutSignature,
  verifyEcdsa,
  verifyTrustBundle,
  validateManifest,
  verifyReleaseManifest
};
