'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function requireUuid(value, label = 'user id') {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw Object.assign(new Error(`Invalid ${label}`), { code: 'INVALID_IDENTIFIER' });
  }
  return normalized;
}

function requireRecordPart(value, label) {
  const normalized = String(value || '');
  if (!normalized || normalized.length > 180 || /[\u0000-\u001f]/.test(normalized)) {
    throw Object.assign(new Error(`Invalid ${label}`), { code: 'INVALID_CACHE_KEY' });
  }
  return normalized;
}

class EncryptedUserStore {
  constructor(root, userId, secureStore) {
    this.userId = requireUuid(userId);
    this.root = path.resolve(root, this.userId);
    this.filePath = path.join(this.root, 'cache.db');
    this.secureStore = secureStore;
    this.database = null;
    this.key = null;
  }

  async open() {
    if (this.database) return this;
    fs.mkdirSync(this.root, { recursive: true });
    this.key = await this.secureStore.getOrCreateBytes(`cache-key-${this.userId}`, 32);
    if (this.key.length !== 32) throw new Error('Invalid cache encryption key');
    this.database = new DatabaseSync(this.filePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS encrypted_records (
        kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (kind, record_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS encrypted_records_expiry_idx
        ON encrypted_records(expires_at) WHERE expires_at IS NOT NULL;
    `);
    return this;
  }

  assertOpen() {
    if (!this.database || !this.key) {
      throw Object.assign(new Error('Encrypted user store is closed'), { code: 'CACHE_CLOSED' });
    }
  }

  aad(kind, recordId) {
    return Buffer.from(`${this.userId}\u0000${kind}\u0000${recordId}`, 'utf8');
  }

  encrypt(kind, recordId, value) {
    this.assertOpen();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(kind, recordId));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return { iv, authTag: cipher.getAuthTag(), ciphertext };
  }

  decrypt(row, kind, recordId) {
    this.assertOpen();
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
    decipher.setAAD(this.aad(kind, recordId));
    decipher.setAuthTag(Buffer.from(row.auth_tag));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
  }

  putBuffer(kindValue, recordIdValue, value, options = {}) {
    const kind = requireRecordPart(kindValue, 'record kind');
    const recordId = requireRecordPart(recordIdValue, 'record id');
    const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const encrypted = this.encrypt(kind, recordId, source);
    const updatedAt = Number.isFinite(options.updatedAt) ? options.updatedAt : Date.now();
    const expiresAt = Number.isFinite(options.expiresAt) ? options.expiresAt : null;
    this.database.prepare(`
      INSERT INTO encrypted_records(kind, record_id, iv, auth_tag, ciphertext, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, record_id) DO UPDATE SET
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(kind, recordId, encrypted.iv, encrypted.authTag, encrypted.ciphertext, updatedAt, expiresAt);
  }

  getBuffer(kindValue, recordIdValue, options = {}) {
    this.assertOpen();
    const kind = requireRecordPart(kindValue, 'record kind');
    const recordId = requireRecordPart(recordIdValue, 'record id');
    const row = this.database.prepare(`
      SELECT iv, auth_tag, ciphertext, updated_at, expires_at
      FROM encrypted_records
      WHERE kind = ? AND record_id = ?
    `).get(kind, recordId);
    if (!row) return null;
    if (!options.allowExpired && row.expires_at !== null && Number(row.expires_at) <= Date.now()) {
      this.delete(kind, recordId);
      return null;
    }
    return {
      value: this.decrypt(row, kind, recordId),
      updatedAt: Number(row.updated_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    };
  }

  putJson(kind, recordId, value, options = {}) {
    this.putBuffer(kind, recordId, Buffer.from(JSON.stringify(value), 'utf8'), options);
  }

  getJson(kind, recordId, options = {}) {
    const row = this.getBuffer(kind, recordId, options);
    if (!row) return null;
    return { ...row, value: JSON.parse(row.value.toString('utf8')) };
  }

  delete(kindValue, recordIdValue) {
    this.assertOpen();
    const kind = requireRecordPart(kindValue, 'record kind');
    const recordId = requireRecordPart(recordIdValue, 'record id');
    this.database.prepare('DELETE FROM encrypted_records WHERE kind = ? AND record_id = ?').run(kind, recordId);
  }

  list(kindValue, options = {}) {
    this.assertOpen();
    const kind = requireRecordPart(kindValue, 'record kind');
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    const rows = this.database.prepare(`
      SELECT record_id, iv, auth_tag, ciphertext, updated_at, expires_at
      FROM encrypted_records
      WHERE kind = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at ASC, record_id ASC
      LIMIT ?
    `).all(kind, Date.now(), limit);
    return rows.map((row) => ({
      id: row.record_id,
      value: JSON.parse(this.decrypt(row, kind, row.record_id).toString('utf8')),
      updatedAt: Number(row.updated_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    }));
  }

  purgeExpired() {
    this.assertOpen();
    return Number(this.database.prepare('DELETE FROM encrypted_records WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now()).changes);
  }

  saveDraft(value) {
    this.putJson('draft', 'active', value);
  }

  loadDraft() {
    return this.getJson('draft', 'active')?.value || null;
  }

  deleteDraft() {
    this.delete('draft', 'active');
  }

  enqueue(commandId, value) {
    this.putJson('outbox', requireUuid(commandId, 'command id'), value);
  }

  listOutbox(limit = 100) {
    return this.list('outbox', { limit });
  }

  acknowledge(commandId) {
    this.delete('outbox', requireUuid(commandId, 'command id'));
  }

  close() {
    if (this.database) this.database.close();
    this.database = null;
    if (this.key) this.key.fill(0);
    this.key = null;
  }
}

module.exports = { EncryptedUserStore, requireUuid };
