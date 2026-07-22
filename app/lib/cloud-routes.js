'use strict';

const crypto = require('crypto');
const express = require('express');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_CHANNELS = new Set(['print', 'whatsapp']);
const ACTION_STATES = new Set(['queued', 'in_progress', 'succeeded', 'failed_before_effect', 'uncertain']);
const loginAttempts = new Map();

function cleanText(value, maximum = 200) {
  return String(value || '').trim().replace(/[\u0000-\u001f]+/g, ' ').slice(0, maximum);
}

function uuid(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw Object.assign(new Error(`Invalid ${label}`), { code: 'INVALID_IDENTIFIER', status: 400 });
  }
  return normalized;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

function cleanDraft(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw Object.assign(new Error('Order draft must be an object'), { code: 'INVALID_ORDER_DATA', status: 400 });
  }
  const services = Array.isArray(source.services)
    ? source.services.slice(0, 30).map((service) => ({
      category: cleanText(service?.category, 120) || 'service',
      label: cleanText(service?.label || service?.categoryLabel, 500),
      products: Array.isArray(service?.products)
        ? service.products.slice(0, 30).map((product) => ({
          value: cleanText(product?.value, 120),
          label: cleanText(product?.label || product?.value, 240)
        })).filter((product) => product.label)
        : [],
      amount: Number.isFinite(Number(service?.amount)) ? Number(service.amount) : null
    })).filter((service) => service.label)
    : [];

  const phone = normalizePhone(source.customer?.phone);
  const total = Number(source.amounts?.total || 0);
  const deposit = Number(source.amounts?.deposit || 0);
  if (!phone || !services.length || !Number.isFinite(total) || !Number.isFinite(deposit)) {
    throw Object.assign(new Error('Order draft is incomplete'), { code: 'INVALID_ORDER_DATA', status: 400 });
  }

  return {
    branch: {
      id: cleanText(source.branch?.id, 50),
      name: cleanText(source.branch?.name, 160),
      phone: normalizePhone(source.branch?.phone) || ''
    },
    customer: {
      name: cleanText(source.customer?.name, 200),
      phone
    },
    dates: {
      reception: cleanText(source.dates?.reception, 20),
      delivery: cleanText(source.dates?.delivery, 20)
    },
    vehicle: {
      model: cleanText(source.vehicle?.model, 200),
      year: cleanText(source.vehicle?.year, 10),
      color: cleanText(source.vehicle?.color, 80),
      plateCountry: cleanText(source.vehicle?.plateCountry, 10),
      plateNumber: cleanText(source.vehicle?.plateNumber, 40)
    },
    paymentMethod: cleanText(source.paymentMethod, 80),
    services,
    amounts: { total, deposit, remaining: total - deposit }
  };
}

function mapOrderSummary(order) {
  return {
    orderId: order.id,
    orderNumber: order.order_number || order.legacy_order_number,
    sentAt: order.finalized_at,
    customerName: order.customer_name,
    customerPhone: order.customer_phone_e164,
    branchId: order.branch_id,
    branchName: order.branch_name,
    vehicleModel: order.vehicle_model,
    totalAmount: Number(order.total_amount || 0),
    depositPaid: Number(order.deposit_paid || 0),
    remainingAmount: Number(order.remaining_amount || 0),
    status: order.status,
    pdfAvailable: order.document_status === 'ready',
    hasUncertainAction: Boolean(order.has_uncertain_action)
  };
}

function mapOrderDetail(detail) {
  const order = detail?.order || {};
  const snapshot = order.snapshot || {};
  return {
    orderId: order.id,
    orderNumber: order.order_number || order.legacy_order_number,
    sentAt: order.finalized_at,
    customerName: order.customer_name,
    customerPhone: order.customer_phone_e164,
    branchId: order.branch_id,
    branchName: snapshot.branch?.name || '',
    receptionDate: snapshot.dates?.reception || '',
    deliveryDate: snapshot.dates?.delivery || '',
    vehicleModel: snapshot.vehicle?.model || '',
    vehicleYear: snapshot.vehicle?.year || '',
    vehicleColor: snapshot.vehicle?.color || '',
    plateCountry: snapshot.vehicle?.plateCountry || '',
    plateNumber: snapshot.vehicle?.plateNumber || '',
    paymentMethod: snapshot.paymentMethod || '',
    services: Array.isArray(snapshot.services) ? snapshot.services : [],
    totalAmount: Number(order.total_amount || 0),
    depositPaid: Number(order.deposit_paid || 0),
    remainingAmount: Number(order.remaining_amount || 0),
    status: order.status,
    version: Number(order.version || 0),
    pdfAvailable: detail?.document?.status === 'ready',
    hasUncertainAction: Array.isArray(detail?.actions) && detail.actions.some((action) => action.status === 'uncertain')
  };
}

function errorStatus(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (['AUTH_REQUIRED', 'INVALID_CREDENTIALS'].includes(error?.code)) return 401;
  if (['INVALID_IDENTIFIER', 'INVALID_ORDER_DATA', 'INVALID_ACTION'].includes(error?.code)) return 400;
  if (String(error?.code || '').includes('CONFLICT') || error?.code === '40001') return 409;
  if (String(error?.code || '').includes('DENIED') || error?.code === '42501') return 403;
  return 503;
}

function responseError(res, error) {
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(String(error?.code || ''))
    ? error.code
    : 'CLOUD_REQUEST_FAILED';
  return res.status(errorStatus(error)).json({ ok: false, code });
}

function allowLoginAttempt(key) {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 5 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  loginAttempts.set(key, recent);
  if (loginAttempts.size > 1000) {
    for (const [candidate, values] of loginAttempts) {
      if (!values.some((time) => now - time < 5 * 60 * 1000)) loginAttempts.delete(candidate);
    }
  }
  return true;
}

async function requireUsableSession(runtime, options = {}) {
  const status = await runtime.status({ allowOffline: options.allowOffline !== false });
  if (!status.authenticated) {
    throw Object.assign(new Error('Sign-in is required'), { code: 'AUTH_REQUIRED', status: 401 });
  }
  if (status.deviceState !== 'approved') {
    throw Object.assign(new Error('Device approval is required'), { code: 'DEVICE_NOT_APPROVED', status: 403 });
  }
  if (status.mode === 'locked' || (!options.allowOffline && status.mode !== 'online')) {
    throw Object.assign(new Error('An online verification is required'), { code: 'ONLINE_VERIFICATION_REQUIRED', status: 423 });
  }
  return status;
}

async function requireSystemAdministrator(runtime) {
  const status = await requireUsableSession(runtime, { allowOffline: false });
  if (!status.systemAdmin || !status.mfaVerified) {
    throw Object.assign(new Error('System administrator with MFA is required'), {
      code: 'SYSTEM_ADMIN_WITH_AAL2_REQUIRED',
      status: 403
    });
  }
  return status;
}

function createCloudRouter(options) {
  const {
    getRuntime,
    upload,
    runExclusiveSend,
    deliverWhatsApp
  } = options;
  const router = express.Router();

  function runtime() {
    const value = getRuntime();
    if (!value?.enabled) {
      throw Object.assign(new Error('Central database is disabled'), { code: 'CLOUD_DISABLED', status: 404 });
    }
    return value;
  }

  router.get('/auth/status', async (req, res) => {
    try {
      const value = runtime();
      res.json({ ok: true, ...(await value.status()) });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/auth/login', async (req, res) => {
    const key = `${req.ip || req.socket.remoteAddress || 'loopback'}:${cleanText(req.body?.email, 200).toLowerCase()}`;
    if (!allowLoginAttempt(key)) return res.status(429).json({ ok: false, code: 'LOGIN_RATE_LIMITED' });
    try {
      const result = await runtime().signIn(req.body?.email, req.body?.password);
      res.status(result.deviceState === 'approved' ? 200 : 202).json({ ok: true, ...result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/auth/mfa', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      res.json({ ok: true, ...(await value.listMfaFactors()) });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/auth/mfa/enroll', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      const enrollment = await value.enrollMfa(cleanText(req.body?.friendlyName, 100));
      res.status(201).json({ ok: true, enrollment });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/auth/mfa/verify', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      const factorId = uuid(req.body?.factorId, 'factor id');
      const code = String(req.body?.code || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(code)) {
        throw Object.assign(new Error('Invalid verification code'), { code: 'INVALID_MFA_CODE', status: 400 });
      }
      await value.verifyMfa(factorId, code);
      res.json({ ok: true, ...(await value.status({ allowOffline: false })) });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/auth/logout', async (req, res) => {
    try {
      await runtime().signOut();
      res.json({ ok: true });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/branches', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value);
      const branches = await value.listBranches();
      res.json({
        ok: true,
        branches: branches.map((branch) => ({
          ...branch,
          configured: Boolean(normalizePhone(branch.phone))
        }))
      });
    } catch (error) {
      responseError(res, error);
    }
  });


  router.get('/admin/devices', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      res.json({ ok: true, devices: await value.adminListDevices() });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/admin/devices/:deviceId/approve', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const result = await value.approveDevice(uuid(req.params.deviceId, 'device id'));
      res.json({ ok: true, device: result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/admin/devices/:deviceId/revoke', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const reason = cleanText(req.body?.reason, 500);
      if (!reason) throw Object.assign(new Error('A reason is required'), { code: 'REASON_REQUIRED', status: 400 });
      const result = await value.revokeDevice(uuid(req.params.deviceId, 'device id'), reason);
      res.json({ ok: true, device: result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/admin/branches', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const branchId = req.body?.branchId ? uuid(req.body.branchId, 'branch id') : null;
      const code = cleanText(req.body?.code, 20).toUpperCase();
      const name = cleanText(req.body?.name, 160);
      const phone = cleanText(req.body?.phone, 20) ? normalizePhone(req.body.phone) : '';
      if (!code || !name || phone === null) {
        throw Object.assign(new Error('Invalid branch data'), { code: 'INVALID_BRANCH_DATA', status: 400 });
      }
      const result = await value.adminUpsertBranch(branchId, code, name, phone, req.body?.active !== false);
      res.json({ ok: true, branch: result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/admin/users', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      res.json({ ok: true, users: await value.adminListUsers() });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/admin/users', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const action = cleanText(req.body?.action, 30);
      if (!['create', 'enable', 'disable', 'reset_password'].includes(action)) {
        throw Object.assign(new Error('Unsupported administration action'), { code: 'UNSUPPORTED_ACTION', status: 400 });
      }
      const payload = {
        action,
        userId: req.body?.userId,
        email: cleanText(req.body?.email, 254),
        username: cleanText(req.body?.username, 64),
        displayName: cleanText(req.body?.displayName, 160),
        temporaryPassword: String(req.body?.temporaryPassword || ''),
        assignments: Array.isArray(req.body?.assignments) ? req.body.assignments.slice(0, 50) : []
      };
      const result = await value.adminUserOperation(payload);
      res.status(action === 'create' ? 201 : 200).json(result);
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/admin/users/:userId/revoke-sessions', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const reason = cleanText(req.body?.reason, 500);
      if (!reason) throw Object.assign(new Error('A reason is required'), { code: 'REASON_REQUIRED', status: 400 });
      const result = await value.adminRevokeSessions(uuid(req.params.userId, 'user id'), reason);
      res.json({ ok: true, result });
    } catch (error) {
      responseError(res, error);
    }
  });
  router.post('/admin/users/:userId/release-publisher', async (req, res) => {
    try {
      const value = runtime();
      await requireSystemAdministrator(value);
      const result = await value.adminSetReleasePublisher(
        uuid(req.params.userId, 'user id'),
        req.body?.active === true
      );
      res.json({ ok: true, result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/draft', async (req, res) => {
    try {
      const value = runtime();
      const status = await requireUsableSession(value);
      res.json({ ok: true, mode: status.mode, draft: value.loadDraft() });
    } catch (error) {
      responseError(res, error);
    }
  });
  router.put('/draft', async (req, res) => {
    try {
      const value = runtime();
      const status = await requireUsableSession(value);
      value.saveDraft(req.body?.draft || {});
      res.json({ ok: true, mode: status.mode });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.delete('/draft', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value);
      value.deleteDraft();
      res.json({ ok: true });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/orders/finalize', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      const commandId = uuid(req.body?.commandId || crypto.randomUUID(), 'command id');
      const branchId = uuid(req.body?.branchId, 'branch id');
      const result = await value.finalizeOrder(commandId, branchId, cleanDraft(req.body?.draft), Number(req.body?.expectedVersion || 0));
      res.status(201).json({ ok: true, commandId, order: result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/orders/:orderId/document', upload.single('pdf'), async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      if (!req.file?.buffer) {
        throw Object.assign(new Error('PDF is required'), { code: 'PDF_REQUIRED', status: 400 });
      }
      const orderId = uuid(req.params.orderId, 'order id');
      const commandId = uuid(req.body?.commandId || crypto.randomUUID(), 'command id');
      const existing = await value.getOrder(orderId);
      if (existing?.document?.status === 'ready') {
        const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        if (existing.document.sha256 !== sha256) {
          throw Object.assign(new Error('The finalized document differs from this upload'), {
            code: 'DOCUMENT_ALREADY_FINAL',
            status: 409
          });
        }
        value.cacheDocument(orderId, req.file.buffer);
        return res.json({ ok: true, commandId, idempotent: true, document: existing.document });
      }
      const result = await value.uploadDocument(
        orderId,
        req.file.buffer,
        commandId,
        Number(existing?.document?.version || 1)
      );
      res.status(201).json({ ok: true, commandId, document: result });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/orders/:orderId/actions', async (req, res) => {
    let value;
    let orderId;
    let actionId;
    let commandId;
    let channel;
    let targetStatus;
    let expectedVersion;
    let receipt;
    try {
      value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      orderId = uuid(req.params.orderId, 'order id');
      actionId = uuid(req.body?.actionId, 'action id');
      commandId = uuid(req.body?.commandId || crypto.randomUUID(), 'command id');
      channel = String(req.body?.channel || '');
      targetStatus = String(req.body?.targetStatus || '');
      expectedVersion = Number(req.body?.expectedVersion || 0);
      receipt = req.body?.receipt || {};
      if (!ACTION_CHANNELS.has(channel) || !ACTION_STATES.has(targetStatus)) {
        throw Object.assign(new Error('Invalid action transition'), { code: 'INVALID_ACTION', status: 400 });
      }
      const result = await value.recordAction(
        commandId,
        orderId,
        actionId,
        channel,
        targetStatus,
        receipt,
        expectedVersion
      );
      res.json({ ok: true, commandId, action: result });
    } catch (error) {
      if (value && commandId && ['succeeded', 'failed_before_effect', 'uncertain'].includes(targetStatus)
          && errorStatus(error) >= 500) {
        value.queueRecovery(commandId, {
          operation: 'action-transition',
          orderId,
          actionId,
          channel,
          targetStatus,
          receipt,
          expectedVersion
        });
        return res.status(202).json({
          ok: true,
          commandId,
          queuedForRecovery: true,
          action: { actionId, status: targetStatus, version: expectedVersion + 1 }
        });
      }
      responseError(res, error);
    }
  });

  router.post('/orders/:orderId/send-whatsapp', async (req, res) => {
    let value;
    let orderId;
    let actionId;
    let actionVersion = 0;
    let effectStarted = false;
    try {
      value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      orderId = uuid(req.params.orderId, 'order id');
      actionId = uuid(req.body?.actionId || crypto.randomUUID(), 'action id');
      const detail = await value.getOrder(orderId);
      const phone = normalizePhone(detail?.order?.customer_phone_e164);
      if (!phone) throw Object.assign(new Error('Order phone is invalid'), { code: 'INVALID_PHONE', status: 400 });

      const queued = await value.recordAction(crypto.randomUUID(), orderId, actionId, 'whatsapp', 'queued', {}, 0);
      actionVersion = Number(queued.version);
      const started = await value.recordAction(
        crypto.randomUUID(), orderId, actionId, 'whatsapp', 'in_progress', {}, actionVersion
      );
      actionVersion = Number(started.version);

      let pdf = value.getCachedDocument(orderId);
      if (!pdf) pdf = await value.downloadDocument(orderId);
      const result = await runExclusiveSend(async () => {
        return deliverWhatsApp({
          phone,
          pdf,
          caption: cleanText(req.body?.caption, 1000) || `Blue Shark service order ${detail.order.order_number}`
        });
      });
      effectStarted = true;

      const succeeded = await value.recordAction(
        crypto.randomUUID(),
        orderId,
        actionId,
        'whatsapp',
        'succeeded',
        { messageId: result.messageId },
        actionVersion
      );
      res.json({ ok: true, orderId, action: succeeded, messageId: result.messageId });
    } catch (error) {
      if (value && orderId && actionId && actionVersion > 0) {
        const targetStatus = effectStarted || error?.externalEffectStarted ? 'uncertain' : 'failed_before_effect';
        const commandId = crypto.randomUUID();
        const recovery = {
          operation: 'action-transition',
          orderId,
          actionId,
          channel: 'whatsapp',
          targetStatus,
          receipt: { failureCode: error?.code || 'SEND_FAILED' },
          expectedVersion: actionVersion
        };
        try {
          await value.recordAction(
            commandId,
            orderId,
            actionId,
            recovery.channel,
            recovery.targetStatus,
            recovery.receipt,
            recovery.expectedVersion
          );
        } catch {
          value.queueRecovery(commandId, recovery);
        }
        if (targetStatus === 'uncertain') {
          error = Object.assign(new Error('Delivery outcome is uncertain'), { code: 'DELIVERY_UNCERTAIN', status: 500 });
        }
      }
      responseError(res, error);
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value);
      let orders = (await value.listOrders(req.query.beforeId || null, Number(req.query.limit || 200))).map(mapOrderSummary);
      const search = cleanText(req.query.search, 120).toLowerCase();
      const branchId = cleanText(req.query.branchId, 50);
      const from = cleanText(req.query.from, 20);
      const to = cleanText(req.query.to, 20);
      if (search) {
        orders = orders.filter((order) => [order.orderNumber, order.customerName, order.customerPhone]
          .some((candidate) => String(candidate || '').toLowerCase().includes(search)));
      }
      if (branchId) orders = orders.filter((order) => order.branchId === branchId);
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) orders = orders.filter((order) => String(order.sentAt || '').slice(0, 10) >= from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) orders = orders.filter((order) => String(order.sentAt || '').slice(0, 10) <= to);
      res.json({ ok: true, orders });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/orders/:orderId', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value);
      const detail = await value.getOrder(uuid(req.params.orderId, 'order id'));
      res.json({ ok: true, order: mapOrderDetail(detail) });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/orders/:orderId/pdf', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value);
      const orderId = uuid(req.params.orderId, 'order id');
      const pdf = value.getCachedDocument(orderId) || await value.downloadDocument(orderId);
      res.type('application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="Blue_Shark_Order.pdf"');
      res.send(pdf);
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/sync', async (req, res) => {
    try {
      const value = runtime();
      await requireUsableSession(value, { allowOffline: false });
      const recovered = await value.drainOutbox(100);
      const hasExplicitCursor = req.body && Object.prototype.hasOwnProperty.call(req.body, 'afterEventId');
      const changes = hasExplicitCursor
        ? await value.syncChanges(Number(req.body.afterEventId || 0), Number(req.body?.limit || 500))
        : await value.syncFromCursor(Number(req.body?.limit || 500));
      res.json({ ok: true, recovered, ...changes });
    } catch (error) {
      responseError(res, error);
    }
  });

  return router;
}

module.exports = {
  createCloudRouter,
  cleanDraft,
  normalizePhone,
  requireUsableSession,
  UUID_PATTERN
};
