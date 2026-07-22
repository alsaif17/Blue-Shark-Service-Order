'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const { CloudRuntime } = require('../app/lib/cloud-runtime');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function run() {
  const appRoot = path.resolve(argument('--app-root') || path.join(__dirname, '..'));
  const packageRoot = path.resolve(argument('--package'));
  const branchMapPath = path.resolve(argument('--branch-map'));
  const installed = process.env.ProgramFiles
    && (appRoot === path.resolve(process.env.ProgramFiles) || appRoot.startsWith(path.resolve(process.env.ProgramFiles) + path.sep));
  const dataRoot = path.resolve(argument('--data-root') || process.env.BLUE_SHARK_DATA_DIR || (
    installed && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'BlueShark', 'data') : path.join(appRoot, 'data')
  ));
  const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, 'manifest.json'), 'utf8'));
  const branchMap = JSON.parse(await fsp.readFile(branchMapPath, 'utf8'));
  const runtime = new CloudRuntime(appRoot, dataRoot);
  await runtime.initialize();
  try {
    const status = await runtime.status({ allowOffline: false });
    if (!status.authenticated || !status.systemAdmin || !status.mfaVerified || status.deviceState !== 'approved') {
      throw new Error('An approved online system administrator session with MFA is required');
    }

    const sourceIds = new Map();
    for (const source of manifest.sources) {
      const result = await runtime.callRpc('admin_register_migration_source', {
        p_source_name: source.sourceName,
        p_source_sha256: source.sha256,
        p_source_bytes: source.size,
        p_captured_at: source.capturedAt,
        p_row_count: source.rowCount,
        p_manifest: source
      });
      sourceIds.set(source.sourceId, result.sourceId);
    }

    let imported = 0;
    let merged = 0;
    let documents = 0;
    let conflicts = 0;
    const input = fs.createReadStream(path.join(packageRoot, 'records.ndjson'), 'utf8');
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const mapKey = record.sourceId + ':' + (record.branch.legacyId ?? '*');
      const branchId = branchMap[mapKey] || branchMap[record.sourceId + ':*'];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(branchId || ''))) {
        throw new Error('Missing or invalid branch mapping: ' + mapKey);
      }
      const result = await runtime.callRpc('admin_import_legacy_order', {
        p_source_id: sourceIds.get(record.sourceId),
        p_branch_id: branchId,
        p_source_row_key: record.sourceRowKey,
        p_record: record
      });
      if (result.mergedExactDuplicate || result.idempotent) merged += 1;
      else imported += 1;
      if (result.conflict) conflicts += 1;

      if (record.document) {
        const documentPath = path.resolve(packageRoot, record.document.relativePath);
        if (!documentPath.startsWith(packageRoot + path.sep)) throw new Error('Unsafe migration document path');
        const document = await fsp.readFile(documentPath);
        const digest = crypto.createHash('sha256').update(document).digest('hex');
        if (document.length !== record.document.size || digest !== record.document.sha256) {
          throw new Error('Migration document hash mismatch: ' + record.document.relativePath);
        }
        const detail = await runtime.getOrder(result.orderId);
        if (detail?.document?.status !== 'ready') {
          await runtime.uploadDocument(result.orderId, document, crypto.randomUUID(), Number(detail.document.version || 1));
          documents += 1;
        }
      }
    }
    const counters = await runtime.callRpc('admin_seed_order_counters_from_history', {});
    return { imported, merged, documents, conflicts, counters };
  } finally {
    runtime.close();
  }
}

run().then((result) => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch((error) => {
  process.stderr.write((error.code || error.message || 'MIGRATION_IMPORT_FAILED') + '\n');
  process.exitCode = 1;
});
