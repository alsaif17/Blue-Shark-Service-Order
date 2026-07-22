'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('BSBAK002');
const HEADER_BYTES = MAGIC.length + 16 + 12;
const TAG_BYTES = 16;

async function encrypt(input, output, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const temporary = output + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(temporary, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
    await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    await fsp.appendFile(temporary, cipher.getAuthTag());
    await fsp.rename(temporary, output);
  } finally {
    key.fill(0);
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function decrypt(input, output, passphrase) {
  const stat = await fsp.stat(input);
  if (stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error('Encrypted backup is too small');
  const handle = await fsp.open(input, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted backup format is invalid');
  const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = header.subarray(MAGIC.length + 16);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const temporary = output + '.' + process.pid + '.tmp';
  try {
    await pipeline(
      fs.createReadStream(input, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    );
    await fsp.rename(temporary, output);
  } finally {
    key.fill(0);
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function main() {
  const [mode, input, output] = process.argv.slice(2);
  const passphrase = String(process.env.BLUE_SHARK_BACKUP_PASSPHRASE || '');
  if (!['encrypt', 'decrypt'].includes(mode) || !input || !output || passphrase.length < 20) {
    throw new Error('Usage: Backup_Cipher.js encrypt|decrypt <input> <output>; passphrase must be at least 20 characters');
  }
  if (mode === 'encrypt') await encrypt(input, output, passphrase);
  else await decrypt(input, output, passphrase);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { encrypt, decrypt };
