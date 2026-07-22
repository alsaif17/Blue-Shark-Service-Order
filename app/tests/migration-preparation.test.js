'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { prepareMigration } = require('../../scripts/Prepare_Legacy_Migration');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('legacy migration preparation is read-only, deterministic, and reports number conflicts', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-shark-migration-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceA = path.join(root, 'a', 'blue-shark.db');
  const sourceB = path.join(root, 'b', 'blue-shark.db');
  for (const source of [sourceA, sourceB]) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const db = new DatabaseSync(source);
    db.exec(`
      create table branches(id integer primary key, name text, phone_e164 text, active integer);
      create table orders(
        id integer primary key, order_number text, sent_at text, reception_date text, delivery_date text,
        branch_id integer, branch_name text, branch_phone text, customer_name text, customer_phone text,
        vehicle_model text, vehicle_year text, vehicle_color text, plate_country text, plate_number text,
        payment_method text, services_json text, total_amount real, deposit_paid real, remaining_amount real,
        pdf_path text, whatsapp_message_id text, status text, send_count integer, legacy integer, created_at text
      );
      insert into branches values(1,'Branch','+966500000000',1);
    `);
    db.prepare('insert into orders values(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'BS-26-0001','2026-01-01T00:00:00Z','','',1,'Branch','+966500000000',
      source === sourceA ? 'Customer A' : 'Customer B','+966511111111','Car','2026','Blue','SA','ABC 1',
      'cash','[{"label":"Service"}]',100,0,100,'','','sent',1,0,'2026-01-01T00:00:00Z'
    );
    db.close();
  }
  const before = [digest(sourceA), digest(sourceB)];
  const output = path.join(root, 'migration-output');
  const manifest = await prepareMigration([sourceA, sourceB], output);
  assert.deepEqual([digest(sourceA), digest(sourceB)], before);
  assert.equal(manifest.totals.records, 2);
  assert.equal(manifest.totals.conflicts, 1);
  assert.equal(digest(path.join(output, 'records.ndjson')), manifest.recordsSha256);
});
