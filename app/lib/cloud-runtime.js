'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { SecureStore } = require('./secure-store');
const { EncryptedUserStore } = require('./encrypted-user-store');

const OFFLINE_TRUST_MS = 24 * 60 * 60 * 1000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60 * 1000;

function loadCloudConfiguration(appRoot) {
  const filePath = path.join(appRoot, 'config', 'cloud.json');
  let file = {};
  if (fs.existsSync(filePath)) {
    file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const url = String(process.env.BLUE_SHARK_SUPABASE_URL || file.supabaseUrl || '').trim().replace(/\/$/, '');
  const publishableKey = String(
    process.env.BLUE_SHARK_SUPABASE_PUBLISHABLE_KEY || file.supabasePublishableKey || ''
  ).trim();
  const required = process.env.BLUE_SHARK_REQUIRE_CLOUD === '1' || file.requireCloud === true;
  const enabled = Boolean(url && publishableKey);

  if (required && !enabled) {
    throw Object.assign(new Error('Central database configuration is required'), { code: 'CLOUD_CONFIGURATION_REQUIRED' });
  }
  if (!enabled) return { enabled: false, required, filePath };
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url)) {
    throw Object.assign(new Error('Supabase URL must use HTTPS'), { code: 'INVALID_CLOUD_URL' });
  }
  if (publishableKey.startsWith('sb_secret_') || jwtRole(publishableKey) === 'service_role') {
    throw Object.assign(new Error('A secret or service-role key must never be installed on a workstation'), {
      code: 'FORBIDDEN_CLOUD_KEY'
    });
  }
  return { enabled: true, required, filePath, url, publishableKey };
}

function jwtRole(value) {
  try {
    const parts = String(value).split('.');
    if (parts.length !== 3) return '';
    return String(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || '');
  } catch {
    return '';
  }
}

function cloudError(error, fallbackCode = 'CLOUD_REQUEST_FAILED') {
  if (error?.code && /^[A-Z][A-Z0-9_]+$/.test(error.code)) return error;
  const message = String(error?.message || error || 'Cloud request failed');
  const code = String(error?.code || fallbackCode).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return Object.assign(new Error(message), {
    code: code || fallbackCode,
    status: Number(error?.status || error?.context?.status || 0) || undefined,
    cause: error
  });
}

function isNetworkFailure(error) {
  const message = String(error?.message || error?.cause?.message || '').toLowerCase();
  return !error?.status && (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econn') ||
    message.includes('enotfound') ||
    message.includes('offline')
  );
}

function publicStatus(status, mode = 'online') {
  if (!status) return { authenticated: false, mode };
  return {
    authenticated: true,
    mode,
    userId: status.userId,
    username: status.username,
    displayName: status.displayName,
    systemAdmin: Boolean(status.systemAdmin),
    mfaVerified: Boolean(status.mfaVerified),
    deviceId: status.deviceId,
    deviceState: status.deviceState,
    memberships: Array.isArray(status.memberships) ? status.memberships : [],
    lastServerAt: status.lastServerAt || null,
    serverTime: status.serverTime || null,
    offlineExpiresAt: status.lastServerAt
      ? new Date(new Date(status.lastServerAt).getTime() + OFFLINE_TRUST_MS).toISOString()
      : null,
    canFinalize: mode === 'online' && status.deviceState === 'approved'
  };
}

class CloudRuntime {
  constructor(appRoot, dataRoot) {
    this.appRoot = path.resolve(appRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.configuration = loadCloudConfiguration(this.appRoot);
    this.secureStore = new SecureStore(path.join(this.dataRoot, 'protected'));
    this.userStore = null;
    this.client = null;
    this.identity = null;
    this.session = null;
    this.lastStatus = null;
    this.clockRollback = false;
    this.persistenceTask = Promise.resolve();
  }

  get enabled() {
    return this.configuration.enabled;
  }

  async initialize() {
    if (!this.enabled) return this;
    await this.checkClock();
    this.identity = await this.secureStore.get('device-identity');
    if (!this.identity) {
      this.identity = {
        deviceId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
        deviceToken: crypto.randomBytes(32).toString('base64url'),
        createdAt: new Date().toISOString()
      };
      await this.secureStore.set('device-identity', this.identity);
    }

    this.client = createClient(this.configuration.url, this.configuration.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false
      },
      global: {
        headers: this.deviceHeaders()
      }
    });
    this.client.auth.onAuthStateChange((event, session) => {
      this.session = session || null;
      this.persistenceTask = this.persistenceTask
        .then(async () => {
          if (session) await this.secureStore.set('supabase-session', session);
          else await this.secureStore.delete('supabase-session');
        })
        .catch(() => {});
    });

    const storedSession = await this.secureStore.get('supabase-session');
    if (storedSession?.access_token && storedSession?.refresh_token) {
      this.session = storedSession;
      await this.openUserStore(storedSession.user?.id);
      const restored = await this.client.auth.setSession({
        access_token: storedSession.access_token,
        refresh_token: storedSession.refresh_token
      });
      if (!restored.error && restored.data.session) this.session = restored.data.session;
    }
    return this;
  }

  deviceHeaders() {
    return {
      'x-device-id': this.identity?.deviceId || '',
      'x-device-token': this.identity?.deviceToken || ''
    };
  }

  async checkClock() {
    const now = Date.now();
    const state = await this.secureStore.get('clock-state');
    this.clockRollback = Boolean(
      state?.lastWallClockMs && now + CLOCK_ROLLBACK_TOLERANCE_MS < Number(state.lastWallClockMs)
    );
    await this.secureStore.set('clock-state', {
      lastWallClockMs: Math.max(now, Number(state?.lastWallClockMs || 0)),
      observedAt: new Date().toISOString()
    });
  }

  async recordClock(serverTime) {
    const now = Date.now();
    this.clockRollback = false;
    await this.secureStore.set('clock-state', {
      lastWallClockMs: now,
      lastServerTime: serverTime || new Date(now).toISOString(),
      observedAt: new Date(now).toISOString()
    });
  }

  async openUserStore(userId) {
    if (!userId) return;
    if (this.userStore?.userId === String(userId).toLowerCase()) return;
    if (this.userStore) this.userStore.close();
    this.userStore = new EncryptedUserStore(path.join(this.dataRoot, 'users'), userId, this.secureStore);
    await this.userStore.open();
    this.lastStatus = this.userStore.getJson('cloud-state', 'status', { allowExpired: true })?.value || null;
  }

  requireClient() {
    if (!this.enabled || !this.client) {
      throw Object.assign(new Error('Central database is not configured'), { code: 'CLOUD_DISABLED' });
    }
  }

  requireSession() {
    this.requireClient();
    if (!this.session?.user?.id) {
      throw Object.assign(new Error('Sign-in is required'), { code: 'AUTH_REQUIRED', status: 401 });
    }
  }

  async signIn(email, password) {
    this.requireClient();
    if (!email || !password) throw Object.assign(new Error('Credentials are required'), { code: 'INVALID_CREDENTIALS' });
    const { data, error } = await this.client.auth.signInWithPassword({ email: String(email).trim(), password: String(password) });
    if (error || !data.session?.user?.id) throw cloudError(error, 'INVALID_CREDENTIALS');
    this.session = data.session;
    await this.openUserStore(data.session.user.id);
    const { data: device, error: registrationError } = await this.client.rpc('register_device', {
      p_device_id: this.identity.deviceId,
      p_installation_id: this.identity.installationId,
      p_machine_label: `${os.hostname()} / ${process.env.USERDOMAIN || '.'}\\${process.env.USERNAME || os.userInfo().username}`,
      p_device_token: this.identity.deviceToken
    });
    if (registrationError) {
      await this.signOut();
      throw cloudError(registrationError, 'DEVICE_REGISTRATION_FAILED');
    }
    const status = await this.fetchOnlineStatus();
    return { ...publicStatus(status), registration: device };
  }


  async listMfaFactors() {
    this.requireSession();
    const { data, error } = await this.client.auth.mfa.listFactors();
    if (error) throw cloudError(error, 'MFA_LIST_FAILED');
    return {
      all: Array.isArray(data?.all) ? data.all.map((factor) => ({
        id: factor.id,
        type: factor.factor_type,
        status: factor.status,
        friendlyName: factor.friendly_name || ''
      })) : [],
      currentLevel: (await this.client.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel || 'aal1'
    };
  }

  async enrollMfa(friendlyName) {
    this.requireSession();
    const { data, error } = await this.client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: String(friendlyName || 'Blue Shark administrator').slice(0, 100)
    });
    if (error || !data?.id || !data?.totp) throw cloudError(error || new Error('Invalid MFA enrollment'), 'MFA_ENROLL_FAILED');
    return {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri
    };
  }

  async verifyMfa(factorId, code) {
    this.requireSession();
    const { data, error } = await this.client.auth.mfa.challengeAndVerify({
      factorId,
      code: String(code || '').replace(/\D/g, '')
    });
    if (error) throw cloudError(error, 'MFA_VERIFY_FAILED');
    const current = await this.client.auth.getSession();
    if (current.data?.session) this.session = current.data.session;
    return { verified: true, sessionId: data?.session?.access_token ? 'refreshed' : 'active' };
  }
  async signOut() {
    if (this.client) {
      await this.client.auth.signOut({ scope: 'global' }).catch(() => {});
      await this.client.auth.signOut({ scope: 'local' }).catch(() => {});
    }
    await this.persistenceTask.catch(() => {});
    await this.secureStore.delete('supabase-session');
    this.session = null;
    this.lastStatus = null;
    if (this.userStore) this.userStore.close();
    this.userStore = null;
  }

  async fetchOnlineStatus() {
    this.requireSession();
    const { data, error } = await this.client.rpc('session_status');
    if (error) throw cloudError(error, 'SESSION_STATUS_FAILED');
    const status = { ...data, lastServerAt: data.serverTime || data.lastServerAt };
    this.lastStatus = status;
    await this.openUserStore(status.userId);
    this.userStore.putJson('cloud-state', 'status', status);
    await this.recordClock(status.serverTime);
    return status;
  }

  offlineStatus() {
    if (!this.lastStatus || this.lastStatus.deviceState !== 'approved') return null;
    const verified = new Date(this.lastStatus.lastServerAt || 0).getTime();
    if (!Number.isFinite(verified) || Date.now() - verified > OFFLINE_TRUST_MS || this.clockRollback) return null;
    return this.lastStatus;
  }

  async status(options = {}) {
    if (!this.enabled) return { authenticated: false, mode: 'legacy', cloudRequired: this.configuration.required };
    if (!this.session?.user?.id) return { authenticated: false, mode: 'online', cloudRequired: this.configuration.required };
    try {
      return publicStatus(await this.fetchOnlineStatus(), 'online');
    } catch (error) {
      if (options.allowOffline !== false && isNetworkFailure(error)) {
        const cached = this.offlineStatus();
        if (cached) return publicStatus(cached, 'offline');
      }
      if (isNetworkFailure(error)) {
        return {
          authenticated: true,
          mode: 'locked',
          userId: this.session.user.id,
          deviceId: this.identity.deviceId,
          deviceState: this.lastStatus?.deviceState || 'unknown',
          reason: this.clockRollback ? 'CLOCK_ROLLBACK_DETECTED' : 'OFFLINE_TRUST_EXPIRED',
          canFinalize: false
        };
      }
      throw error;
    }
  }

  async callRpc(name, parameters) {
    this.requireSession();
    const { data, error } = await this.client.rpc(name, parameters);
    if (error) throw cloudError(error);
    const now = new Date().toISOString();
    if (this.lastStatus) {
      this.lastStatus = { ...this.lastStatus, lastServerAt: now, serverTime: now };
      this.userStore?.putJson('cloud-state', 'status', this.lastStatus);
    }
    await this.recordClock(now);
    return data;
  }

  async listBranches() {
    return this.callRpc('list_branches', {});
  }

  async adminListDevices() {
    return this.callRpc('admin_list_devices', {});
  }

  async approveDevice(deviceId) {
    return this.callRpc('approve_device', { p_device_id: deviceId });
  }

  async revokeDevice(deviceId, reason) {
    return this.callRpc('revoke_device', { p_device_id: deviceId, p_reason: reason });
  }

  async adminListUsers() {
    return this.callRpc('admin_list_users', {});
  }

  async adminUpsertBranch(branchId, code, name, phone, active) {
    return this.callRpc('admin_upsert_branch', {
      p_branch_id: branchId,
      p_code: code,
      p_name: name,
      p_phone_e164: phone,
      p_active: active
    });
  }

  async adminRevokeSessions(userId, reason) {
    return this.callRpc('admin_revoke_sessions', { p_user_id: userId, p_reason: reason });
  }
  async adminSetReleasePublisher(userId, active) {
    return this.callRpc('admin_set_release_publisher', { p_user_id: userId, p_active: active });
  }


  async adminUserOperation(payload) {
    this.requireSession();
    const { data, error } = await this.client.functions.invoke('admin-users', {
      body: payload,
      headers: this.deviceHeaders()
    });
    if (error || !data?.ok) throw cloudError(error || new Error('Administrative user operation failed'), 'ADMIN_OPERATION_DENIED');
    return data;
  }

  async listOrders(beforeId = null, limit = 100) {
    const data = await this.callRpc('list_orders', { p_before_id: beforeId, p_limit: limit });
    this.userStore?.putJson('cache', 'orders', data);
    return data;
  }

  async getOrder(orderId) {
    const data = await this.callRpc('get_order', { p_order_id: orderId });
    this.userStore?.putJson('order', orderId, data);
    return data;
  }

  async finalizeOrder(commandId, branchId, draft, expectedVersion = 0) {
    return this.callRpc('finalize_order', {
      p_command_id: commandId,
      p_branch_id: branchId,
      p_draft: draft,
      p_expected_version: expectedVersion
    });
  }

  async completeDocument(commandId, orderId, objectPath, sha256, sizeBytes, expectedVersion = 0) {
    return this.callRpc('complete_document', {
      p_command_id: commandId,
      p_order_id: orderId,
      p_object_path: objectPath,
      p_sha256: sha256,
      p_size_bytes: sizeBytes,
      p_expected_version: expectedVersion
    });
  }

  async uploadDocument(orderId, pdfBuffer, commandId = crypto.randomUUID(), expectedVersion = 1) {
    this.requireSession();
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const { data: broker, error: brokerError } = await this.client.functions.invoke('storage-broker', {
      body: { orderId, operation: 'upload', sha256 },
      headers: this.deviceHeaders()
    });
    if (brokerError || !broker?.token || !broker?.objectPath) {
      throw cloudError(brokerError || new Error('Storage broker returned an invalid upload grant'), 'STORAGE_GRANT_FAILED');
    }
    const { error: uploadError } = await this.client.storage
      .from(broker.bucket)
      .uploadToSignedUrl(broker.objectPath, broker.token, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false
      });
    const uploadConflict = Number(uploadError?.statusCode || uploadError?.status || 0) === 409;
    if (uploadError && !uploadConflict) throw cloudError(uploadError, 'DOCUMENT_UPLOAD_FAILED');
    const result = await this.completeDocument(commandId, orderId, broker.objectPath, sha256, pdfBuffer.length, expectedVersion);
    this.userStore?.putBuffer('document', orderId, pdfBuffer);
    return { ...result, sha256, objectPath: broker.objectPath };
  }

  async downloadDocument(orderId) {
    this.requireSession();
    const { data: broker, error } = await this.client.functions.invoke('storage-broker', {
      body: { orderId, operation: 'download' },
      headers: this.deviceHeaders()
    });
    if (error || !broker?.signedUrl) throw cloudError(error || new Error('Invalid download grant'), 'STORAGE_GRANT_FAILED');
    const response = await fetch(broker.signedUrl, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Object.assign(new Error('Document download failed'), { code: 'DOCUMENT_DOWNLOAD_FAILED', status: response.status });
    const value = Buffer.from(await response.arrayBuffer());
    this.userStore?.putBuffer('document', orderId, value);
    return value;
  }

  async recordAction(commandId, orderId, actionId, channel, targetStatus, receipt, expectedVersion) {
    return this.callRpc('record_action', {
      p_command_id: commandId,
      p_order_id: orderId,
      p_action_id: actionId,
      p_channel: channel,
      p_target_status: targetStatus,
      p_receipt: receipt || {},
      p_expected_version: expectedVersion
    });
  }

  async syncChanges(afterEventId = 0, limit = 500) {
    const data = await this.callRpc('sync_changes', { p_after_event_id: afterEventId, p_limit: limit });
    this.userStore?.putJson('cloud-state', 'sync', data);
    return data;
  }

  async syncFromCursor(limit = 500) {
    this.requireSession();
    const state = this.userStore?.getJson('cloud-state', 'sync-cursor')?.value || {};
    const afterEventId = Number(state.afterEventId || 0);
    const data = await this.syncChanges(afterEventId, limit);
    const nextEventId = Number(data?.nextEventId ?? data?.next_event_id ?? afterEventId);
    if (Number.isSafeInteger(nextEventId) && nextEventId >= afterEventId) {
      this.userStore?.putJson('cloud-state', 'sync-cursor', { afterEventId: nextEventId });
    }
    return data;
  }

  saveDraft(value) {
    this.requireSession();
    this.userStore.saveDraft(value);
  }

  loadDraft() {
    this.requireSession();
    return this.userStore.loadDraft();
  }

  deleteDraft() {
    this.requireSession();
    this.userStore.deleteDraft();
  }

  getCachedDocument(orderId) {
    this.requireSession();
    return this.userStore.getBuffer('document', orderId)?.value || null;
  }

  cacheDocument(orderId, value) {
    this.requireSession();
    this.userStore.putBuffer('document', orderId, value);
  }

  queueRecovery(commandId, value) {
    this.requireSession();
    this.userStore.enqueue(commandId, value);
  }

  async drainOutbox(limit = 100) {
    this.requireSession();
    const rows = this.userStore.listOutbox(limit);
    const results = [];
    for (const row of rows) {
      try {
        if (row.value?.operation !== 'action-transition') {
          throw Object.assign(new Error('Unknown outbox operation'), { code: 'UNKNOWN_OUTBOX_OPERATION' });
        }
        const value = row.value;
        const result = await this.recordAction(
          row.id,
          value.orderId,
          value.actionId,
          value.channel,
          value.targetStatus,
          value.receipt,
          value.expectedVersion
        );
        this.userStore.acknowledge(row.id);
        results.push({ commandId: row.id, ok: true, result });
      } catch (error) {
        results.push({ commandId: row.id, ok: false, code: error.code || 'CLOUD_REQUEST_FAILED' });
        if (isNetworkFailure(error)) break;
      }
    }
    return results;
  }

  close() {
    if (this.userStore) this.userStore.close();
    this.userStore = null;
  }
}

module.exports = {
  CloudRuntime,
  OFFLINE_TRUST_MS,
  loadCloudConfiguration,
  isNetworkFailure,
  publicStatus
};
