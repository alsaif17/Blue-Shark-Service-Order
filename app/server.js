'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync, backup: backupSqliteDatabase } = require('node:sqlite');
const archiver = require('archiver');
const express = require('express');
const { CloudRuntime } = require('./lib/cloud-runtime');
const { createCloudRouter } = require('./lib/cloud-routes');
const APP_VERSION = require('./package.json').version;
const multer = require('multer');
const QRCode = require('qrcode');
const unzipper = require('unzipper');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const APP_ROOT = process.env.BLUE_SHARK_APP_ROOT
  ? path.resolve(process.env.BLUE_SHARK_APP_ROOT)
  : path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORTABLE_DATA_DIR = path.join(APP_ROOT, 'data');
const PROGRAM_FILES_ROOT = process.env.ProgramFiles ? path.resolve(process.env.ProgramFiles) : '';
const INSTALLED_IN_PROGRAM_FILES = Boolean(
  PROGRAM_FILES_ROOT && (APP_ROOT === PROGRAM_FILES_ROOT || APP_ROOT.startsWith(PROGRAM_FILES_ROOT + path.sep))
);
const DATA_DIR = path.resolve(process.env.BLUE_SHARK_DATA_DIR || (
  INSTALLED_IN_PROGRAM_FILES && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'BlueShark', 'data')
    : PORTABLE_DATA_DIR
));
const LEGACY_SESSION_DIR = path.join(DATA_DIR, 'session');
let SESSION_DIR = path.resolve(process.env.BLUE_SHARK_SESSION_DIR || (
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'BlueSharkSender', 'session')
    : LEGACY_SESSION_DIR
));
let SESSION_CACHE_DIR = path.join(path.dirname(SESSION_DIR), 'web-cache');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BACKUP_DIR = path.join(INSTALLED_IN_PROGRAM_FILES ? DATA_DIR : APP_ROOT, 'Backups');
const SENT_DIR = path.join(INSTALLED_IN_PROGRAM_FILES ? DATA_DIR : APP_ROOT, 'Sent Orders');
const SENT_INDEX_PATH = path.join(DATA_DIR, 'sent-orders.json');
const DATABASE_PATH = path.join(DATA_DIR, 'blue-shark.db');
const portArgumentIndex = process.argv.indexOf('--port');
const requestedPort = portArgumentIndex >= 0 ? process.argv[portArgumentIndex + 1] : null;
const parsedPort = Number(requestedPort || process.env.BLUE_SHARK_PORT || process.env.PORT || 32147);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 32147;
const HOST = '127.0.0.1';
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BACKUP_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const BACKUP_FORMAT_VERSION = 1;
const CSRF_TOKEN = crypto.randomBytes(32).toString('hex');
const WHATSAPP_DISABLED = process.env.BLUE_SHARK_DISABLE_WHATSAPP === '1';
const FAKE_WHATSAPP = process.env.BLUE_SHARK_FAKE_WHATSAPP === '1';
const KNOWN_GOOD_WWEB_VERSION = process.env.BLUE_SHARK_WWEB_VERSION || '2.3000.1043735639';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SENT_DIR, { recursive: true });

function hardenDirectoryAcl(directory, resetChildren = false) {
  if (process.platform !== 'win32') return true;
  const directories = (Array.isArray(directory) ? directory : [directory]).filter(Boolean);
  try {
    if (resetChildren) {
      for (const target of directories) {
        execFileSync('icacls.exe', [target, '/reset', '/T', '/C', '/Q'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 120000
        });
      }
    }
    const targets = directories.map((target) => `'${target.replaceAll("'", "''")}'`).join(', ');
    const script = [
      `$targets = @(${targets})`,
      "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
      "$propagation = [System.Security.AccessControl.PropagationFlags]'None'",
      "$allow = [System.Security.AccessControl.AccessControlType]'Allow'",
      "$rights = [System.Security.AccessControl.FileSystemRights]'FullControl'",
      '$sids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User,',
      "  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),",
      "  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
      'foreach ($target in $targets) {',
      '  $acl = New-Object System.Security.AccessControl.DirectorySecurity',
      '  $acl.SetAccessRuleProtection($true, $false)',
      '  foreach ($sid in $sids) {',
      '    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $propagation, $allow)',
      '    [void]$acl.AddAccessRule($rule)',
      '  }',
      '  Set-Acl -LiteralPath $target -AclObject $acl',
      '}'
    ].join('\n');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15000
    });
    return true;
  } catch (error) {
    logEvent('warn', 'acl_hardening_failed', { code: error.code || error.name, target: directories.map((target) => path.basename(target)).join(',') });
    return false;
  }
}

function profileFingerprint(directory) {
  const result = { files: 0, bytes: 0 };
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        result.files += 1;
        result.bytes += stat.size;
      }
    }
  };
  visit(directory);
  return result;
}

function prepareSessionDirectory(options = {}) {
  const allowMigration = options.allowMigration !== false;
  const desiredSessionDir = SESSION_DIR;
  const desiredProfile = path.join(desiredSessionDir, 'session-blue-shark');
  const legacyCandidate = path.join(LEGACY_SESSION_DIR, 'session-blue-shark');
  if (!allowMigration && !fs.existsSync(desiredProfile) && fs.existsSync(legacyCandidate)) {
    SESSION_DIR = LEGACY_SESSION_DIR;
    SESSION_CACHE_DIR = path.join(path.dirname(SESSION_DIR), 'web-cache');
    logEvent('warn', 'session_migration_deferred', { code: 'STALE_BROWSER_CLEANUP_FAILED' });
  }
  const legacyProfile = path.join(LEGACY_SESSION_DIR, 'session-blue-shark');
  const targetProfile = path.join(SESSION_DIR, 'session-blue-shark');
  const sameLocation = path.resolve(LEGACY_SESSION_DIR).toLowerCase() === path.resolve(SESSION_DIR).toLowerCase();
  let migrated = false;

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
  const bundledCache = path.join(__dirname, '.wwebjs_cache', `${KNOWN_GOOD_WWEB_VERSION}.html`);
  const localCache = path.join(SESSION_CACHE_DIR, `${KNOWN_GOOD_WWEB_VERSION}.html`);
  if (!fs.existsSync(localCache) && fs.existsSync(bundledCache)) {
    try {
      fs.copyFileSync(bundledCache, localCache, fs.constants.COPYFILE_EXCL);
      logEvent('info', 'known_good_web_version_seeded');
    } catch (error) {
      if (error.code !== 'EEXIST') logEvent('warn', 'known_good_web_version_seed_failed', { code: error.code || error.name });
    }
  }
  if (!sameLocation && !fs.existsSync(targetProfile) && fs.existsSync(legacyProfile)) {
    try {
      fs.renameSync(legacyProfile, targetProfile);
      migrated = true;
      logEvent('info', 'session_migrated', { method: 'rename' });
    } catch (renameError) {
      const staging = `${targetProfile}.migrating-${process.pid}`;
      try {
        fs.cpSync(legacyProfile, staging, { recursive: true, errorOnExist: true, force: false });
        const source = profileFingerprint(legacyProfile);
        const copied = profileFingerprint(staging);
        if (source.files !== copied.files || source.bytes !== copied.bytes) {
          const mismatch = new Error('SESSION_COPY_VERIFY_FAILED');
          mismatch.code = 'SESSION_COPY_VERIFY_FAILED';
          throw mismatch;
        }
        fs.renameSync(staging, targetProfile);
        migrated = true;
        logEvent('info', 'session_migrated', { method: 'verified_copy' });
      } catch (copyError) {
        logEvent('error', 'session_migration_failed', { code: copyError.code || copyError.name });
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (cleanupError) {}
        SESSION_DIR = LEGACY_SESSION_DIR;
        SESSION_CACHE_DIR = path.join(path.dirname(SESSION_DIR), 'web-cache');
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
        logEvent('warn', 'session_migration_deferred', { code: copyError.code || copyError.name });
      }
    }
  }

  const aclMarker = path.join(SESSION_DIR, '.acl-v2');
  const resetChildren = migrated || !fs.existsSync(aclMarker);
  const aclReady = hardenDirectoryAcl(SESSION_DIR, resetChildren);
  if (aclReady) {
    try { fs.writeFileSync(aclMarker, 'Blue Shark session ACL v2\n', 'utf8'); } catch (error) {}
  } else {
    try { fs.rmSync(aclMarker, { force: true }); } catch (error) {}
  }
}

function stopStaleBrowserProcesses(sessionDirectories = [SESSION_DIR]) {
  if (process.platform !== 'win32') return true;
  const profilePaths = [...new Set(sessionDirectories.map((directory) => path.resolve(directory, 'session-blue-shark').toLowerCase()))];
  const targets = profilePaths.map((profilePath) => `'${profilePath.replaceAll("'", "''")}'`).join(', ');
  const script = [
    `$targets = @(${targets})`,
    'function Get-BlueSharkBrowsers {',
    '  @(Get-CimInstance Win32_Process | Where-Object {',
    '    $process = $_',
    '    $matched = $false',
    "    if (($process.Name -eq 'msedge.exe' -or $process.Name -eq 'chrome.exe') -and $process.CommandLine) {",
    '      foreach ($target in $targets) {',
    '        if ($process.CommandLine.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true; break }',
    '      }',
    '    }',
    '    $matched',
    '  })',
    '}',
    '$matches = @(Get-BlueSharkBrowsers)',
    '$matches | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'if ($matches.Count -gt 0) { Start-Sleep -Milliseconds 400 }',
    '$remaining = @(Get-BlueSharkBrowsers)',
    'if ($remaining.Count -gt 0) { exit 7 }'
  ].join('\n');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10000
    });
    return true;
  } catch (error) {
    logEvent('warn', 'stale_browser_cleanup_failed', { code: error.code || error.name });
    return false;
  }
}

for (const directory of [TEMP_DIR, LOG_DIR, BACKUP_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const logPath = path.join(LOG_DIR, 'app.log');
function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      const previous = `${logPath}.1`;
      if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      fs.renameSync(logPath, previous);
    }
  } catch (error) {
    // Logging must never interrupt sending.
  }
}

function logEvent(level, event, details = {}) {
  rotateLogIfNeeded();
  const safeDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (['phone', 'caption', 'customer', 'pdf', 'qr', 'messageId'].includes(key)) continue;
    safeDetails[key] = String(value).slice(0, 300);
  }
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...safeDetails });
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch (error) {
    // Ignore logging failures.
  }
}

function readRecentErrorLogs(limit = 100) {
  const entries = [];
  for (const file of [`${logPath}.1`, logPath]) {
    if (!fs.existsSync(file)) continue;
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (error) { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (['error', 'warn', 'info'].includes(entry.level)) entries.push(entry);
      } catch (error) {}
    }
  }
  return entries.slice(-Math.max(1, Math.min(Number(limit) || 100, 200))).reverse();
}

hardenDirectoryAcl([DATA_DIR, SENT_DIR]);

function findBrowserExecutables() {
  const bundledRoot = path.join(APP_ROOT, 'runtime', 'browser');
  const bundledCandidates = [];
  if (fs.existsSync(bundledRoot)) {
    const pending = [{ directory: bundledRoot, depth: 0 }];
    while (pending.length) {
      const current = pending.shift();
      let entries = [];
      try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch (error) {}
      for (const entry of entries) {
        const fullPath = path.join(current.directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === 'chrome.exe' && /chrome-win/i.test(fullPath)) {
          bundledCandidates.push(fullPath);
        } else if (entry.isDirectory() && current.depth < 5) {
          pending.push({ directory: fullPath, depth: current.depth + 1 });
        }
      }
    }
  }
  const candidates = [
    process.env.BLUE_SHARK_BROWSER,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(APP_ROOT, 'runtime', 'browser', 'chrome.exe'),
    path.join(APP_ROOT, 'runtime', 'browser', 'chrome-win64', 'chrome.exe'),
    ...bundledCandidates.sort().reverse(),
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

const browserCandidates = WHATSAPP_DISABLED || FAKE_WHATSAPP ? [] : findBrowserExecutables();
let browserCandidateIndex = 0;
let browserExecutable = WHATSAPP_DISABLED ? null : (FAKE_WHATSAPP ? 'fake-whatsapp' : (browserCandidates[0] || null));
const senderState = {
  state: browserExecutable ? 'starting' : 'browser_missing',
  linkedNumber: null,
  qrDataUrl: null,
  errorCode: browserExecutable ? null : 'BROWSER_MISSING',
  changedAt: new Date().toISOString()
};

function setSenderState(state, updates = {}) {
  senderState.state = state;
  senderState.changedAt = new Date().toISOString();
  Object.assign(senderState, updates);
}

let waClient = null;
let clientGeneration = 0;
let lifecycleEpoch = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let reconnectStableTimer = null;
let readyDeadlineTimer = null;
let clientStartPromise = null;
let clientRestartPromise = null;
let initializeFailuresOnBrowser = 0;
let initializeFailureTotal = 0;
let readyTimeouts = 0;
let preferKnownGoodWebVersion = true;
let heartbeatTimer = null;
let heartbeatInProgress = false;
let heartbeatFailures = 0;
let shuttingDown = false;
let sendInProgress = false;
let restoreInProgress = false;

function timeoutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, code) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(code)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class FakeWhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.info = { wid: { user: '966500000000' } };
    this.pupBrowser = null;
  }

  async initialize() {
    setImmediate(() => this.emit('ready'));
  }

  async destroy() {}
  async logout() {}
  async getState() { return 'CONNECTED'; }
  async getNumberId(phone) {
    if (process.env.BLUE_SHARK_FAKE_NUMBER_UNREGISTERED === '1') return null;
    return { _serialized: `${phone}@c.us` };
  }

  async sendMessage() {
    if (process.env.BLUE_SHARK_FAKE_SEND_FAILURE === '1') throw timeoutError('FAKE_SEND_FAILURE');
    if (process.env.BLUE_SHARK_FAKE_MESSAGE_ID_MISSING === '1') return {};
    return { id: { _serialized: `fake-${crypto.randomUUID()}` } };
  }
}

function rotateBrowserCandidate() {
  if (browserCandidates.length < 2) return false;
  browserCandidateIndex = (browserCandidateIndex + 1) % browserCandidates.length;
  browserExecutable = browserCandidates[browserCandidateIndex];
  initializeFailuresOnBrowser = 0;
  logEvent('warn', 'browser_candidate_rotated', { browser: path.basename(browserExecutable) });
  return true;
}

function isBrowserLaunchFailure(error) {
  const code = String(error && (error.code || error.name) || '').toUpperCase();
  const message = String(error && error.message || '');
  return ['ENOENT', 'EACCES', 'EPERM', 'TARGETCLOSEERROR'].includes(code) ||
    /failed to launch (?:the )?browser|browser was not found|spawn .*(?:enoent|eacces|eperm)/i.test(message);
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearReadyDeadline() {
  if (!readyDeadlineTimer) return;
  clearTimeout(readyDeadlineTimer);
  readyDeadlineTimer = null;
}

function armReadyDeadline(client, generation, timeoutMs, phase) {
  clearReadyDeadline();
  readyDeadlineTimer = setTimeout(() => {
    readyDeadlineTimer = null;
    if (shuttingDown || generation !== clientGeneration || client !== waClient || senderState.state === 'ready') return;
    readyTimeouts += 1;
    if (readyTimeouts === 2) {
      preferKnownGoodWebVersion = false;
      refreshWebVersionCacheAfterFailures(true);
    }
    setSenderState('error', { linkedNumber: null, errorCode: 'READY_TIMEOUT' });
    logEvent('warn', 'client_ready_timeout', { phase, count: readyTimeouts });
    forceRestartWhatsAppClient(client, generation).catch((error) => {
      logEvent('error', 'ready_timeout_restart_failed', { code: error.code || error.name });
      shutdown('ready_timeout_restart_failed', 1).catch(() => process.exit(1));
    });
  }, timeoutMs);
  if (typeof readyDeadlineTimer.unref === 'function') readyDeadlineTimer.unref();
}

function refreshWebVersionCacheAfterFailures(force = false) {
  const threshold = Math.max(2, browserCandidates.length * 2);
  if (!force && (!initializeFailureTotal || initializeFailureTotal % threshold !== 0)) return;
  const resolvedCache = path.resolve(SESSION_CACHE_DIR);
  if (path.basename(resolvedCache).toLowerCase() !== 'web-cache') return;
  try {
    fs.rmSync(resolvedCache, { recursive: true, force: true });
    fs.mkdirSync(resolvedCache, { recursive: true });
    logEvent('warn', 'web_version_cache_refreshed', { failures: initializeFailureTotal });
  } catch (error) {
    logEvent('warn', 'web_version_cache_refresh_failed', { code: error.code || error.name });
  }
}

function attachClientEvents(client, generation) {
  const isCurrent = () => generation === clientGeneration && client === waClient;

  client.on('qr', async (qr) => {
    if (!isCurrent()) return;
    clearReadyDeadline();
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 340, margin: 2, errorCorrectionLevel: 'M' });
      setSenderState('qr', { qrDataUrl, linkedNumber: null, errorCode: null });
      logEvent('info', 'qr_ready');
    } catch (error) {
      setSenderState('error', { errorCode: 'QR_RENDER_FAILED' });
      logEvent('error', 'qr_render_failed', { code: error.code || error.name });
    }
  });

  client.on('authenticated', () => {
    if (!isCurrent()) return;
    if (client.pupPage && !client.__blueSharkPageErrorHooked) {
      client.__blueSharkPageErrorHooked = true;
      client.pupPage.on('pageerror', (error) => {
        if (!isCurrent()) return;
        const detail = String(error && error.message ? error.message : error || 'page error')
          .replaceAll(APP_ROOT, '<app>')
          .replaceAll(SESSION_DIR, '<session>')
          .replace(/https?:\/\/\S+/g, '<url>')
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 400);
        logEvent('warn', 'whatsapp_page_error', { code: error && (error.name || error.code) || 'PAGE_ERROR', detail });
      });
    }
    setSenderState('connecting', { qrDataUrl: null, errorCode: null });
    logEvent('info', 'authenticated');
    armReadyDeadline(client, generation, 60000, 'authenticated');
  });

  client.on('ready', () => {
    if (!isCurrent()) return;
    clearReconnectTimer();
    clearReadyDeadline();
    heartbeatFailures = 0;
    initializeFailuresOnBrowser = 0;
    initializeFailureTotal = 0;
    readyTimeouts = 0;
    if (reconnectStableTimer) clearTimeout(reconnectStableTimer);
    reconnectStableTimer = setTimeout(() => {
      if (isCurrent() && senderState.state === 'ready') reconnectAttempts = 0;
    }, 60000);
    if (typeof reconnectStableTimer.unref === 'function') reconnectStableTimer.unref();
    const linkedNumber = client.info && client.info.wid ? client.info.wid.user : null;
    setSenderState('ready', { linkedNumber, qrDataUrl: null, errorCode: null });
    logEvent('info', 'client_ready');
    const browser = client.pupBrowser;
    if (browser && typeof browser.once === 'function') {
      browser.once('disconnected', () => {
        if (!isCurrent() || shuttingDown) return;
        setSenderState('disconnected', { linkedNumber: null, errorCode: 'BROWSER_DISCONNECTED' });
        logEvent('warn', 'browser_disconnected');
        scheduleReconnect(1000);
      });
    }
  });

  client.on('auth_failure', (message) => {
    if (!isCurrent()) return;
    clearReconnectTimer();
    clearReadyDeadline();
    setSenderState('auth_failure', { linkedNumber: null, qrDataUrl: null, errorCode: 'AUTH_FAILURE' });
    logEvent('error', 'auth_failure', { code: 'AUTH_FAILURE', reason: message || 'unknown' });
  });

  client.on('disconnected', (reason) => {
    if (!isCurrent() || shuttingDown) return;
    clearReadyDeadline();
    setSenderState('disconnected', { linkedNumber: null, errorCode: 'DISCONNECTED' });
    logEvent('warn', 'disconnected', { reason: reason || 'unknown' });
    scheduleReconnect();
  });

  client.on('change_state', (state) => {
    if (!isCurrent()) return;
    logEvent('info', 'whatsapp_state_changed', { state: state || 'unknown' });
    if (state === 'CONNECTED') heartbeatFailures = 0;
    if (state === 'UNLAUNCHED' && !shuttingDown) scheduleReconnect(1000);
  });
}

async function destroyCurrentClient() {
  clearReadyDeadline();
  const oldClient = waClient;
  waClient = null;
  clientGeneration += 1;
  if (oldClient) {
    try {
      await withTimeout(oldClient.destroy(), 10000, 'CLIENT_DESTROY_TIMEOUT');
    } catch (error) {
      logEvent('warn', 'client_destroy_failed', { code: error.code || error.name });
    }
  }
  if (!stopStaleBrowserProcesses()) throw timeoutError('STALE_BROWSER_CLEANUP_FAILED');
}

async function startWhatsAppClient() {
  if (shuttingDown || !browserExecutable) return;
  if (clientStartPromise) return clientStartPromise;
  const startEpoch = lifecycleEpoch;
  const operation = (async () => {
    clearReconnectTimer();
    await destroyCurrentClient();
    if (shuttingDown || startEpoch !== lifecycleEpoch) return;
    const generation = ++clientGeneration;
    setSenderState('connecting', { errorCode: null });

    const client = FAKE_WHATSAPP ? new FakeWhatsAppClient() : new Client({
      authStrategy: new LocalAuth({ clientId: 'blue-shark', dataPath: SESSION_DIR, rmMaxRetries: 6 }),
      ...(preferKnownGoodWebVersion ? { webVersion: KNOWN_GOOD_WWEB_VERSION } : {}),
      authTimeoutMs: 120000,
      qrMaxRetries: 0,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
      webVersionCache: { type: 'local', path: SESSION_CACHE_DIR, strict: false },
      puppeteer: {
        headless: true,
        executablePath: browserExecutable,
        protocolTimeout: 120000,
        timeout: 120000,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-sync',
          '--metrics-recording-only'
        ]
      }
    });
    waClient = client;
    attachClientEvents(client, generation);
    armReadyDeadline(client, generation, 120000, 'startup');

    try {
      await withTimeout(client.initialize(), 180000, 'INITIALIZE_TIMEOUT');
    } catch (error) {
      if (generation !== clientGeneration || shuttingDown) return;
      if (senderState.state === 'auth_failure') {
        await destroyCurrentClient();
        return;
      }
      initializeFailuresOnBrowser += 1;
      initializeFailureTotal += 1;
      if (initializeFailuresOnBrowser >= 2 && isBrowserLaunchFailure(error)) rotateBrowserCandidate();
      await destroyCurrentClient();
      refreshWebVersionCacheAfterFailures();
      setSenderState('error', { errorCode: 'INITIALIZE_FAILED' });
      const detail = String(error && error.message ? error.message : 'unknown')
        .replaceAll(APP_ROOT, '<app>')
        .replaceAll(SESSION_DIR, '<session>')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 600);
      logEvent('error', 'initialize_failed', { code: error.code || error.name, detail });
      scheduleReconnect();
    }
  })();
  clientStartPromise = operation;
  try {
    return await operation;
  } finally {
    if (clientStartPromise === operation) clientStartPromise = null;
  }
}

async function stopWhatsAppClientAndPendingStart() {
  lifecycleEpoch += 1;
  const pendingStart = clientStartPromise;
  await destroyCurrentClient();
  if (pendingStart) {
    try {
      await withTimeout(pendingStart, 15000, 'PENDING_START_STOP_TIMEOUT');
    } catch (error) {
      logEvent('warn', 'pending_start_stop_failed', { code: error.code || error.name });
      throw error;
    }
  }
}

async function forceRestartWhatsAppClient(expectedClient = null, expectedGeneration = null) {
  const isStillExpected = () => (
    (!expectedClient || expectedClient === waClient) &&
    (expectedGeneration === null || expectedGeneration === clientGeneration)
  );
  if (shuttingDown || !isStillExpected()) return;
  if (clientRestartPromise) return clientRestartPromise;

  const operation = (async () => {
    if (shuttingDown || !isStillExpected()) return;
    await stopWhatsAppClientAndPendingStart();
    if (shuttingDown) return;
    startWhatsAppClient().catch((error) => {
      logEvent('error', 'restart_initialize_failed', { code: error.code || error.name });
      scheduleReconnect();
    });
  })();
  clientRestartPromise = operation;
  try {
    return await operation;
  } finally {
    if (clientRestartPromise === operation) clientRestartPromise = null;
  }
}

function scheduleReconnect(delayMs) {
  if (shuttingDown || reconnectTimer || !browserExecutable) return;
  reconnectAttempts += 1;
  const baseDelay = Math.min(120000, 3000 * (2 ** Math.min(6, Math.max(0, reconnectAttempts - 1))));
  const jitteredDelay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  const delay = delayMs ?? jitteredDelay;
  setSenderState('reconnecting', { errorCode: senderState.errorCode });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsAppClient().catch((error) => {
      logEvent('error', 'reconnect_failed', { code: error.code || error.name });
      scheduleReconnect();
    });
  }, delay);
  if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

async function heartbeat() {
  if (heartbeatInProgress || shuttingDown || WHATSAPP_DISABLED || sendInProgress) return;
  heartbeatInProgress = true;
  try {
    if (senderState.state === 'ready' && waClient) {
      const state = await withTimeout(waClient.getState(), 10000, 'HEARTBEAT_TIMEOUT');
      if (state === 'CONNECTED') heartbeatFailures = 0;
      else heartbeatFailures += 1;
    } else if (['connecting', 'reconnecting', 'error', 'disconnected'].includes(senderState.state)) {
      const stalledForMs = Date.now() - Date.parse(senderState.changedAt);
      if (stalledForMs > 180000) heartbeatFailures += 1;
    } else {
      heartbeatFailures = 0;
    }
  } catch (error) {
    heartbeatFailures += 1;
    logEvent('warn', 'heartbeat_failed', { code: error.code || error.name, failures: heartbeatFailures });
  } finally {
    heartbeatInProgress = false;
  }
  if (heartbeatFailures >= 3) {
    heartbeatFailures = 0;
    logEvent('warn', 'heartbeat_restart_requested');
    scheduleReconnect(1000);
  }
}

function startHeartbeat() {
  if (heartbeatTimer || WHATSAPP_DISABLED) return;
  heartbeatTimer = setInterval(() => heartbeat().catch((error) => {
    logEvent('warn', 'heartbeat_loop_failed', { code: error.code || error.name });
  }), 30000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

let database = null;
let cloudRuntime = null;
let startupReady = false;

function initializeDatabase() {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone_e164 TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS branches_active_name
      ON branches(name) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      sent_at TEXT NOT NULL,
      reception_date TEXT,
      delivery_date TEXT,
      branch_id INTEGER,
      branch_name TEXT,
      branch_phone TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      vehicle_model TEXT,
      vehicle_year TEXT,
      vehicle_color TEXT,
      plate_country TEXT,
      plate_number TEXT,
      payment_method TEXT,
      services_json TEXT NOT NULL DEFAULT '[]',
      total_amount REAL NOT NULL DEFAULT 0,
      deposit_paid REAL NOT NULL DEFAULT 0,
      remaining_amount REAL NOT NULL DEFAULT 0,
      pdf_path TEXT NOT NULL,
      whatsapp_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      send_count INTEGER NOT NULL DEFAULT 1,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_sent_at ON orders(sent_at DESC);
    CREATE INDEX IF NOT EXISTS orders_branch_id ON orders(branch_id);
    CREATE INDEX IF NOT EXISTS orders_customer_name ON orders(customer_name);
    CREATE TABLE IF NOT EXISTS order_counters (
      year INTEGER PRIMARY KEY,
      next_value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS send_reservations (
      order_number TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const recovered = database.prepare(`
    UPDATE send_reservations
    SET state = 'delivery_uncertain', updated_at = ?
    WHERE state = 'sending'
  `).run(new Date().toISOString());
  if (recovered.changes) {
    logEvent('warn', 'uncertain_send_recovered', { count: recovered.changes });
  }

  const seeded = database.prepare('SELECT value FROM app_meta WHERE key = ?').get('branches_seeded');
  if (!seeded) {
    const now = new Date().toISOString();
    const insert = database.prepare('INSERT INTO branches(name, phone_e164, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
    insert.run('الفرع الأول | حي الواحة', '', now, now);
    insert.run('الفرع الثاني | حي المحمدية', '', now, now);
    database.prepare('INSERT INTO app_meta(key, value) VALUES (?, ?)').run('branches_seeded', '1');
  }

  migrateLegacyOrders();
  ensureCounterForYear(new Date().getFullYear());
}

function readLegacyIndex() {
  try {
    if (!fs.existsSync(SENT_INDEX_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(SENT_INDEX_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    logEvent('warn', 'sent_index_read_failed', { code: error.code || error.name });
    return {};
  }
}

function findArchivedPdfs(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findArchivedPdfs(fullPath));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function migrateLegacyOrders() {
  const legacyIndex = readLegacyIndex();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO orders(
      order_number, sent_at, pdf_path, whatsapp_message_id, status, legacy, created_at
    ) VALUES (?, ?, ?, ?, 'sent', 1, ?)
  `);
  const archived = findArchivedPdfs(SENT_DIR);
  for (const absolutePath of archived) {
    const match = path.basename(absolutePath).match(/Blue_Shark_(BS-\d{2}-\d{4})(?:-\d+)?\.pdf$/i);
    if (!match) continue;
    const orderNumber = match[1].toUpperCase();
    const metadata = legacyIndex[orderNumber] || {};
    const stat = fs.statSync(absolutePath);
    const sentAt = metadata.sentAt || stat.mtime.toISOString();
    insert.run(
      orderNumber,
      sentAt,
      path.relative(APP_ROOT, absolutePath),
      metadata.messageId || null,
      sentAt
    );
  }
}

function orderNumberParts(value) {
  const match = String(value || '').trim().toUpperCase().match(/^BS-(\d{2})-(\d{4,})$/);
  if (!match) return null;
  return { yearPart: match[1], sequence: Number(match[2]) };
}

function ensureCounterForYear(year) {
  const yearPart = String(year).slice(-2);
  const rows = database.prepare('SELECT order_number FROM orders WHERE order_number LIKE ?').all(`BS-${yearPart}-%`);
  let nextValue = 1;
  for (const row of rows) {
    const parts = orderNumberParts(row.order_number);
    if (parts && parts.yearPart === yearPart) nextValue = Math.max(nextValue, parts.sequence + 1);
  }
  const existing = database.prepare('SELECT next_value FROM order_counters WHERE year = ?').get(year);
  if (!existing) database.prepare('INSERT INTO order_counters(year, next_value) VALUES (?, ?)').run(year, nextValue);
  else if (existing.next_value < nextValue) database.prepare('UPDATE order_counters SET next_value = ? WHERE year = ?').run(nextValue, year);
}

function nextOrderNumber() {
  const year = new Date().getFullYear();
  const yearPart = String(year).slice(-2);
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureCounterForYear(year);
    const row = database.prepare('SELECT next_value FROM order_counters WHERE year = ?').get(year);
    const sequence = Math.max(1, Number(row && row.next_value || 1));
    database.prepare('UPDATE order_counters SET next_value = ? WHERE year = ?').run(sequence + 1, year);
    database.exec('COMMIT');
    return `BS-${yearPart}-${String(sequence).padStart(4, '0')}`;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function ensureOrderNumber(value) {
  const orderNumber = sanitizeOrderNumber(value).toUpperCase();
  const parts = orderNumberParts(orderNumber);
  if (!parts) return false;
  const fullYear = 2000 + Number(parts.yearPart);
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureCounterForYear(fullYear);
    const current = database.prepare('SELECT next_value FROM order_counters WHERE year = ?').get(fullYear);
    if (current && current.next_value <= parts.sequence) {
      database.prepare('UPDATE order_counters SET next_value = ? WHERE year = ?').run(parts.sequence + 1, fullYear);
    }
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function sanitizeOrderNumber(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function normalizeInternationalPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function normalizeE164Phone(value) {
  const digits = normalizeInternationalPhone(value);
  return digits ? `+${digits}` : null;
}

function isValidGccMobile(value) {
  const phone = String(value || '').replace(/\D/g, '').replace(/^00/, '');
  return /^(9665\d{8}|9715\d{8}|965[4569]\d{7}|9733\d{7}|974[3567]\d{7}|968[79]\d{7})$/.test(phone);
}

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().replace(/[\u0000-\u001f]+/g, ' ').slice(0, maxLength);
}

function parseOrderData(rawValue, phone) {
  let source;
  try {
    source = JSON.parse(String(rawValue || '{}'));
  } catch (error) {
    return null;
  }
  const branchId = Number(source.branchId);
  const branch = Number.isInteger(branchId) ? database.prepare('SELECT * FROM branches WHERE id = ? AND active = 1').get(branchId) : null;
  if (!branch || !normalizeE164Phone(branch.phone_e164)) return null;
  const services = Array.isArray(source.services) ? source.services.slice(0, 30).map((service) => ({
    category: cleanText(service && service.category, 80),
    categoryLabel: cleanText(service && service.categoryLabel, 160),
    value: cleanText(service && service.value, 80),
    label: cleanText(service && service.label, 240),
    products: Array.isArray(service && service.products) ? service.products.slice(0, 30).map((product) => ({
      value: cleanText(product && product.value, 80),
      label: cleanText(product && product.label, 240)
    })) : []
  })).filter((service) => service.label) : [];
  const total = Math.max(0, Number(source.amounts && source.amounts.total || 0));
  const deposit = Math.max(0, Number(source.amounts && source.amounts.deposit || 0));
  const remaining = Math.max(0, Number(source.amounts && source.amounts.remaining || 0));
  const customerPhone = normalizeInternationalPhone(source.customer && source.customer.phone);
  if (!customerPhone || customerPhone !== phone) return null;
  const orderData = {
    branchId: branch.id,
    branchName: branch.name,
    branchPhone: branch.phone_e164,
    customerName: cleanText(source.customer && source.customer.name),
    customerPhone: `+${customerPhone}`,
    receptionDate: cleanText(source.dates && source.dates.reception, 20),
    deliveryDate: cleanText(source.dates && source.dates.delivery, 20),
    vehicleModel: cleanText(source.vehicle && source.vehicle.model),
    vehicleYear: cleanText(source.vehicle && source.vehicle.year, 10),
    vehicleColor: cleanText(source.vehicle && source.vehicle.color, 80),
    plateCountry: cleanText(source.vehicle && source.vehicle.plateCountry, 10),
    plateNumber: cleanText(source.vehicle && source.vehicle.plateNumber, 40),
    paymentMethod: cleanText(source.paymentMethod, 40),
    services,
    totalAmount: Number.isFinite(total) ? total : 0,
    depositPaid: Number.isFinite(deposit) ? deposit : 0,
    remainingAmount: Number.isFinite(remaining) ? remaining : 0
  };
  const complete = orderData.customerName && orderData.receptionDate && orderData.deliveryDate &&
    orderData.vehicleModel && orderData.vehicleYear && orderData.vehicleColor && orderData.plateNumber &&
    orderData.paymentMethod && orderData.services.length;
  return complete ? orderData : null;
}

function storedPdfAvailable(relativePath) {
  if (!relativePath) return false;
  const absolutePath = path.resolve(APP_ROOT, relativePath);
  const relative = path.relative(APP_ROOT, absolutePath);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(absolutePath);
}

async function uniqueArchivePath(directory, baseName) {
  let candidate = path.join(directory, `${baseName}.pdf`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${baseName}-${index}.pdf`);
    index += 1;
  }
  return candidate;
}

function getSendReservation(orderNumber) {
  return database.prepare(`
    SELECT order_number AS orderNumber, state, archive_path AS archivePath,
      message_id AS messageId, created_at AS createdAt, updated_at AS updatedAt
    FROM send_reservations WHERE order_number = ?
  `).get(orderNumber);
}

function createSendReservation(orderNumber, archivePath) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO send_reservations(order_number, state, archive_path, message_id, created_at, updated_at)
    VALUES (?, 'sending', ?, NULL, ?, ?)
  `).run(orderNumber, path.relative(APP_ROOT, archivePath), now, now);
}

function markSendReservationUncertain(orderNumber, messageId) {
  database.prepare(`
    UPDATE send_reservations
    SET state = 'delivery_uncertain', message_id = ?, updated_at = ?
    WHERE order_number = ?
  `).run(messageId || null, new Date().toISOString(), orderNumber);
}

function clearSendReservation(orderNumber) {
  database.prepare('DELETE FROM send_reservations WHERE order_number = ?').run(orderNumber);
}

function saveOrderRecord(orderNumber, orderData, messageId, sentAt, archivePath) {
  const archive = path.relative(APP_ROOT, archivePath);
  const existing = database.prepare('SELECT id, send_count AS sendCount FROM orders WHERE order_number = ?').get(orderNumber);
  const values = [
    sentAt,
    orderData.receptionDate,
    orderData.deliveryDate,
    orderData.branchId,
    orderData.branchName,
    orderData.branchPhone,
    orderData.customerName,
    orderData.customerPhone,
    orderData.vehicleModel,
    orderData.vehicleYear,
    orderData.vehicleColor,
    orderData.plateCountry,
    orderData.plateNumber,
    orderData.paymentMethod,
    JSON.stringify(orderData.services),
    orderData.totalAmount,
    orderData.depositPaid,
    orderData.remainingAmount,
    archive,
    messageId
  ];
  database.exec('BEGIN IMMEDIATE');
  try {
    if (existing) {
      database.prepare(`
        UPDATE orders SET
          sent_at = ?, reception_date = ?, delivery_date = ?, branch_id = ?, branch_name = ?, branch_phone = ?,
          customer_name = ?, customer_phone = ?, vehicle_model = ?, vehicle_year = ?, vehicle_color = ?,
          plate_country = ?, plate_number = ?, payment_method = ?, services_json = ?, total_amount = ?,
          deposit_paid = ?, remaining_amount = ?, pdf_path = ?, whatsapp_message_id = ?, status = 'sent',
          send_count = send_count + 1, legacy = 0
        WHERE order_number = ?
      `).run(...values, orderNumber);
    } else {
      database.prepare(`
        INSERT INTO orders(
          order_number, sent_at, reception_date, delivery_date, branch_id, branch_name, branch_phone,
          customer_name, customer_phone, vehicle_model, vehicle_year, vehicle_color, plate_country,
          plate_number, payment_method, services_json, total_amount, deposit_paid, remaining_amount,
          pdf_path, whatsapp_message_id, status, send_count, legacy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 1, 0, ?)
      `).run(orderNumber, ...values, sentAt);
    }
    database.prepare('DELETE FROM send_reservations WHERE order_number = ?').run(orderNumber);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return archive;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupFileName(prefix = 'Blue_Shark_Backup') {
  return `${prefix}_${timestampForFile()}.bsbackup`;
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function listBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:Blue_Shark_Backup|Before_Restore)_\d{4}-\d{2}-\d{2}T[\d-]+Z\.bsbackup$/i.test(entry.name))
    .map((entry) => {
      const absolute = path.join(BACKUP_DIR, entry.name);
      const stat = fs.statSync(absolute);
      return { filename: entry.name, size: stat.size, createdAt: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function createBackupArchive(prefix = 'Blue_Shark_Backup') {
  if (!database) throw Object.assign(new Error('DATABASE_UNAVAILABLE'), { code: 'DATABASE_UNAVAILABLE' });
  const filename = backupFileName(prefix);
  const targetPath = path.join(BACKUP_DIR, filename);
  const databaseSnapshot = path.join(TEMP_DIR, `backup-${crypto.randomUUID()}.db`);
  const pdfFiles = findArchivedPdfs(SENT_DIR);
  try {
    await backupSqliteDatabase(database, databaseSnapshot);
    const manifest = {
      type: 'blue-shark-service-order-backup',
      version: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      databaseSha256: await hashFile(databaseSnapshot),
      pdfCount: pdfFiles.length
    };
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(targetPath, { flags: 'wx' });
      const archive = archiver('zip', { zlib: { level: 6 } });
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      output.on('close', () => { if (!settled) { settled = true; resolve(); } });
      output.on('error', fail);
      archive.on('error', fail);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      archive.file(databaseSnapshot, { name: 'data/blue-shark.db' });
      if (fs.existsSync(SENT_INDEX_PATH)) archive.file(SENT_INDEX_PATH, { name: 'data/sent-orders.json' });
      for (const pdfPath of pdfFiles) {
        const relative = path.relative(SENT_DIR, pdfPath).split(path.sep).join('/');
        archive.file(pdfPath, { name: `Sent Orders/${relative}` });
      }
      archive.finalize().catch(fail);
    });
    const size = (await fsp.stat(targetPath)).size;
    logEvent('info', 'backup_created', { filename, size, pdfCount: pdfFiles.length });
    return { filename, size, createdAt: manifest.createdAt, pdfCount: pdfFiles.length };
  } catch (error) {
    await fsp.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(databaseSnapshot, { force: true }).catch(() => {});
  }
}

function normalizedBackupEntryPath(entryPath) {
  const normalized = String(entryPath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join('/');
}

function validateBackupDatabase(databasePath) {
  let candidate = null;
  try {
    candidate = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = candidate.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw Object.assign(new Error('BACKUP_DATABASE_CORRUPT'), { code: 'BACKUP_DATABASE_CORRUPT' });
    const tables = new Set(candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const required of ['app_meta', 'branches', 'orders', 'order_counters', 'send_reservations']) {
      if (!tables.has(required)) throw Object.assign(new Error('BACKUP_DATABASE_INCOMPLETE'), { code: 'BACKUP_DATABASE_INCOMPLETE' });
    }
  } finally {
    if (candidate) candidate.close();
  }
}

async function copyDirectoryMerge(source, destination) {
  if (!fs.existsSync(source)) return;
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectoryMerge(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

async function prepareBackupForRestore(archivePath) {
  let directory = null;
  try {
    directory = await unzipper.Open.file(archivePath);
  } catch (error) {
    throw Object.assign(new Error('INVALID_BACKUP_CONTENT'), { code: 'INVALID_BACKUP_CONTENT' });
  }
  let totalSize = 0;
  let manifestEntry = null;
  let databaseEntry = null;
  const pdfEntries = [];
  let legacyIndexEntry = null;
  for (const entry of directory.files) {
    const safePath = normalizedBackupEntryPath(entry.path);
    if (!safePath) throw Object.assign(new Error('INVALID_BACKUP_PATH'), { code: 'INVALID_BACKUP_PATH' });
    if (entry.type !== 'File') continue;
    totalSize += Number(entry.vars && entry.vars.uncompressedSize || 0);
    if (totalSize > MAX_BACKUP_UNCOMPRESSED_BYTES) throw Object.assign(new Error('BACKUP_TOO_LARGE'), { code: 'BACKUP_TOO_LARGE' });
    if (safePath === 'manifest.json') manifestEntry = entry;
    else if (safePath === 'data/blue-shark.db') databaseEntry = entry;
    else if (safePath === 'data/sent-orders.json') legacyIndexEntry = entry;
    else if (safePath.startsWith('Sent Orders/') && /\.pdf$/i.test(safePath)) pdfEntries.push({ entry, safePath });
    else throw Object.assign(new Error('INVALID_BACKUP_CONTENT'), { code: 'INVALID_BACKUP_CONTENT' });
  }
  if (!manifestEntry || !databaseEntry) throw Object.assign(new Error('BACKUP_INCOMPLETE'), { code: 'BACKUP_INCOMPLETE' });
  if (Number(manifestEntry.vars && manifestEntry.vars.uncompressedSize || 0) > 64 * 1024) throw Object.assign(new Error('INVALID_BACKUP_MANIFEST'), { code: 'INVALID_BACKUP_MANIFEST' });
  let manifest = null;
  try { manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')); } catch (error) {}
  if (!manifest || manifest.type !== 'blue-shark-service-order-backup' || manifest.version !== BACKUP_FORMAT_VERSION || !/^[a-f0-9]{64}$/i.test(String(manifest.databaseSha256 || ''))) {
    throw Object.assign(new Error('INVALID_BACKUP_MANIFEST'), { code: 'INVALID_BACKUP_MANIFEST' });
  }
  const staging = await fsp.mkdtemp(path.join(TEMP_DIR, 'restore-'));
  const stagedDatabase = path.join(staging, 'blue-shark.db');
  const stagedSent = path.join(staging, 'Sent Orders');
  try {
    await pipeline(databaseEntry.stream(), fs.createWriteStream(stagedDatabase, { flags: 'wx' }));
    if ((await hashFile(stagedDatabase)) !== String(manifest.databaseSha256).toLowerCase()) throw Object.assign(new Error('BACKUP_CHECKSUM_MISMATCH'), { code: 'BACKUP_CHECKSUM_MISMATCH' });
    validateBackupDatabase(stagedDatabase);
    for (const { entry, safePath } of pdfEntries) {
      const relative = safePath.slice('Sent Orders/'.length);
      const target = path.resolve(stagedSent, ...relative.split('/'));
      if (!target.startsWith(`${path.resolve(stagedSent)}${path.sep}`)) throw Object.assign(new Error('INVALID_BACKUP_PATH'), { code: 'INVALID_BACKUP_PATH' });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await pipeline(entry.stream(), fs.createWriteStream(target, { flags: 'wx' }));
    }
    const stagedIndex = legacyIndexEntry ? path.join(staging, 'sent-orders.json') : null;
    if (legacyIndexEntry) await pipeline(legacyIndexEntry.stream(), fs.createWriteStream(stagedIndex, { flags: 'wx' }));
    return { staging, stagedDatabase, stagedSent, stagedIndex, manifest };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function applyPreparedRestore(prepared) {
  const safetyBackup = await createBackupArchive('Before_Restore');
  const previousDatabase = path.join(TEMP_DIR, `previous-${crypto.randomUUID()}.db`);
  const incomingDatabase = path.join(DATA_DIR, `incoming-${crypto.randomUUID()}.db`);
  let previousMoved = false;
  try {
    await fsp.copyFile(prepared.stagedDatabase, incomingDatabase);
    database.exec('PRAGMA wal_checkpoint(FULL)');
    database.close();
    database = null;
    await fsp.rm(`${DATABASE_PATH}-wal`, { force: true }).catch(() => {});
    await fsp.rm(`${DATABASE_PATH}-shm`, { force: true }).catch(() => {});
    await fsp.rename(DATABASE_PATH, previousDatabase);
    previousMoved = true;
    await fsp.rename(incomingDatabase, DATABASE_PATH);
    database = new DatabaseSync(DATABASE_PATH);
    initializeDatabase();
    await copyDirectoryMerge(prepared.stagedSent, SENT_DIR);
    if (prepared.stagedIndex) await fsp.copyFile(prepared.stagedIndex, SENT_INDEX_PATH);
    await fsp.rm(previousDatabase, { force: true }).catch(() => {});
    previousMoved = false;
    logEvent('info', 'backup_restored', { createdAt: prepared.manifest.createdAt, safetyBackup: safetyBackup.filename });
    return safetyBackup;
  } catch (error) {
    try { if (database) database.close(); } catch (closeError) {}
    database = null;
    if (previousMoved) {
      await fsp.rm(DATABASE_PATH, { force: true }).catch(() => {});
      await fsp.rename(previousDatabase, DATABASE_PATH);
      previousMoved = false;
    }
    if (fs.existsSync(DATABASE_PATH)) {
      database = new DatabaseSync(DATABASE_PATH);
      initializeDatabase();
    }
    throw error;
  } finally {
    await fsp.rm(incomingDatabase, { force: true }).catch(() => {});
    await fsp.rm(prepared.staging, { recursive: true, force: true }).catch(() => {});
  }
}

const app = express();
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, TEMP_DIR),
    filename: (req, file, callback) => callback(null, `backup-upload-${crypto.randomUUID()}.bsbackup`)
  }),
  limits: { fileSize: MAX_BACKUP_BYTES, files: 1 },
  fileFilter: (req, file, callback) => callback(null, /\.bsbackup$/i.test(String(file.originalname || '')))
});
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  const host = String(req.get('host') || '').toLowerCase();
  const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  const allowedOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
  if (!allowedHosts.has(host)) return res.status(403).json({ ok: false, code: 'HOST_REJECTED' });
  if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ ok: false, code: 'ORIGIN_REJECTED' });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'"
  ].join('; '));
  next();
});
app.use('/api', (req, res, next) => {
  if (restoreInProgress) return res.status(503).json({ ok: false, code: 'RESTORE_IN_PROGRESS' });
  next();
});

app.get('/api/config', (req, res) => {
  if (!startupReady) {
    return res.status(503).json({ ok: false, appId: 'blue-shark-sender', apiVersion: 2, code: 'STARTING' });
  }
  res.json({
    ok: true,
    appId: 'blue-shark-sender',
    appVersion: APP_VERSION,
    apiVersion: 2,
    token: CSRF_TOKEN,
    maxPdfBytes: MAX_PDF_BYTES,
    cloud: {
      enabled: Boolean(cloudRuntime?.enabled),
      required: Boolean(cloudRuntime?.configuration?.required)
    }
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    state: senderState.state,
    linkedNumber: senderState.linkedNumber,
    qrAvailable: Boolean(senderState.qrDataUrl),
    errorCode: senderState.errorCode,
    changedAt: senderState.changedAt,
    busy: sendInProgress || restoreInProgress
  });
});

app.get('/api/qr', (req, res) => {
  res.json({
    ok: true,
    available: Boolean(senderState.qrDataUrl),
    image: senderState.qrDataUrl || null
  });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

function requireToken(req, res, next) {
  const suppliedToken = req.get('X-Blue-Shark-Token') || String(req.query.token || '');
  if (suppliedToken !== CSRF_TOKEN) return res.status(403).json({ ok: false, code: 'INVALID_TOKEN' });
  next();
}

app.get('/api/error-logs', requireToken, (req, res) => {
  res.json({ ok: true, entries: readRecentErrorLogs(req.query.limit) });
});

app.delete('/api/error-logs', requireToken, async (req, res) => {
  await Promise.all([
    fsp.rm(logPath, { force: true }),
    fsp.rm(`${logPath}.1`, { force: true })
  ]);
  res.json({ ok: true });
});

app.get('/api/backups', requireToken, (req, res) => {
  res.json({ ok: true, backups: listBackupFiles().slice(0, 50) });
});

app.post('/api/backups', requireToken, async (req, res, next) => {
  if (sendInProgress) return res.status(409).json({ ok: false, code: 'BUSY' });
  try {
    const created = await createBackupArchive();
    res.status(201).json({ ok: true, backup: created });
  } catch (error) {
    logEvent('error', 'backup_create_failed', { code: error.code || error.name });
    next(error);
  }
});

app.get('/api/backups/:filename', requireToken, (req, res) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!/^(?:Blue_Shark_Backup|Before_Restore)_\d{4}-\d{2}-\d{2}T[\d-]+Z\.bsbackup$/i.test(filename)) return res.status(400).json({ ok: false, code: 'INVALID_BACKUP_NAME' });
  const absolute = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(absolute)) return res.status(404).json({ ok: false, code: 'BACKUP_NOT_FOUND' });
  res.download(absolute, filename);
});

app.post('/api/backups/restore', requireToken, backupUpload.single('backup'), async (req, res) => {
  const uploadedPath = req.file && req.file.path;
  if (!uploadedPath) return res.status(400).json({ ok: false, code: 'BACKUP_FILE_REQUIRED' });
  if (sendInProgress || restoreInProgress) {
    await fsp.rm(uploadedPath, { force: true }).catch(() => {});
    return res.status(409).json({ ok: false, code: 'BUSY' });
  }
  restoreInProgress = true;
  let prepared = null;
  try {
    prepared = await prepareBackupForRestore(uploadedPath);
    const safetyBackup = await applyPreparedRestore(prepared);
    prepared = null;
    res.json({ ok: true, safetyBackup });
  } catch (error) {
    if (prepared && prepared.staging) await fsp.rm(prepared.staging, { recursive: true, force: true }).catch(() => {});
    const knownCodes = new Set(['INVALID_BACKUP_PATH', 'BACKUP_TOO_LARGE', 'INVALID_BACKUP_CONTENT', 'BACKUP_INCOMPLETE', 'INVALID_BACKUP_MANIFEST', 'BACKUP_CHECKSUM_MISMATCH', 'BACKUP_DATABASE_CORRUPT', 'BACKUP_DATABASE_INCOMPLETE']);
    const code = knownCodes.has(error.code) ? error.code : 'BACKUP_RESTORE_FAILED';
    logEvent('error', 'backup_restore_failed', { code: error.code || error.name });
    res.status(knownCodes.has(code) ? 400 : 500).json({ ok: false, code });
  } finally {
    restoreInProgress = false;
    await fsp.rm(uploadedPath, { force: true }).catch(() => {});
  }
});

app.get('/api/branches', requireToken, (req, res) => {
  const includeInactive = String(req.query.includeInactive || '') === 'true';
  const rows = database.prepare(`
    SELECT id, name, phone_e164 AS phone, active, created_at AS createdAt, updated_at AS updatedAt
    FROM branches
    ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY active DESC, name COLLATE NOCASE
  `).all();
  res.json({ ok: true, branches: rows.map((row) => ({ ...row, active: Boolean(row.active), configured: Boolean(normalizeE164Phone(row.phone)) })) });
});

app.post('/api/branches', requireToken, (req, res) => {
  const name = cleanText(req.body && req.body.name, 120);
  const phone = normalizeE164Phone(req.body && req.body.phone);
  if (!name) return res.status(400).json({ ok: false, code: 'BRANCH_NAME_REQUIRED' });
  if (!phone || !isValidGccMobile(phone)) return res.status(400).json({ ok: false, code: 'INVALID_BRANCH_PHONE' });
  const now = new Date().toISOString();
  try {
    const result = database.prepare('INSERT INTO branches(name, phone_e164, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(name, phone, now, now);
    res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) return res.status(409).json({ ok: false, code: 'DUPLICATE_BRANCH' });
    throw error;
  }
});

app.put('/api/branches/:id', requireToken, (req, res) => {
  const id = Number(req.params.id);
  const name = cleanText(req.body && req.body.name, 120);
  const phone = normalizeE164Phone(req.body && req.body.phone);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, code: 'INVALID_BRANCH' });
  if (!name) return res.status(400).json({ ok: false, code: 'BRANCH_NAME_REQUIRED' });
  if (!phone || !isValidGccMobile(phone)) return res.status(400).json({ ok: false, code: 'INVALID_BRANCH_PHONE' });
  try {
    const result = database.prepare('UPDATE branches SET name = ?, phone_e164 = ?, updated_at = ? WHERE id = ? AND active = 1').run(name, phone, new Date().toISOString(), id);
    if (!result.changes) return res.status(404).json({ ok: false, code: 'BRANCH_NOT_FOUND' });
    res.json({ ok: true });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) return res.status(409).json({ ok: false, code: 'DUPLICATE_BRANCH' });
    throw error;
  }
});

app.delete('/api/branches/:id', requireToken, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, code: 'INVALID_BRANCH' });
  const activeCount = database.prepare('SELECT COUNT(*) AS count FROM branches WHERE active = 1').get().count;
  if (activeCount <= 1) return res.status(409).json({ ok: false, code: 'LAST_BRANCH' });
  const result = database.prepare('UPDATE branches SET active = 0, updated_at = ? WHERE id = ? AND active = 1').run(new Date().toISOString(), id);
  if (!result.changes) return res.status(404).json({ ok: false, code: 'BRANCH_NOT_FOUND' });
  res.json({ ok: true });
});

app.post('/api/order-number/next', requireToken, (req, res) => {
  res.json({ ok: true, orderNumber: nextOrderNumber() });
});

app.post('/api/order-number/ensure', requireToken, (req, res) => {
  const orderNumber = cleanText(req.body && req.body.orderNumber, 60);
  if (!ensureOrderNumber(orderNumber)) return res.status(400).json({ ok: false, code: 'INVALID_ORDER_NUMBER' });
  res.json({ ok: true });
});

app.get('/api/orders', requireToken, (req, res) => {
  const search = cleanText(req.query.search, 120);
  const branchId = Number(req.query.branchId);
  const from = cleanText(req.query.from, 20);
  const to = cleanText(req.query.to, 20);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const conditions = ["status = 'sent'"];
  const params = [];
  if (search) {
    const phoneSearch = /^\+?\d[\d\s-]{6,}$/.test(search) ? normalizeInternationalPhone(search) : null;
    conditions.push(phoneSearch
      ? '(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR REPLACE(customer_phone, \'+\', \'\') LIKE ?)'
      : '(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
    if (phoneSearch) params.push(`%${phoneSearch}%`);
  }
  if (Number.isInteger(branchId) && branchId > 0) {
    conditions.push('branch_id = ?');
    params.push(branchId);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conditions.push('date(sent_at) >= date(?)');
    params.push(from);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    conditions.push('date(sent_at) <= date(?)');
    params.push(to);
  }
  const rows = database.prepare(`
    SELECT order_number AS orderNumber, sent_at AS sentAt, customer_name AS customerName,
      customer_phone AS customerPhone, branch_id AS branchId, branch_name AS branchName,
      vehicle_model AS vehicleModel, total_amount AS totalAmount, pdf_path AS pdfPath,
      legacy, send_count AS sendCount
    FROM orders WHERE ${conditions.join(' AND ')}
    ORDER BY datetime(sent_at) DESC LIMIT ?
  `).all(...params, limit);
  res.json({ ok: true, orders: rows.map((row) => ({ ...row, legacy: Boolean(row.legacy), pdfAvailable: storedPdfAvailable(row.pdfPath) })) });
});

app.get('/api/orders/:orderNumber', requireToken, (req, res) => {
  const orderNumber = sanitizeOrderNumber(req.params.orderNumber).toUpperCase();
  const row = database.prepare(`
    SELECT order_number AS orderNumber, sent_at AS sentAt, reception_date AS receptionDate,
      delivery_date AS deliveryDate, branch_id AS branchId, branch_name AS branchName,
      branch_phone AS branchPhone, customer_name AS customerName, customer_phone AS customerPhone,
      vehicle_model AS vehicleModel, vehicle_year AS vehicleYear, vehicle_color AS vehicleColor,
      plate_country AS plateCountry, plate_number AS plateNumber, payment_method AS paymentMethod,
      services_json AS servicesJson, total_amount AS totalAmount, deposit_paid AS depositPaid,
      remaining_amount AS remainingAmount, pdf_path AS pdfPath, whatsapp_message_id AS messageId,
      legacy, send_count AS sendCount
    FROM orders WHERE order_number = ? AND status = 'sent'
  `).get(orderNumber);
  if (!row) return res.status(404).json({ ok: false, code: 'ORDER_NOT_FOUND' });
  let services = [];
  try { services = JSON.parse(row.servicesJson || '[]'); } catch (error) {}
  delete row.servicesJson;
  res.json({ ok: true, order: { ...row, services, legacy: Boolean(row.legacy), pdfAvailable: storedPdfAvailable(row.pdfPath) } });
});

app.get('/api/orders/:orderNumber/pdf', requireToken, (req, res) => {
  const orderNumber = sanitizeOrderNumber(req.params.orderNumber).toUpperCase();
  const row = database.prepare("SELECT pdf_path AS pdfPath FROM orders WHERE order_number = ? AND status = 'sent'").get(orderNumber);
  if (!row || !storedPdfAvailable(row.pdfPath)) return res.status(404).json({ ok: false, code: 'PDF_NOT_FOUND' });
  const absolutePath = path.resolve(APP_ROOT, row.pdfPath);
  res.setHeader('Content-Disposition', `inline; filename="Blue_Shark_${orderNumber}.pdf"`);
  res.sendFile(absolutePath);
});

app.post('/api/orders/:orderNumber/resend', requireToken, async (req, res) => {
  if (sendInProgress) return res.status(429).json({ ok: false, code: 'BUSY' });
  if (senderState.state !== 'ready' || !waClient) return res.status(503).json({ ok: false, code: 'WHATSAPP_NOT_READY' });
  const orderNumber = sanitizeOrderNumber(req.params.orderNumber).toUpperCase();
  const row = database.prepare(`
    SELECT customer_name AS customerName, customer_phone AS customerPhone, pdf_path AS pdfPath
    FROM orders WHERE order_number = ? AND status = 'sent'
  `).get(orderNumber);
  if (!row) return res.status(404).json({ ok: false, code: 'ORDER_NOT_FOUND' });
  if (!storedPdfAvailable(row.pdfPath)) return res.status(404).json({ ok: false, code: 'PDF_NOT_FOUND' });
  const phone = normalizeInternationalPhone(row.customerPhone);
  if (!phone) return res.status(400).json({ ok: false, code: 'INVALID_PHONE' });
  if (getSendReservation(orderNumber)) return res.status(409).json({ ok: false, code: 'DELIVERY_UNCERTAIN' });

  const absolutePath = path.resolve(APP_ROOT, row.pdfPath);
  sendInProgress = true;
  let deliveryAttempted = false;
  let deliveryConfirmed = false;
  let messageId = null;
  try {
    const pdfBuffer = await fsp.readFile(absolutePath);
    const registeredId = await withTimeout(waClient.getNumberId(phone), 20000, 'NUMBER_LOOKUP_TIMEOUT');
    if (!registeredId) return res.status(422).json({ ok: false, code: 'NUMBER_NOT_REGISTERED' });
    createSendReservation(orderNumber, absolutePath);
    const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), 'Blue Shark.pdf');
    deliveryAttempted = true;
    const message = await withTimeout(waClient.sendMessage(registeredId._serialized, media, {
      caption: `مرحبًا ${row.customerName}،\nتم إصدار أمر خدمة من Blue Shark.`,
      sendMediaAsDocument: true
    }), 90000, 'SEND_TIMEOUT');
    deliveryConfirmed = true;
    messageId = message && message.id ? message.id._serialized : `local-${crypto.randomUUID()}`;
    const sentAt = new Date().toISOString();
    database.prepare(`
      UPDATE orders SET sent_at = ?, whatsapp_message_id = ?, send_count = send_count + 1
      WHERE order_number = ?
    `).run(sentAt, messageId, orderNumber);
    clearSendReservation(orderNumber);
    logEvent('info', 'order_resent', { orderNumber, messageId });
    res.json({ ok: true, orderNumber, phone: `+${phone}`, messageId, sentAt });
  } catch (error) {
    if (deliveryConfirmed || deliveryAttempted) {
      try { markSendReservationUncertain(orderNumber, messageId); } catch (reservationError) {}
      logEvent('error', 'order_resend_uncertain', { orderNumber, code: error.code || error.name });
      return res.status(500).json({ ok: false, code: 'DELIVERY_UNCERTAIN' });
    }
    try { clearSendReservation(orderNumber); } catch (reservationError) {}
    logEvent('error', 'order_resend_failed', { orderNumber, code: error.code || error.name });
    res.status(502).json({ ok: false, code: 'SEND_FAILED' });
  } finally {
    sendInProgress = false;
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 8 },
  fileFilter(req, file, callback) {
    const valid = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname || '');
    callback(valid ? null : new Error('INVALID_PDF'), valid);
  }
});

async function runExclusiveSend(operation) {
  if (sendInProgress) {
    throw Object.assign(new Error('Another send is in progress'), { code: 'BUSY', status: 429 });
  }
  sendInProgress = true;
  try {
    return await operation();
  } finally {
    sendInProgress = false;
  }
}

async function deliverCentralWhatsApp({ phone, pdf, caption }) {
  if (senderState.state !== 'ready' || !waClient) {
    throw Object.assign(new Error('WhatsApp is not ready'), { code: 'WHATSAPP_NOT_READY', status: 503 });
  }
  const normalized = normalizeInternationalPhone(phone);
  if (!normalized) throw Object.assign(new Error('Invalid phone'), { code: 'INVALID_PHONE', status: 400 });
  const registeredId = await withTimeout(waClient.getNumberId(normalized), 20000, 'NUMBER_LOOKUP_TIMEOUT');
  if (!registeredId) {
    throw Object.assign(new Error('Phone is not registered'), { code: 'NUMBER_NOT_REGISTERED', status: 422 });
  }
  const media = new MessageMedia('application/pdf', pdf.toString('base64'), 'Blue Shark.pdf');
  try {
    const message = await withTimeout(waClient.sendMessage(registeredId._serialized, media, {
      caption,
      sendMediaAsDocument: true
    }), 90000, 'SEND_TIMEOUT');
    return { messageId: message?.id?._serialized || `local-${crypto.randomUUID()}` };
  } catch (error) {
    error.externalEffectStarted = true;
    throw error;
  }
}

app.use('/api/cloud', requireToken, createCloudRouter({
  getRuntime: () => cloudRuntime,
  upload,
  runExclusiveSend,
  deliverWhatsApp: deliverCentralWhatsApp
}));

app.post('/api/send-order', requireToken, upload.single('pdf'), async (req, res) => {
  if (sendInProgress) return res.status(429).json({ ok: false, code: 'BUSY' });
  if (senderState.state !== 'ready' || !waClient) return res.status(503).json({ ok: false, code: 'WHATSAPP_NOT_READY' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, code: 'PDF_REQUIRED' });

  const orderNumber = sanitizeOrderNumber(req.body.orderNumber).toUpperCase();
  const phone = normalizeInternationalPhone(req.body.phone);
  const caption = String(req.body.caption || '').trim().slice(0, 1000);
  const forceResend = String(req.body.forceResend || '') === 'true';
  if (!orderNumberParts(orderNumber)) return res.status(400).json({ ok: false, code: 'INVALID_ORDER_NUMBER' });
  if (!phone) return res.status(400).json({ ok: false, code: 'INVALID_PHONE' });
  if (!caption) return res.status(400).json({ ok: false, code: 'CAPTION_REQUIRED' });
  const orderData = parseOrderData(req.body.orderData, phone);
  if (!orderData || !orderData.customerName) return res.status(400).json({ ok: false, code: 'INVALID_ORDER_DATA' });

  const priorOrder = database.prepare('SELECT sent_at AS sentAt, whatsapp_message_id AS messageId FROM orders WHERE order_number = ?').get(orderNumber);
  if (priorOrder && !forceResend) {
    return res.status(409).json({
      ok: false,
      code: 'DUPLICATE_ORDER',
      prior: priorOrder
    });
  }
  const priorReservation = getSendReservation(orderNumber);
  if (priorReservation) {
    return res.status(409).json({
      ok: false,
      code: 'DELIVERY_UNCERTAIN',
      prior: { state: priorReservation.state, updatedAt: priorReservation.updatedAt }
    });
  }

  sendInProgress = true;
  const tempPath = path.join(TEMP_DIR, `${orderNumber}-${Date.now()}.pdf`);
  let archivePath = null;
  let reservationCreated = false;
  let deliveryAttempted = false;
  let deliveryConfirmed = false;
  let messageId = null;
  try {
    await fsp.writeFile(tempPath, req.file.buffer);
    const registeredId = await withTimeout(waClient.getNumberId(phone), 20000, 'NUMBER_LOOKUP_TIMEOUT');
    if (!registeredId) {
      await fsp.rm(tempPath, { force: true });
      return res.status(422).json({ ok: false, code: 'NUMBER_NOT_REGISTERED' });
    }

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const archiveDirectory = path.join(SENT_DIR, month);
    await fsp.mkdir(archiveDirectory, { recursive: true });
    archivePath = await uniqueArchivePath(archiveDirectory, `Blue_Shark_${orderNumber}`);
    await fsp.rename(tempPath, archivePath);
    createSendReservation(orderNumber, archivePath);
    reservationCreated = true;

    const filename = 'Blue Shark.pdf';
    const media = new MessageMedia('application/pdf', req.file.buffer.toString('base64'), filename);
    deliveryAttempted = true;
    const message = await withTimeout(waClient.sendMessage(registeredId._serialized, media, {
      caption,
      sendMediaAsDocument: true
    }), 90000, 'SEND_TIMEOUT');
    deliveryConfirmed = true;
    messageId = message && message.id ? message.id._serialized : null;
    if (!messageId) {
      messageId = `local-${crypto.randomUUID()}`;
      logEvent('warn', 'message_id_missing_fallback', { orderNumber });
    }

    const sentAt = new Date().toISOString();
    const archive = saveOrderRecord(orderNumber, orderData, messageId, sentAt, archivePath);
    let nextOrder = null;
    try { nextOrder = nextOrderNumber(); } catch (nextNumberError) {
      logEvent('error', 'next_order_number_failed', { code: nextNumberError.code || nextNumberError.name });
    }
    reservationCreated = false;
    logEvent('info', 'order_sent', { orderNumber, messageId });
    res.json({ ok: true, messageId, sentAt, archive, nextOrderNumber: nextOrder });
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    if (deliveryConfirmed || deliveryAttempted) {
      try { markSendReservationUncertain(orderNumber, messageId); } catch (reservationError) {
        logEvent('error', 'uncertain_send_state_write_failed', { orderNumber, code: reservationError.code || reservationError.name });
      }
      logEvent('error', 'delivery_uncertain', { orderNumber, messageId, code: error.code || error.name });
      setSenderState('error', { linkedNumber: null, errorCode: 'SEND_CHANNEL_UNCERTAIN' });
      scheduleReconnect(1000);
      return res.status(500).json({ ok: false, code: 'DELIVERY_UNCERTAIN' });
    }
    if (reservationCreated) {
      try { clearSendReservation(orderNumber); } catch (reservationError) {}
    }
    if (archivePath) await fsp.rm(archivePath, { force: true }).catch(() => {});
    logEvent('error', 'send_failed', { orderNumber, code: error.code || error.name });
    res.status(502).json({ ok: false, code: 'SEND_FAILED' });
  } finally {
    sendInProgress = false;
  }
});

app.post('/api/reconnect', requireToken, (req, res) => {
  if (sendInProgress) return res.status(409).json({ ok: false, code: 'BUSY' });
  res.json({ ok: true });
  setTimeout(() => forceRestartWhatsAppClient().catch((error) => {
    logEvent('error', 'manual_reconnect_failed', { code: error.code || error.name });
    shutdown('manual_reconnect_failed', 1).catch(() => process.exit(1));
  }), 100);
});

app.post('/api/relink', requireToken, (req, res) => {
  if (sendInProgress) return res.status(409).json({ ok: false, code: 'BUSY' });
  res.json({ ok: true });
  setTimeout(async () => {
    try {
      if (waClient) await waClient.logout().catch(() => {});
      await stopWhatsAppClientAndPendingStart();
      await fsp.rm(path.join(SESSION_DIR, 'session-blue-shark'), { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
      await fsp.mkdir(SESSION_DIR, { recursive: true });
      hardenDirectoryAcl(SESSION_DIR);
      setSenderState('connecting', { linkedNumber: null, qrDataUrl: null, errorCode: null });
      await startWhatsAppClient();
    } catch (error) {
      logEvent('error', 'relink_failed', { code: error.code || error.name });
      shutdown('relink_failed', 1).catch(() => process.exit(1));
    }
  }, 200);
});

app.post('/api/stop', requireToken, (req, res) => {
  if (sendInProgress) return res.status(409).json({ ok: false, code: 'BUSY' });
  res.json({ ok: true });
  setTimeout(() => shutdown('ui_stop'), 250);
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'html2pdf.js', 'dist'), { fallthrough: false }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, code: req.path === '/api/backups/restore' ? 'BACKUP_TOO_LARGE' : 'PDF_TOO_LARGE' });
  }
  if (error && error.message === 'INVALID_PDF') return res.status(400).json({ ok: false, code: 'INVALID_PDF' });
  logEvent('error', 'http_error', { code: error.code || error.name || 'HTTP_ERROR' });
  res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
});

const server = app.listen(PORT, HOST, async (listenError) => {
  if (listenError) return;
  try {
    const staleBrowsersStopped = stopStaleBrowserProcesses([LEGACY_SESSION_DIR, SESSION_DIR]);
    prepareSessionDirectory({ allowMigration: staleBrowsersStopped });
    database = new DatabaseSync(DATABASE_PATH);
    initializeDatabase();
    cloudRuntime = new CloudRuntime(APP_ROOT, DATA_DIR);
    await cloudRuntime.initialize();
  } catch (error) {
    setSenderState('error', { errorCode: error.code || 'STARTUP_PREPARE_FAILED' });
    logEvent('error', 'startup_prepare_failed', { code: error.code || error.name });
    setImmediate(() => shutdown('startup_prepare_failed', 1).catch(() => process.exit(1)));
    return;
  }
  startupReady = true;
  logEvent('info', 'server_started', {
    port: PORT,
    browser: browserExecutable ? path.basename(browserExecutable) : 'missing',
    cloud: cloudRuntime.enabled ? 'configured' : 'legacy',
    session: path.resolve(SESSION_DIR).toLowerCase() === path.resolve(LEGACY_SESSION_DIR).toLowerCase() ? 'legacy' : 'local'
  });
  startHeartbeat();
  startWhatsAppClient().catch((error) => {
    logEvent('error', 'startup_failed', { code: error.code || error.name });
    scheduleReconnect();
  });
});

server.on('error', (error) => {
  logEvent('error', 'server_error', { code: error.code || error.name });
  if (error.code === 'EADDRINUSE') return process.exit(3);
  setImmediate(() => shutdown('server_error', 1).catch(() => process.exit(1)));
});

async function closeHttpServer() {
  if (!server.listening) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconnectStableTimer) clearTimeout(reconnectStableTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  clearReadyDeadline();
  setSenderState('stopping', { errorCode: null });
  logEvent('info', 'server_stopping', { reason });
  await closeHttpServer();
  try {
    await stopWhatsAppClientAndPendingStart();
  } catch (error) {
    logEvent('warn', 'client_stop_during_shutdown_failed', { code: error.code || error.name });
    try {
      await destroyCurrentClient();
    } catch (cleanupError) {
      logEvent('warn', 'client_cleanup_during_shutdown_failed', { code: cleanupError.code || cleanupError.name });
    }
  }
  try { if (cloudRuntime) cloudRuntime.close(); } catch (error) {}
  try { if (database) database.close(); } catch (error) {}
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('sigint'));
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('uncaughtException', (error) => {
  logEvent('error', 'uncaught_exception', { code: error.code || error.name });
  shutdown('uncaught_exception', 1).catch(() => process.exit(1));
});
process.on('unhandledRejection', (error) => {
  logEvent('error', 'unhandled_rejection', { code: error && (error.code || error.name) || 'unknown' });
  shutdown('unhandled_rejection', 1).catch(() => process.exit(1));
});
