'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { encrypt, decrypt } = require('../../tools/Backup_Cipher');

test('backup encryption round-trips and rejects the wrong passphrase', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-backup-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.tar');
  const encrypted = path.join(root, 'backup.bsbak');
  const output = path.join(root, 'output.tar');
  fs.writeFileSync(input, Buffer.concat([Buffer.from('backup-sentinel:'), Buffer.alloc(131072, 7)]));
  await encrypt(input, encrypted, 'correct horse battery staple');
  assert.equal(fs.readFileSync(encrypted).includes(Buffer.from('backup-sentinel:')), false);
  await decrypt(encrypted, output, 'correct horse battery staple');
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input));
  await assert.rejects(() => decrypt(encrypted, path.join(root, 'wrong.tar'), 'this is definitely wrong!'));
});
