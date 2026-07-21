'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(appDir, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(appDir, 'server.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));

test('all inline JavaScript parses successfully', () => {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]))
    .map((match) => match[2].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0, 'expected at least one inline script');
  scripts.forEach((source) => assert.doesNotThrow(() => new Function(source)));
});

test('HTML IDs and print-template keys are unique', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const templateIds = [...html.matchAll(/\sdata-template-id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate static HTML id found');
  assert.equal(new Set(templateIds).size, templateIds.length, 'duplicate print-template key found');
  assert.ok(templateIds.length >= 35, 'print template is missing mapped fields');
});

test('entry workspace remains separate from the hidden A4 template', () => {
  assert.match(html, /id="service-order-template"/);
  assert.match(html, /#service-order-template\{display:none!important\}/);
  assert.match(html, /@media print[\s\S]*#service-order-template\{display:block!important\}/);
  assert.match(html, /service-line-ar/);
  assert.match(html, /service-line-en/);
});

test('validation uses in-app feedback instead of blocking alerts', () => {
  assert.doesNotMatch(html, /\balert\s*\(/);
  assert.doesNotMatch(html, /reportValidity\s*\(/);
  assert.match(html, /function showValidationError/);
  assert.match(html, /serviceForm\.classList\.add\('validation-attempted'\)/);
  assert.match(html, /\.entry-workspace\.validation-attempted input:invalid/);
  assert.match(html, /payment-body:has\(input\[name="payment-method"\]:invalid\)/);
});

test('service selection uses one add action without a second save button', () => {
  assert.match(html, /id="add-product"/);
  assert.doesNotMatch(html, /id="save-current-service"/);
  assert.match(html, /function commitCurrentService/);
  assert.match(html, /add-product'[\s\S]*commitCurrentService\(\)/);
});

test('print template omits the customer signature section', () => {
  assert.doesNotMatch(html, /Customer Signature/);
  assert.doesNotMatch(html, /توقيع العميل/);
});

test('print content keeps Arabic first and right aligned', () => {
  assert.match(html, /\.panel-title\{direction:rtl/);
  assert.match(html, /\.line-input\{direction:rtl;text-align:right/);
  assert.match(html, /\.phone-number\{direction:ltr;text-align:right/);
  assert.match(html, /class="order-head-ar" dir="rtl">رقم أمر الخدمة<\/div>/);
  assert.match(html, /\.order-head-ar\{display:block;width:100%;direction:rtl;text-align:center;white-space:nowrap/);
});

test('critical print values use stable text nodes and payment columns cannot overflow', () => {
  assert.match(html, /id="print-service-order-number"[^>]*class="order-number order-number-print"/);
  assert.match(html, /id="print-branch-mobile"[^>]*class="branch-mobile branch-mobile-print"/);
  assert.match(html, /templateElement\('service-order-number'\)\.textContent = orderNumberInput\.value/);
  assert.match(html, /templateElement\('branch-mobile'\)\.textContent = branchMobileInput\.value/);
  assert.match(html, /\.payment-body\{height:17mm;padding:0;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /\.payment-body \.pay-text\{[^}]*flex-direction:column/);
});

test('approved printing advances to a fresh service order number', () => {
  assert.match(html, /id="print-form"[^>]*data-ar="اعتماد وطباعة"/);
  assert.match(html, /window\.print\(\);[\s\S]*if \(!confirm\([\s\S]*\)\) return;[\s\S]*const nextOrderNumber = await requestNextOrderNumber\(\);[\s\S]*await resetOrderForm\(true,nextOrderNumber\)/);
});

test('history details can safely resend the saved PDF through WhatsApp', () => {
  assert.match(html, /id="history-resend-whatsapp"/);
  assert.match(html, /encodeURIComponent\(selectedHistoryOrder\.orderNumber\) \+ '\/resend'/);
  assert.match(serverSource, /app\.post\('\/api\/orders\/:orderNumber\/resend'/);
  assert.match(serverSource, /send_count = send_count \+ 1/);
  assert.match(serverSource, /new MessageMedia\('application\/pdf',[^\n]+, 'Blue Shark\.pdf'\)/);
  assert.match(serverSource, /caption: `مرحبًا \$\{row\.customerName\}،\\n\\nتم إصدار أمر خدمة من Blue Shark\.`/);
});

test('polished A4 layout preserves the original logo and compact hierarchy', () => {
  assert.match(html, /\.logo\{grid-area:logo;width:52mm;height:34mm;object-fit:contain\}/);
  assert.match(html, /original Blue Shark logo asset is kept unchanged/);
  assert.match(html, /\.services\{height:78mm\}/);
  assert.match(html, /\.selected-choices\{width:100%;max-height:51mm/);
  assert.match(html, /classList\.toggle\('services-compact', savedServices\.length >= 5\)/);
  assert.match(html, /savedServices\.length >= 6/);
  assert.match(html, /\.summary table\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /\.footer\{margin-top:auto;padding-top:1\.5mm;border-top/);
});

test('send recovery and dependency protections are present', () => {
  assert.equal(packageJson.dependencies.multer, '2.2.0');
  assert.equal(packageJson.dependencies.archiver, '7.0.1');
  assert.equal(packageJson.dependencies.unzipper, '0.12.3');
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS send_reservations/);
  assert.match(serverSource, /DELIVERY_UNCERTAIN/);
  assert.match(serverSource, /Content-Security-Policy/);
});

test('settings include validated backup and restore controls', () => {
  assert.match(html, /id="create-backup"/);
  assert.match(html, /id="restore-backup-file"/);
  assert.match(html, /id="restore-backup-modal"/);
  assert.match(serverSource, /createBackupArchive/);
  assert.match(serverSource, /prepareBackupForRestore/);
  assert.match(serverSource, /BACKUP_CHECKSUM_MISMATCH/);
  assert.match(serverSource, /Before_Restore/);
});

test('all settings groups are collapsed behind accessible arrow toggles', () => {
  assert.match(html, /id="branches-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="branches-panel"[^>]*hidden/);
  assert.match(html, /id="whatsapp-settings-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="whatsapp-settings-panel"[^>]*hidden/);
  assert.match(html, /id="backup-settings-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="backup-settings-panel"[^>]*hidden/);
  assert.match(html, /id="error-log-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="error-log-panel"[^>]*hidden/);
  assert.match(html, /function bindSettingsToggle/);
});

test('system log shows counts and level-specific presentation', () => {
  assert.match(html, /data-ar="سجل النظام"/);
  assert.match(html, /id="system-log-count"/);
  assert.match(html, /log-level-warn/);
  assert.match(html, /log-level-info/);
  assert.match(serverSource, /\['error', 'warn', 'info'\]\.includes\(entry\.level\)/);
  assert.match(html, /id="clear-error-logs"/);
  assert.match(serverSource, /app\.delete\('\/api\/error-logs'/);
});

test('entry screen displays the application version returned by config', () => {
  assert.match(html, /id="app-version-value"/);
  assert.match(html, /app-version-value'\)\.textContent\s*=\s*config\.appVersion/);
});
