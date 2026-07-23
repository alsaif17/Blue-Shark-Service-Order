'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function assertTestKey() {
  const value = String(process.env.BLUE_SHARK_TEST_SECURE_STORE_KEY || '');
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw Object.assign(new Error('Secure storage requires Windows DPAPI'), { code: 'SECURE_STORE_UNAVAILABLE' });
  }
  return Buffer.from(value, 'hex');
}

function runDpapi(operation, value, entropy) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    '$inputValue=[Console]::In.ReadToEnd().Trim()',
    '$bytes=[Convert]::FromBase64String($inputValue)',
    `$entropy=[Convert]::FromBase64String('${entropy.toString('base64')}')`,
    `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))'
  ].join(';');
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) {
    throw Object.assign(new Error('Windows DPAPI operation failed'), {
      code: 'DPAPI_FAILED',
      cause: result.error || String(result.stderr || '').trim()
    });
  }
  return Buffer.from(String(result.stdout).trim(), 'base64');
}

function protectForTests(value, entropy) {
  const key = assertTestKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(entropy);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  }), 'utf8');
}

function unprotectForTests(value, entropy) {
  const key = assertTestKey();
  const envelope = JSON.parse(value.toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(entropy);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
}

async function atomicWrite(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, value, { mode: 0o600 });
  try {
    await fsp.rename(temporary, filePath);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await fsp.rm(filePath, { force: true });
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

class SecureStore {
  constructor(root, namespace = 'blue-shark-cloud') {
    this.root = path.resolve(root);
    this.entropy = crypto.createHash('sha256').update(namespace, 'utf8').digest();
  }

  filePath(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(String(name || ''))) {
      throw Object.assign(new Error('Invalid secure-store key'), { code: 'INVALID_SECURE_STORE_KEY' });
    }
    return path.join(this.root, `${name}.protected`);
  }

  protect(value) {
    const plain = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (process.platform === 'win32' && process.env.BLUE_SHARK_FORCE_TEST_SECURE_STORE !== '1') {
      return runDpapi('Protect', plain, this.entropy);
    }
    return protectForTests(plain, this.entropy);
  }

  unprotect(value) {
    if (process.platform === 'win32' && process.env.BLUE_SHARK_FORCE_TEST_SECURE_STORE !== '1') {
      return runDpapi('Unprotect', value, this.entropy);
    }
    return unprotectForTests(value, this.entropy);
  }

  async set(name, value) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    await atomicWrite(this.filePath(name), this.protect(payload));
  }

  async get(name) {
    try {
      const protectedValue = await fsp.readFile(this.filePath(name));
      return JSON.parse(this.unprotect(protectedValue).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(name) {
    await fsp.rm(this.filePath(name), { force: true });
  }

  async getOrCreateBytes(name, size = 32) {
    const existing = await this.get(name);
    if (existing && typeof existing.value === 'string') return Buffer.from(existing.value, 'base64');
    const value = crypto.randomBytes(size);
    await this.set(name, { value: value.toString('base64') });
    return value;
  }
}

module.exports = { SecureStore };
