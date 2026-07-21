'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const unzipper = require('unzipper');

const appDir = path.resolve(__dirname, '..');
const serverPath = path.join(appDir, 'server.js');

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  socket.close();
  await once(socket, 'close');
  return port;
}

async function waitUntilReady(baseUrl, child, output) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output.text}`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`server did not become ready: ${output.text}`);
}

async function startServer(root, port, environment = {}) {
  const output = { text: '' };
  const child = spawn(process.execPath, [serverPath], {
    cwd: appDir,
    env: {
      ...process.env,
      BLUE_SHARK_APP_ROOT: root,
      BLUE_SHARK_SESSION_DIR: path.join(root, 'state', 'session'),
      BLUE_SHARK_DISABLE_WHATSAPP: '1',
      BLUE_SHARK_FAKE_WHATSAPP: '0',
      BLUE_SHARK_FAKE_SEND_FAILURE: '0',
      BLUE_SHARK_FAKE_NUMBER_UNREGISTERED: '0',
      BLUE_SHARK_PORT: String(port),
      ...environment
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output.text += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output.text += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilReady(baseUrl, child, output);
  return { child, baseUrl, output };
}

async function waitUntilSenderState(baseUrl, child, output, expectedState) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output.text}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      const body = await response.json();
      if (response.ok && body.state === expectedState) return body;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`sender did not reach ${expectedState}: ${output.text}`);
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  let timer;
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve([null, 'TIMEOUT']), timeoutMs);
      })
    ]);
    return { code, signal };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  let body = null;
  try { body = await response.json(); } catch (error) {}
  return { response, body };
}

async function createConfiguredBranch(baseUrl, token, suffix = '001') {
  const result = await jsonRequest(`${baseUrl}/api/branches`, {
    method: 'POST',
    headers: { 'X-Blue-Shark-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `QA Branch ${suffix}`, phone: '+966503266499' })
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.id;
}

function validOrderData(branchId, customerPhone = '+966503266499') {
  return {
    branchId,
    dates: { reception: '2026-07-17', delivery: '2026-07-18' },
    customer: { name: 'QA Customer', phone: customerPhone },
    vehicle: {
      model: 'QA Vehicle',
      year: '2026',
      color: 'Blue',
      plateCountry: 'KSA',
      plateNumber: 'QA-1234'
    },
    paymentMethod: 'cash',
    services: [{ category: 'qa', value: 'qa-service', label: 'QA service' }],
    amounts: { total: 100, deposit: 25, remaining: 75 }
  };
}

async function nextOrderNumber(baseUrl, token) {
  const result = await jsonRequest(`${baseUrl}/api/order-number/next`, {
    method: 'POST', headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.orderNumber;
}

async function submitPdfOrder(baseUrl, token, { orderNumber, branchId, forceResend = false }) {
  const pdfBytes = Buffer.from('%PDF-1.4\n% Blue Shark deterministic integration test\n%%EOF\n', 'utf8');
  const form = new FormData();
  form.append('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), `Blue_Shark_${orderNumber}.pdf`);
  form.append('orderNumber', orderNumber);
  form.append('phone', '+966503266499');
  form.append('caption', 'QA integration test');
  form.append('forceResend', forceResend ? 'true' : 'false');
  form.append('orderData', JSON.stringify(validOrderData(branchId)));
  const result = await jsonRequest(`${baseUrl}/api/send-order`, {
    method: 'POST',
    headers: { 'X-Blue-Shark-Token': token },
    body: form
  });
  return { ...result, pdfBytes };
}

function findPdfFiles(root) {
  const sentRoot = path.join(root, 'Sent Orders');
  if (!fs.existsSync(sentRoot)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(absolute);
    }
  };
  visit(sentRoot);
  return files;
}

test('local API, security headers, counters, branches, and crash recovery', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-api-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const firstPort = await unusedPort();
  running = await startServer(root, firstPort);
  const configResult = await jsonRequest(`${running.baseUrl}/api/config`);
  assert.equal(configResult.response.status, 200);
  assert.equal(configResult.body.appId, 'blue-shark-sender');
  assert.equal(configResult.body.apiVersion, 2);
  assert.match(configResult.response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const token = configResult.body.token;
  assert.ok(token && token.length >= 32);

  const denied = await jsonRequest(`${running.baseUrl}/api/branches`);
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, 'INVALID_TOKEN');

  const statusResult = await jsonRequest(`${running.baseUrl}/api/status`);
  assert.equal(statusResult.body.state, 'browser_missing');

  const headers = { 'X-Blue-Shark-Token': token, 'Content-Type': 'application/json' };
  const created = await jsonRequest(`${running.baseUrl}/api/branches`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'QA Branch', phone: '+966500000001' })
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.id > 0);

  const updated = await jsonRequest(`${running.baseUrl}/api/branches/${created.body.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ name: 'QA Branch Updated', phone: '+966500000002' })
  });
  assert.equal(updated.response.status, 200);

  const nextOne = await jsonRequest(`${running.baseUrl}/api/order-number/next`, { method: 'POST', headers });
  const nextTwo = await jsonRequest(`${running.baseUrl}/api/order-number/next`, { method: 'POST', headers });
  assert.match(nextOne.body.orderNumber, /^BS-\d{2}-\d{4}$/);
  assert.notEqual(nextOne.body.orderNumber, nextTwo.body.orderNumber);

  const offlineSend = await jsonRequest(`${running.baseUrl}/api/send-order`, { method: 'POST', headers: { 'X-Blue-Shark-Token': token } });
  assert.equal(offlineSend.response.status, 503);
  assert.equal(offlineSend.body.code, 'WHATSAPP_NOT_READY');

  const removed = await jsonRequest(`${running.baseUrl}/api/branches/${created.body.id}`, { method: 'DELETE', headers });
  assert.equal(removed.response.status, 200);

  await stopServer(running.child);
  running = null;

  const dbPath = path.join(root, 'data', 'blue-shark.db');
  const database = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO send_reservations(order_number, state, archive_path, message_id, created_at, updated_at)
    VALUES (?, 'sending', ?, NULL, ?, ?)
  `).run('BS-99-9999', 'Sent Orders\\QA.pdf', now, now);
  database.close();

  const secondPort = await unusedPort();
  running = await startServer(root, secondPort);
  await stopServer(running.child);
  running = null;

  const recoveredDatabase = new DatabaseSync(dbPath, { readOnly: true });
  const reservation = recoveredDatabase.prepare('SELECT state FROM send_reservations WHERE order_number = ?').get('BS-99-9999');
  recoveredDatabase.close();
  assert.equal(reservation.state, 'delivery_uncertain');
});

test('fake WhatsApp reaches ready and persists one successful PDF order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-fake-success-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1'
  });
  const config = await jsonRequest(`${running.baseUrl}/api/config`);
  assert.equal(config.body.appId, 'blue-shark-sender');
  assert.equal(config.body.apiVersion, 2);
  const token = config.body.token;

  const ready = await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');
  assert.equal(ready.linkedNumber, '966500000000');

  const branchId = await createConfiguredBranch(running.baseUrl, token, '101');
  const orderNumber = await nextOrderNumber(running.baseUrl, token);
  const sent = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.ok, true);
  assert.match(sent.body.messageId, /^fake-[0-9a-f-]{36}$/);

  const detail = await jsonRequest(`${running.baseUrl}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.order.messageId, sent.body.messageId);
  assert.equal(detail.body.order.pdfAvailable, true);

  const resent = await jsonRequest(`${running.baseUrl}/api/orders/${encodeURIComponent(orderNumber)}/resend`, {
    method: 'POST', headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(resent.response.status, 200, JSON.stringify(resent.body));
  assert.equal(resent.body.orderNumber, orderNumber);
  assert.match(resent.body.messageId, /^fake-[0-9a-f-]{36}$/);
  const resentDetail = await jsonRequest(`${running.baseUrl}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(resentDetail.body.order.sendCount, 2);
  assert.equal(resentDetail.body.order.pdfAvailable, true);

  const localPhoneSearch = await jsonRequest(`${running.baseUrl}/api/orders?search=0503266499`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(localPhoneSearch.response.status, 200, JSON.stringify(localPhoneSearch.body));
  assert.equal(localPhoneSearch.body.orders.length, 1);
  assert.equal(localPhoneSearch.body.orders[0].orderNumber, orderNumber);

  await stopServer(running.child);
  running = null;

  const database = new DatabaseSync(path.join(root, 'data', 'blue-shark.db'), { readOnly: true });
  const orders = database.prepare(`
    SELECT order_number AS orderNumber, whatsapp_message_id AS messageId, status
    FROM orders
  `).all();
  const reservations = database.prepare('SELECT * FROM send_reservations').all();
  database.close();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderNumber, orderNumber);
  assert.equal(orders[0].messageId, resent.body.messageId);
  assert.equal(orders[0].status, 'sent');
  assert.equal(reservations.length, 0);

  const pdfFiles = findPdfFiles(root);
  assert.equal(pdfFiles.length, 1);
  assert.deepEqual(fs.readFileSync(pdfFiles[0]), sent.pdfBytes);
});

test('successful send without a WhatsApp message id uses a local id and still saves the order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-fake-missing-id-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1',
    BLUE_SHARK_FAKE_MESSAGE_ID_MISSING: '1'
  });
  const config = await jsonRequest(`${running.baseUrl}/api/config`);
  const token = config.body.token;
  await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');
  const branchId = await createConfiguredBranch(running.baseUrl, token, 'missing-id');
  const orderNumber = await nextOrderNumber(running.baseUrl, token);
  const sent = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.messageId, /^local-[0-9a-f-]{36}$/);
  const detail = await jsonRequest(`${running.baseUrl}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.order.messageId, sent.body.messageId);
  assert.equal(detail.body.order.legacy, false);
});

test('fake WhatsApp send failure is recorded as delivery uncertain without an order row', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-fake-failure-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1',
    BLUE_SHARK_FAKE_SEND_FAILURE: '1'
  });
  const config = await jsonRequest(`${running.baseUrl}/api/config`);
  const token = config.body.token;
  await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');

  const branchId = await createConfiguredBranch(running.baseUrl, token, '102');
  const orderNumber = await nextOrderNumber(running.baseUrl, token);
  const failed = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId });
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.deepEqual(failed.body, { ok: false, code: 'DELIVERY_UNCERTAIN' });

  await stopServer(running.child);
  running = null;

  const database = new DatabaseSync(path.join(root, 'data', 'blue-shark.db'), { readOnly: true });
  const orders = database.prepare('SELECT order_number FROM orders').all();
  const reservations = database.prepare(`
    SELECT order_number AS orderNumber, state, message_id AS messageId
    FROM send_reservations
  `).all();
  database.close();
  assert.equal(orders.length, 0);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].orderNumber, orderNumber);
  assert.equal(reservations[0].state, 'delivery_uncertain');
  assert.equal(reservations[0].messageId, null);
  assert.equal(findPdfFiles(root).length, 1);
});

test('uncertain force resend remains blocked after restart when an earlier sent order exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-uncertain-resend-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1'
  });
  let config = await jsonRequest(`${running.baseUrl}/api/config`);
  let token = config.body.token;
  await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');
  const branchId = await createConfiguredBranch(running.baseUrl, token, '103');
  const orderNumber = await nextOrderNumber(running.baseUrl, token);
  const firstSend = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId });
  assert.equal(firstSend.response.status, 200, JSON.stringify(firstSend.body));

  await stopServer(running.child);
  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1',
    BLUE_SHARK_FAKE_SEND_FAILURE: '1'
  });
  config = await jsonRequest(`${running.baseUrl}/api/config`);
  token = config.body.token;
  await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');
  const uncertainResend = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId, forceResend: true });
  assert.equal(uncertainResend.response.status, 500, JSON.stringify(uncertainResend.body));
  assert.equal(uncertainResend.body.code, 'DELIVERY_UNCERTAIN');

  await stopServer(running.child);
  running = await startServer(root, await unusedPort(), {
    BLUE_SHARK_DISABLE_WHATSAPP: '0',
    BLUE_SHARK_FAKE_WHATSAPP: '1'
  });
  config = await jsonRequest(`${running.baseUrl}/api/config`);
  token = config.body.token;
  await waitUntilSenderState(running.baseUrl, running.child, running.output, 'ready');

  const blockedResend = await submitPdfOrder(running.baseUrl, token, { orderNumber, branchId, forceResend: true });
  assert.equal(blockedResend.response.status, 409, JSON.stringify(blockedResend.body));
  assert.equal(blockedResend.body.code, 'DELIVERY_UNCERTAIN');

  const database = new DatabaseSync(path.join(root, 'data', 'blue-shark.db'), { readOnly: true });
  const reservation = database.prepare(`
    SELECT state FROM send_reservations WHERE order_number = ?
  `).get(orderNumber);
  database.close();
  assert.equal(reservation && reservation.state, 'delivery_uncertain');
});

test('backup creation and validated restore recover database state safely', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-backup-restore-'));
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  running = await startServer(root, await unusedPort());
  const config = await jsonRequest(`${running.baseUrl}/api/config`);
  const token = config.body.token;
  await createConfiguredBranch(running.baseUrl, token, '777');

  const created = await jsonRequest(`${running.baseUrl}/api/backups`, {
    method: 'POST',
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.match(created.body.backup.filename, /^Blue_Shark_Backup_.*\.bsbackup$/);
  const backupPath = path.join(root, 'Backups', created.body.backup.filename);
  assert.equal(fs.existsSync(backupPath), true);
  const archive = await unzipper.Open.file(backupPath);
  const archiveEntries = archive.files.map((entry) => entry.path);
  assert.ok(archiveEntries.includes('manifest.json'));
  assert.ok(archiveEntries.includes('data/blue-shark.db'));

  await createConfiguredBranch(running.baseUrl, token, '778');
  const backupBytes = fs.readFileSync(backupPath);
  const restoreForm = new FormData();
  restoreForm.append('backup', new Blob([backupBytes], { type: 'application/zip' }), created.body.backup.filename);
  const restored = await jsonRequest(`${running.baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: { 'X-Blue-Shark-Token': token },
    body: restoreForm
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.match(restored.body.safetyBackup.filename, /^Before_Restore_.*\.bsbackup$/);

  const branches = await jsonRequest(`${running.baseUrl}/api/branches?includeInactive=true`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.equal(branches.response.status, 200, JSON.stringify(branches.body));
  assert.ok(branches.body.branches.some((branch) => branch.name === 'QA Branch 777'));
  assert.equal(branches.body.branches.some((branch) => branch.name === 'QA Branch 778'), false);

  const invalidForm = new FormData();
  invalidForm.append('backup', new Blob([Buffer.from('not a backup')]), 'invalid.bsbackup');
  const invalid = await jsonRequest(`${running.baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: { 'X-Blue-Shark-Token': token },
    body: invalidForm
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
  const branchesAfterInvalid = await jsonRequest(`${running.baseUrl}/api/branches?includeInactive=true`, {
    headers: { 'X-Blue-Shark-Token': token }
  });
  assert.ok(branchesAfterInvalid.body.branches.some((branch) => branch.name === 'QA Branch 777'));
});

test('legacy profile migrates after bind, while EADDRINUSE exits 3 without migration', async (t) => {
  const successfulRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-session-migrate-'));
  const occupiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-session-occupied-'));
  let running = null;
  let occupiedChild = null;
  const blocker = net.createServer();
  t.after(async () => {
    if (running) await stopServer(running.child);
    if (occupiedChild && occupiedChild.exitCode === null) occupiedChild.kill('SIGKILL');
    if (blocker.listening) {
      blocker.close();
      await once(blocker, 'close');
    }
    fs.rmSync(successfulRoot, { recursive: true, force: true });
    fs.rmSync(occupiedRoot, { recursive: true, force: true });
  });

  const successfulLegacy = path.join(successfulRoot, 'data', 'session', 'session-blue-shark');
  const successfulTarget = path.join(successfulRoot, 'state', 'session', 'session-blue-shark');
  fs.mkdirSync(successfulLegacy, { recursive: true });
  fs.writeFileSync(path.join(successfulLegacy, 'linked-device.marker'), 'existing QR session', 'utf8');

  running = await startServer(successfulRoot, await unusedPort());
  assert.equal(fs.existsSync(successfulLegacy), false);
  assert.equal(fs.readFileSync(path.join(successfulTarget, 'linked-device.marker'), 'utf8'), 'existing QR session');
  await stopServer(running.child);
  running = null;

  const occupiedLegacy = path.join(occupiedRoot, 'data', 'session', 'session-blue-shark');
  const occupiedTarget = path.join(occupiedRoot, 'state', 'session', 'session-blue-shark');
  fs.mkdirSync(occupiedLegacy, { recursive: true });
  fs.writeFileSync(path.join(occupiedLegacy, 'linked-device.marker'), 'must stay put', 'utf8');

  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const occupiedPort = blocker.address().port;
  const output = { text: '' };
  occupiedChild = spawn(process.execPath, [serverPath], {
    cwd: appDir,
    env: {
      ...process.env,
      BLUE_SHARK_APP_ROOT: occupiedRoot,
      BLUE_SHARK_SESSION_DIR: path.join(occupiedRoot, 'state', 'session'),
      BLUE_SHARK_DISABLE_WHATSAPP: '1',
      BLUE_SHARK_FAKE_WHATSAPP: '0',
      BLUE_SHARK_PORT: String(occupiedPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  occupiedChild.stdout.on('data', (chunk) => { output.text += chunk.toString(); });
  occupiedChild.stderr.on('data', (chunk) => { output.text += chunk.toString(); });
  const exited = await waitForExit(occupiedChild);
  assert.notEqual(exited.signal, 'TIMEOUT', output.text);
  assert.equal(exited.code, 3, output.text);
  assert.equal(fs.readFileSync(path.join(occupiedLegacy, 'linked-device.marker'), 'utf8'), 'must stay put');
  assert.equal(fs.existsSync(occupiedTarget), false);
});
