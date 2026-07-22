'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { canonicalize } = require('../app/lib/update-signature');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function money(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid monetary value in source');
  return Math.round(number * 100) / 100;
}

function parseServices(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = '966' + digits.slice(1);
  return /^\d{8,15}$/.test(digits) ? '+' + digits : '';
}

function ensureEmptyOutput(outputRoot, sourceFiles) {
  for (const source of sourceFiles) {
    const sourceRoot = path.dirname(source) + path.sep;
    if (outputRoot === source || outputRoot.startsWith(sourceRoot)) {
      throw new Error('Migration output must be outside every source directory');
    }
  }
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length) {
    throw new Error('Migration output directory must be empty');
  }
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
}

async function prepareMigration(sourceFiles, outputRoot) {
  sourceFiles = sourceFiles.map((value) => path.resolve(value));
  outputRoot = path.resolve(outputRoot);
  if (!sourceFiles.length) throw new Error('At least one SQLite source is required');
  sourceFiles.forEach((source) => {
    if (!fs.statSync(source).isFile()) throw new Error('SQLite source is not a file: ' + source);
  });
  ensureEmptyOutput(outputRoot, sourceFiles);
  const documentRoot = path.join(outputRoot, 'documents');
  await fsp.mkdir(documentRoot, { recursive: true, mode: 0o700 });

  const sources = [];
  const records = [];
  for (const [sourceIndex, sourcePath] of sourceFiles.entries()) {
    const stat = await fsp.stat(sourcePath);
    const sourceHash = await fileSha256(sourcePath);
    const sourceId = 'source-' + String(sourceIndex + 1).padStart(3, '0');
    const database = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get();
      if (!table) throw new Error('Source does not contain an orders table: ' + sourcePath);
      const branchRows = database.prepare('SELECT id, name, phone_e164, active FROM branches ORDER BY id').all();
      const orderRows = database.prepare('SELECT * FROM orders ORDER BY id').all();
      let totalAmount = 0;
      for (const row of orderRows) {
        const services = parseServices(row.services_json);
        const total = money(row.total_amount);
        const deposit = money(row.deposit_paid);
        const remaining = money(row.remaining_amount);
        if (Math.abs(total - deposit - remaining) > 0.01) throw new Error('Source order amounts do not balance: ' + row.order_number);
        totalAmount += total;
        const record = {
          sourceId,
          sourceRowKey: String(row.id),
          legacyOrderNumber: String(row.order_number || '').trim(),
          finalizedAt: String(row.sent_at || row.created_at || ''),
          branch: {
            legacyId: row.branch_id === null ? null : String(row.branch_id),
            name: String(row.branch_name || ''),
            phone: normalizePhone(row.branch_phone)
          },
          customer: {
            name: String(row.customer_name || '').trim(),
            phone: normalizePhone(row.customer_phone)
          },
          dates: {
            reception: String(row.reception_date || ''),
            delivery: String(row.delivery_date || '')
          },
          vehicle: {
            model: String(row.vehicle_model || ''),
            year: String(row.vehicle_year || ''),
            color: String(row.vehicle_color || ''),
            plateCountry: String(row.plate_country || ''),
            plateNumber: String(row.plate_number || '')
          },
          paymentMethod: String(row.payment_method || ''),
          services,
          amounts: { total, deposit, remaining },
          legacy: {
            status: String(row.status || ''),
            sendCount: Number(row.send_count || 0),
            whatsappMessageId: String(row.whatsapp_message_id || '')
          },
          document: null
        };
        if (!record.legacyOrderNumber || !record.customer.name || !record.customer.phone || Number.isNaN(Date.parse(record.finalizedAt))) {
          throw new Error('Source order is incomplete: row ' + row.id + ' in ' + sourcePath);
        }

        const candidate = path.isAbsolute(String(row.pdf_path || ''))
          ? path.resolve(String(row.pdf_path))
          : path.resolve(path.dirname(sourcePath), String(row.pdf_path || ''));
        if (row.pdf_path && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const documentHash = await fileSha256(candidate);
          const destinationDirectory = path.join(documentRoot, sourceId);
          await fsp.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
          const relative = path.join('documents', sourceId, String(row.id) + '-' + documentHash + '.pdf');
          await fsp.copyFile(candidate, path.join(outputRoot, relative));
          record.document = {
            relativePath: relative.replaceAll('\\', '/'),
            sha256: documentHash,
            size: fs.statSync(candidate).size
          };
        }
        record.contentSha256 = sha256(Buffer.from(canonicalize(record), 'utf8'));
        records.push(record);
      }
      sources.push({
        sourceId,
        originalPath: sourcePath,
        sourceName: path.basename(sourcePath),
        sha256: sourceHash,
        size: stat.size,
        capturedAt: stat.mtime.toISOString(),
        rowCount: orderRows.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        branches: branchRows
      });
    } finally {
      database.close();
    }
  }

  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.legacyOrderNumber)) groups.set(record.legacyOrderNumber, new Map());
    const hashes = groups.get(record.legacyOrderNumber);
    if (!hashes.has(record.contentSha256)) hashes.set(record.contentSha256, []);
    hashes.get(record.contentSha256).push({ sourceId: record.sourceId, sourceRowKey: record.sourceRowKey });
  }
  const conflicts = [];
  const exactDuplicates = [];
  for (const [legacyOrderNumber, hashes] of groups) {
    if (hashes.size > 1) {
      conflicts.push({
        legacyOrderNumber,
        variants: [...hashes].map(([contentSha256, origins]) => ({ contentSha256, origins }))
      });
    } else {
      const [contentSha256, origins] = [...hashes][0];
      if (origins.length > 1) exactDuplicates.push({ legacyOrderNumber, contentSha256, origins });
    }
  }

  const recordsPath = path.join(outputRoot, 'records.ndjson');
  await fsp.writeFile(recordsPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sources,
    totals: {
      sources: sources.length,
      records: records.length,
      amount: Math.round(sources.reduce((sum, source) => sum + source.totalAmount, 0) * 100) / 100,
      conflicts: conflicts.length,
      exactDuplicateGroups: exactDuplicates.length
    },
    conflicts,
    exactDuplicates,
    recordsSha256: await fileSha256(recordsPath)
  };
  await fsp.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

if (require.main === module) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : '';
  const sources = process.argv.slice(2, outputIndex >= 0 ? outputIndex : undefined);
  if (!output || !sources.length) {
    process.stderr.write('Usage: node scripts/Prepare_Legacy_Migration.js <source.db> [source2.db] --output <empty-directory>\n');
    process.exit(2);
  }
  prepareMigration(sources, output).then((manifest) => {
    process.stdout.write(JSON.stringify(manifest.totals) + '\n');
  }).catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { prepareMigration };
