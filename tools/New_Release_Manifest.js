'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const packageFile = path.resolve(arg('--package', ''));
const output = path.resolve(arg('--output', ''));
const sequence = Number(arg('--sequence', ''));
const version = String(arg('--version', ''));
const channel = String(arg('--channel', 'stable'));
const minimum = Number(arg('--minimum-sequence', '0'));
const keyId = String(arg('--signing-key-id', ''));
if (!fs.existsSync(packageFile) || !output || !Number.isSafeInteger(sequence) || sequence < 1
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    || !['pilot', 'stable'].includes(channel) || !Number.isSafeInteger(minimum) || minimum < 0
    || !/^[A-Za-z0-9._-]{3,80}$/.test(keyId)) {
  process.stderr.write('Invalid release manifest arguments\n');
  process.exit(2);
}
const bytes = fs.readFileSync(packageFile);
const manifest = {
  schema_version: 1,
  release_sequence: sequence,
  version,
  channel,
  minimum_sequence: minimum,
  package_path: channel + '/' + sequence + '/package.zip',
  size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  published_at: new Date().toISOString(),
  rollout_cohort: arg('--rollout-cohort', 'all'),
  mandatory_after: arg('--mandatory-after', null),
  signing_key_id: keyId
};
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
process.stdout.write(JSON.stringify({ output, sequence, sha256: manifest.sha256 }) + '\n');
