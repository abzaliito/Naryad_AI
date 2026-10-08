import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import webPush from 'web-push';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openStore, verifyPin, hashPin } from './db.mjs';
import { assessOrder, aiProvider, answerAssistant } from './ai.mjs';
import { buildAuditLog, catalogAuditDetails } from './audit.mjs';
import { deliverWeeklySummary } from './weekly-summary.mjs';
import { buildScopedAnomalyAnswer, buildScopedSummaryAnswer, parseAssistantScope } from './assistant-scope.mjs';
import { photoSignature } from './photo-evidence.mjs';
import { calculateRatings, calculateBrigadeRatings, filterOrders, getEquipmentStats, getWorkerWorkload } from '../src/domain.ts';

const CATALOGS = ['sites', 'equipment', 'brigades', 'faults', 'materials', 'users'];
const PRIORITIES = ['emergency', 'high', 'normal', 'planned'];
const PRIORITY_LABELS = { emergency: 'Аварийный', high: 'Высокий', normal: 'Обычный', planned: 'Плановый' };
const ROLES = ['master', 'worker', 'manager', 'admin'];
const TERMINAL = ['closed', 'cancelled'];
const WORKER_TRANSITIONS = { issued: ['accepted', 'queued', 'rejected'], queued: ['accepted', 'rejected'], accepted: ['in_progress'], in_progress: ['paused'], paused: ['in_progress'], rework: ['in_progress'] };
const STATUS_LABELS = { issued: 'Выдан', accepted: 'Принят в работу', queued: 'В очереди', rejected: 'Отклонён', in_progress: 'В работе', paused: 'Приостановлен', completed: 'Исполнено', ai_review: 'Проверка ИИ', rework: 'На доработку', closed: 'Закрыт', cancelled: 'Отменён' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const text = (value, max = 5000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const requireText = (value, label, max) => { const result = text(value, max); if (!result) fail(400, `Заполните поле «${label}».`); return result; };
const validDate = (value, label) => { if (!value || !Number.isFinite(Date.parse(value))) fail(400, `Некорректная дата: ${label}.`); return new Date(value).toISOString(); };
const range = (value, min, max, label) => { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) fail(400, `${label}: допустимо от ${min} до ${max}.`); return result; };

export function createApplication(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  mkdirSync(uploadDir, { recursive: true });
  const store = openStore(dataDir, options.seedData);
  const app = express();
  const clients = new Set();
  const reviewJobs = new Map();
  const pendingUploads = new Map();
  const loginAttempts = new Map();
  let stopping = false;
  const cookieName = 'naryad_session';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 12 * 3600000 };
  let vapid = store.setting('vapid', null);
  if (!vapid) { vapid = webPush.generateVAPIDKeys(); store.setSetting('vapid', vapid); }
  webPush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@example.invalid', vapid.publicKey, vapid.privateKey);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.path.startsWith('/api/') && req.path !== '/api/uploads') {
        req.body ??= {};
        if (typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Ожидается JSON-объект.' });
      }
      const origin = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
      if (origin) {
        try {
          const url = new URL(origin);
          const requested = new URL(`${req.protocol}://${req.headers.host}`);
          const allowed = (process.env.APP_ORIGIN ?? '').split(',').map(item => item.trim()).filter(Boolean);
          const localDev = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.hostname === requested.hostname;
          if (url.origin !== requested.origin && !allowed.includes(url.origin) && !localDev) return res.status(403).json({ error: 'Недопустимый источник запроса.' });
        } catch { return res.status(403).json({ error: 'Недопустимый источник запроса.' }); }
      }
    }
    next();
  });

  function cookieToken(req) {
    return (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }
  function revokeSession(sessionHash) {
    store.transaction(() => {
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash);
      for (const subscription of store.list('subscriptions')) if (subscription.sessionHash === sessionHash) store.remove('subscriptions', subscription.id);
    });
    for (const client of clients) if (client.sessionHash === sessionHash) { client.res.end(); clients.delete(client); }
  }
  function authenticate(req, res, next) {
    const token = cookieToken(req);
    const session = token && store.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').get(sha(token));
    if (!session || session.expires_at < Date.now()) return res.status(401).json({ error: 'Войдите в систему.' });
    req.user = store.get('users', session.user_id);
    if (!req.user) return res.status(401).json({ error: 'Учётная запись не найдена.' });
    req.sessionHash = sha(token);
    next();
  }
  const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'Для вашей роли это действие недоступно.' });
  const visible = (order, user) => user.role !== 'worker' || order.assigneeId === user.id;
  function verifyRequestOwner(req) {
    if (req.body.ownerId !== undefined && req.body.ownerId !== req.user.id) fail(403, 'Действие сохранено под другой учётной записью. Войдите под его автором.');
  }
  function orderFor(req, mutate = false) {
    verifyRequestOwner(req);
    const order = store.get('orders', req.params.id);
    if (!order) fail(404, 'Наряд не найден.');
    if (!visible(order, req.user)) fail(403, 'Доступен только ваш наряд.');
    if (mutate && req.body.version !== undefined && req.body.version !== order.version) fail(409, 'Наряд изменился. Обновите карточку и повторите действие.');
    return order;
  }
  function catalog(kind, id, label) {
    const item = typeof id === 'string' && store.get(kind, id);
    if (!item) fail(400, `${label} не найден в справочнике.`);
    return item;
  }
  function catalogRecord(kind, input, existing) {
    if (!CATALOGS.includes(kind)) fail(400, 'Неизвестный справочник.');
    const body = { ...existing, ...input };
    const record = { id: existing?.id ?? randomUUID(), name: requireText(body.name, 'Название', 160) };
    if (kind === 'equipment') {
      catalog('sites', body.siteId, 'Участок'); record.siteId = body.siteId; record.inventory = requireText(body.inventory, 'Инвентарный номер', 80); record.type = requireText(body.type, 'Тип', 100); record.criticality = text(body.criticality, 50) || 'normal';
      if (store.list(kind).some(item => item.id !== record.id && item.inventory === record.inventory)) fail(409, 'Инвентарный номер уже существует.');
    }
    if (kind === 'faults') {
      record.code = requireText(body.code, 'Шифр', 50); record.specialty = requireText(body.specialty, 'Специальность', 100); record.normHours = range(body.normHours, 0.01, 1000, 'Норматив');
      if (store.list(kind).some(item => item.id !== record.id && item.code === record.code)) fail(409, 'Шифр уже существует.');
    }
    if (kind === 'materials') { record.unit = requireText(body.unit, 'Единица измерения', 20); record.normalQuantity = range(body.normalQuantity, 0.001, 1000000, 'Обычный расход'); }
    if (kind === 'users') {
      if (!ROLES.includes(body.role)) fail(400, 'Недопустимая роль.');
      record.login = requireText(body.login, 'Логин', 80).toLowerCase();
      if (!/^[a-z\d_.-]{3,80}$/.test(record.login)) fail(400, 'Логин: 3–80 латинских букв, цифр, точек, дефисов.');
      if ((!existing || input.pin !== undefined) && (typeof input.pin !== 'string' || !/^\d{4,12}$/.test(input.pin))) fail(400, 'ПИН должен содержать от 4 до 12 цифр.');
      if (store.db.prepare('SELECT user_id FROM auth WHERE lower(login)=? AND user_id<>?').get(record.login, record.id)) fail(409, 'Логин уже существует.');
      if (body.onShift !== undefined && typeof body.onShift !== 'boolean') fail(400, 'Статус смены должен быть логическим значением.');
      record.role = body.role; record.specialty = text(body.specialty, 100); record.grade = body.grade == null ? null : range(body.grade, 1, 8, 'Разряд');
      if (record.grade !== null && !Number.isInteger(record.grade)) fail(400, 'Разряд должен быть целым числом.');
      record.onShift = body.onShift !== false; record.avatar = record.name.split(/\s+/).slice(0, 2).map(item => item[0]).join('');
      record.brigadeId = body.brigadeId || null;
      if (record.brigadeId) catalog('brigades', record.brigadeId, 'Бригада');
      if (existing?.role === 'admin' && record.role !== 'admin' && !store.list('users').some(user => user.id !== record.id && user.role === 'admin')) fail(409, 'Нельзя изменить роль последнего администратора.');
      if (existing?.role === 'worker' && record.role !== 'worker' && store.list('orders').some(order => order.assigneeId === record.id && !TERMINAL.includes(order.status))) fail(409, 'Сначала переназначьте или завершите действующие наряды исполнителя.');
    }
    return record;
  }
  function executionTime(body, order, minimum = order.createdAt) {
    const receivedAt = iso();
    if (body.recordedAt === undefined) return { receivedAt, effectiveAt: receivedAt };
    const recordedAt = typeof body.recordedAt === 'string' ? body.recordedAt.slice(0, 80) : '[invalid type]';
    const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(recordedAt) ? Date.parse(recordedAt) : NaN;
    const now = Date.parse(receivedAt);
    const valid = Number.isFinite(candidate) && candidate >= Math.max(Date.parse(order.createdAt), Date.parse(minimum)) && candidate <= now + 300000;
    // Small positive clock drift is accepted, but cannot move execution into the future.
    return { receivedAt, recordedAt, effectiveAt: valid ? new Date(Math.min(candidate, now)).toISOString() : receivedAt, timeSource: valid ? 'device' : 'server-fallback' };
  }
  function event(order, actor, action, comment = '', toStatus, timing) {
    const fromStatus = order.status;
    order.events ??= [];
    const deviceNote = timing?.timeSource ? `Время устройства: ${timing.recordedAt || '[пусто]'}. ${timing.timeSource === 'device' ? 'Учтено для расчёта исполнения; время получения сервером сохранено отдельно.' : 'Некорректное время устройства: для расчёта принято время сервера.'}` : '';
    order.events.push({ id: randomUUID(), actorId: actor?.id ?? 'system', actorName: actor?.name ?? 'НарядAI', action, at: timing?.receivedAt ?? iso(), comment: [comment, deviceNote].filter(Boolean).join(' '), ...(toStatus ? { fromStatus, toStatus } : {}), ...(timing?.timeSource ? { recordedAt: timing.recordedAt, effectiveAt: timing.effectiveAt, timeSource: timing.timeSource } : {}) });
    if (toStatus) order.status = toStatus;
  }
  function broadcast() {
    const chunk = `event: changed\ndata: ${JSON.stringify({ at: iso() })}\n\n`;
    for (const client of clients) client.res.write(chunk);
  }
  function save(order) { order.version = (order.version ?? 0) + 1; store.put('orders', order); broadcast(); return order; }
  function notify(userId, order, title, message, kind = 'info', dedupKey) {
    if (!userId || !store.get('users', userId)) return;
    if (dedupKey && store.get('notificationKeys', dedupKey)) return;
    const notification = { id: randomUUID(), userId, orderId: order?.id, title, message, kind, createdAt: iso(), read: false };
    store.transaction(() => {
      store.put('notifications', notification);
      if (dedupKey) store.put('notificationKeys', { id: dedupKey, at: Date.now() });
    });
    for (const subscription of store.list('subscriptions').filter(item => item.userId === userId)) {
      void Promise.resolve().then(() => webPush.sendNotification(subscription.subscription, JSON.stringify({ title, body: message, orderId: order?.id, urgent: kind === 'danger' }))).catch(error => {
        if (!stopping && [404, 410].includes(error.statusCode)) store.remove('subscriptions', subscription.id);
      });
    }
    broadcast();
  }
  function notifyParticipants(order, title, message, kind = 'info', key) {
    for (const userId of new Set([order.assigneeId, order.masterId])) notify(userId, order, title, message, kind, key ? `${key}:${userId}` : undefined);
  }
  function assignPhotos(photoIds, user, orderId, kind) {
    if (!Array.isArray(photoIds) || photoIds.length > 5) fail(400, 'Можно приложить не более 5 фотографий.');
    if (new Set(photoIds).size !== photoIds.length) fail(400, 'Фотография приложена повторно.');
    return photoIds.map(id => {
      const photo = typeof id === 'string' && store.get('photos', id);
      if (!photo || photo.authorId !== user.id || photo.kind !== kind || (photo.orderId && photo.orderId !== orderId)) fail(403, 'Фото недоступно, имеет другой тип или относится к другому наряду.');
      return { ...photo, orderId };
    });
  }
  function bindPhotos(photos) { for (const photo of photos) store.put('photos', photo); }
  function retryRecord(req, kind, fingerprint) {
    if (req.body.requestId === undefined) return null;
    if (typeof req.body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?::\d{1,2})?$/i.test(req.body.requestId)) fail(400, 'Некорректный идентификатор повторного запроса.');
    const id = sha(`${kind}:${req.user.id}:${req.params.id ?? req.body.orderId ?? 'new'}:${req.body.requestId}`);
    const bodyHash = sha(JSON.stringify(fingerprint));
    const saved = store.get('requests', id);
    if (saved && saved.bodyHash !== bodyHash) fail(409, 'Идентификатор запроса уже использован с другими данными.');
    return { id, kind, actorId: req.user.id, bodyHash, saved };
  }
  function saveRetry(retry, response) { if (retry) store.put('requests', { id: retry.id, kind: retry.kind, actorId: retry.actorId, bodyHash: retry.bodyHash, at: iso(), response }); }
  function archiveCompletion(order, reason) {
    if (!order.completion) return;
    order.completionHistory ??= [];
    order.completionHistory.push({ assigneeId: order.assigneeId, completion: order.completion, assessment: order.assessment, completedAt: order.completedAt ?? order.completion.submittedAt, photos: (order.photos ?? []).filter(photo => photo.kind === 'after'), archivedAt: iso(), reason });
  }
  async function review(id) {
    if (reviewJobs.has(id)) return reviewJobs.get(id);
    const job = (async () => {
      const snapshot = store.get('orders', id);
      if (snapshot?.status !== 'ai_review' || snapshot.assessment) return;
      const assessment = await assessOrder(snapshot, store, uploadDir);
      if (stopping) return;
      const order = store.get('orders', id);
      if (order?.status !== 'ai_review' || order.assessment || order.completion?.submittedAt !== snapshot.completion?.submittedAt) return;
      order.assessment = assessment;
      event(order, null, 'Проверка ИИ завершена', assessment.summary, assessment.verdict === 'rework' ? 'rework' : undefined);
      save(order);
      notifyParticipants(order, assessment.verdict === 'rework' ? 'Наряд возвращён на доработку' : 'Отчёт ИИ готов', `№${order.number}: ${assessment.score}/5. ${assessment.summary}`, assessment.verdict === 'rework' ? 'warning' : 'success');
    })().catch(error => { if (!stopping && error?.code !== 'busy') console.error('Не удалось завершить проверку наряда:', id, error.message); }).finally(() => reviewJobs.delete(id));
    reviewJobs.set(id, job);
    return job;
  }
  function sweepDeadlines(at = new Date()) {
    const now = new Date(at).getTime();
    const reminder = store.setting('reminderMinutes', 30) * 60000;
    const repeat = store.setting('repeatMinutes', 30) * 60000;
    const orders = store.list('orders');
    const people = store.list('users');
    for (const order of orders) {
      if (['completed', 'ai_review', 'closed', 'cancelled', 'rejected'].includes(order.status)) continue;
      const due = Date.parse(order.dueAt);
      if (!Number.isFinite(due)) continue;
      const time = due - now;
      const worker = store.get('users', order.assigneeId);
      const equipment = store.get('equipment', order.equipmentId);
      const site = store.get('sites', order.siteId);
      const lastComment = [...(order.events ?? [])].reverse().find(item => item.comment)?.comment || order.comment || 'нет';
      const context = `${equipment?.name ?? order.equipmentId}, ${site?.name ?? order.siteId}. Исполнитель: ${worker?.name ?? order.assigneeId}. Статус: ${STATUS_LABELS[order.status]}. Последний комментарий: ${lastComment.slice(0, 400)}.`;
      if (order.status === 'issued') {
        const issuedAt = [...(order.events ?? [])].reverse().find(item => item.toStatus === 'issued')?.at ?? order.createdAt;
        const threshold = order.priority === 'emergency' ? 3 : 10;
        if (now - Date.parse(issuedAt) >= threshold * 60000) {
          const specialty = store.get('faults', order.faultId ?? '')?.specialty || worker?.specialty;
          const candidate = people.find(person => person.role === 'worker' && person.id !== order.assigneeId && person.onShift && (!specialty || person.specialty === specialty) && !orders.some(item => item.assigneeId === person.id && ['in_progress', 'accepted', 'paused', 'rework'].includes(item.status)));
          notify(order.masterId, order, 'Наряд не принят — требуется решение', `№${order.number} без ответа более ${threshold} мин. ${context} ${candidate ? `Свободный кандидат: ${candidate.name}; переназначение решает мастер.` : 'Свободного сотрудника подходящей специальности не найдено.'}`, 'warning', `unaccepted:${order.id}:${issuedAt}:${order.assigneeId}`);
        }
      }
      if (time < 0) {
        const slot = Math.floor(-time / repeat);
        const message = `№${order.number}: просрочен на ${Math.ceil(-time / 60000)} мин. ${context} Уточните причину и план завершения.`;
        notifyParticipants(order, 'Наряд просрочен', message, 'danger', `late:${order.id}:${order.dueAt}:${slot}`);
        if (-time >= 3600000) for (const manager of people.filter(person => person.role === 'manager')) notify(manager.id, order, 'Длительная просрочка наряда', message, 'danger', `long-overdue:${order.id}:${order.dueAt}:${slot}:${manager.id}`);
      } else if (time <= reminder) {
        notify(order.assigneeId, order, 'Приближается срок исполнения', `№${order.number}: осталось ${Math.ceil(time / 60000)} мин.`, 'warning', `soon:${order.id}:${order.dueAt}:${order.assigneeId}`);
      }
    }
    store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, aiProvider: aiProvider() }));
  app.post('/api/auth/login', (req, res) => {
    const login = text(req.body.login, 80).toLowerCase();
    const attemptKey = `${req.ip}:${login}`;
    const attempt = loginAttempts.get(attemptKey);
    if (attempt && attempt.count >= 10 && attempt.until > Date.now()) return res.status(429).json({ error: 'Слишком много попыток. Повторите через 15 минут.' });
    if (typeof req.body.pin !== 'string' || req.body.pin.length > 128) fail(400, 'Введите ПИН-код.');
    const auth = store.db.prepare('SELECT user_id, pin_hash FROM auth WHERE lower(login)=?').get(login);
    if (!auth || !verifyPin(req.body.pin, auth.pin_hash)) {
      loginAttempts.set(attemptKey, { count: attempt?.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 900000 });
      return res.status(401).json({ error: 'Неверный логин или ПИН-код.' });
    }
    loginAttempts.delete(attemptKey);
    const old = cookieToken(req); if (old) revokeSession(sha(old));
    const token = randomBytes(32).toString('hex');
    store.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), auth.user_id, Date.now() + cookieOptions.maxAge);
    res.cookie(cookieName, token, cookieOptions).json({ user: store.get('users', auth.user_id) });
  });
  app.use('/api', authenticate);
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.get('/api/audit', (req, res) => res.json(buildAuditLog(store, req.user, req.query, visible)));
  app.post('/api/auth/logout', (req, res) => {
    revokeSession(req.sessionHash);
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  app.get('/api/bootstrap', (req, res) => res.json({
    user: req.user,
    catalogs: Object.fromEntries(CATALOGS.map(kind => [kind, store.list(kind)])),
    orders: store.list('orders').filter(order => visible(order, req.user)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    notifications: store.list('notifications').filter(item => item.userId === req.user.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 300),
    settings: { reminderMinutes: store.setting('reminderMinutes', 30), repeatMinutes: store.setting('repeatMinutes', 30), aiProvider: aiProvider() }, serverTime: iso(),
  }));
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders(); res.write(`event: connected\ndata: ${JSON.stringify({ at: iso() })}\n\n`);
    const client = { res, userId: req.user.id, sessionHash: req.sessionHash }; clients.add(client);
    req.on('close', () => clients.delete(client));
  });

  app.post('/api/orders', roles('master'), (req, res) => {
    const body = req.body;
    const equipment = catalog('equipment', body.equipmentId, 'Оборудование');
    catalog('sites', body.siteId, 'Участок');
    if (equipment.siteId !== body.siteId) fail(400, 'Оборудование относится к другому участку.');
    const assignee = catalog('users', body.assigneeId, 'Исполнитель');
    if (assignee.role !== 'worker') fail(400, 'Выберите сотрудника с ролью исполнителя.');
    if (!assignee.onShift) fail(400, 'Исполнитель не на смене.');
    if (body.brigadeId) {
      catalog('brigades', body.brigadeId, 'Бригада');
      if (assignee.brigadeId !== body.brigadeId) fail(400, 'Исполнитель не состоит в выбранной бригаде.');
    }
    if (body.faultId) catalog('faults', body.faultId, 'Шифр неисправности');
    if (!['planned', 'unplanned'].includes(body.type) || !PRIORITIES.includes(body.priority)) fail(400, 'Некорректный тип или приоритет наряда.');
    const description = requireText(body.description, 'Описание работ');
    const dueAt = validDate(body.dueAt, 'Срок исполнения');
    if (Date.parse(dueAt) < Date.now() - 60000) fail(400, 'Срок нового наряда должен быть в будущем.');
    const id = randomUUID(); const sequence = store.setting('sequence', 1000) + 1;
    const photos = assignPhotos(body.photoIds ?? [], req.user, id, 'before');
    const order = { id, number: String(sequence).padStart(5, '0'), title: text(body.title, 160) || description.slice(0, 90), description, type: body.type, siteId: body.siteId, equipmentId: body.equipmentId, assigneeId: assignee.id, brigadeId: body.brigadeId || assignee.brigadeId, masterId: req.user.id, priority: body.priority, status: 'issued', createdAt: iso(), dueAt, normHours: range(body.normHours ?? 2, 0.01, 1000, 'Норма часов'), faultId: body.faultId || undefined, comment: text(body.comment), version: 1, photos, events: [] };
    event(order, req.user, 'Наряд выдан', order.comment, 'issued');
    store.transaction(() => { store.setSetting('sequence', sequence); store.put('orders', order); bindPhotos(photos); });
    notify(assignee.id, order, body.priority === 'emergency' ? 'Аварийный наряд — требуется ответ' : 'Новый наряд', `№${order.number}: ${order.title}`, body.priority === 'emergency' ? 'danger' : 'info');
    broadcast(); res.status(201).json(order);
  });
  app.patch('/api/orders/:id', roles('master'), (req, res) => {
    const order = orderFor(req, true); const body = req.body;
    if (TERMINAL.includes(order.status)) fail(409, 'Закрытый или отменённый наряд изменить нельзя.');
    const changes = []; let newAssignee;
    if (body.priority !== undefined) {
      if (!PRIORITIES.includes(body.priority)) fail(400, 'Некорректный приоритет.');
      if (order.priority !== body.priority) { changes.push(`Приоритет: ${PRIORITY_LABELS[order.priority]} → ${PRIORITY_LABELS[body.priority]}`); order.priority = body.priority; }
    }
    if (body.dueAt !== undefined) {
      const dueAt = validDate(body.dueAt, 'Срок');
      if (order.dueAt !== dueAt) { const display = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda', dateStyle: 'short', timeStyle: 'short' }); changes.push(`Срок: ${display(order.dueAt)} → ${display(dueAt)} (Костанай)`); order.dueAt = dueAt; }
    }
    if (body.comment !== undefined && order.comment !== text(body.comment)) { changes.push(`Комментарий: «${order.comment || 'не указан'}» → «${text(body.comment) || 'не указан'}»`); order.comment = text(body.comment); }
    if (body.assigneeId !== undefined && body.assigneeId !== order.assigneeId) {
      if (['ai_review', 'completed'].includes(order.status)) fail(409, 'Дождитесь проверки ИИ перед переназначением.');
      newAssignee = catalog('users', body.assigneeId, 'Исполнитель');
      if (newAssignee.role !== 'worker' || !newAssignee.onShift) fail(400, 'Исполнитель должен быть на смене.');
      const previous = store.get('users', order.assigneeId)?.name ?? order.assigneeId;
      archiveCompletion(order, 'Наряд переназначен');
      order.assigneeId = newAssignee.id; order.brigadeId = newAssignee.brigadeId;
      delete order.startedAt; delete order.completedAt; delete order.completion; delete order.assessment; delete order.queuedAt; delete order.queueSequence;
      order.photos = (order.photos ?? []).filter(photo => photo.kind === 'before');
      event(order, req.user, 'Наряд переназначен', `Исполнитель: ${previous} → ${newAssignee.name}. ${text(body.comment)}`, 'issued'); changes.push(`Исполнитель: ${previous} → ${newAssignee.name}`);
    }
    if (!changes.length) fail(400, 'Нет изменений.');
    event(order, req.user, 'Карточка изменена', changes.join('; ')); save(order);
    if (newAssignee) notify(newAssignee.id, order, 'Вам переназначен наряд', `№${order.number}: ${order.title}`, order.priority === 'emergency' ? 'danger' : 'info');
    res.json(order);
  });
  app.post('/api/orders/:id/transition', roles('worker', 'master'), (req, res) => {
    const order = orderFor(req); const target = req.body.status; const reason = text(req.body.reason);
    const retry = retryRecord(req, 'transition', { status: target, reason, recordedAt: req.body.recordedAt });
    if (retry?.saved) return res.json(retry.saved.response);
    if (req.body.version !== undefined && req.body.version !== order.version) fail(409, 'Наряд изменился. Обновите карточку и повторите действие.');
    const timing = executionTime(req.body, order);
    if (req.user.role === 'master') {
      if (target !== 'cancelled' || TERMINAL.includes(order.status)) fail(403, 'Мастер может отменить действующий наряд; исполнение отмечает сотрудник.');
      if (!reason) fail(400, 'Укажите причину отмены.');
    } else {
      if (!WORKER_TRANSITIONS[order.status]?.includes(target)) fail(409, 'Недопустимый переход статуса наряда.');
      if (['rejected', 'paused'].includes(target) && !reason) fail(400, 'Укажите причину.');
      if (target === 'in_progress') {
        const current = store.list('orders').find(item => item.id !== order.id && item.assigneeId === req.user.id && item.status === 'in_progress');
        if (current) fail(409, `Сначала завершите или приостановите наряд №${current.number}.`);
        order.startedAt ??= timing.effectiveAt; delete order.completedAt;
      }
    }
    store.transaction(() => {
      if (target === 'queued') {
        order.queuedAt = iso();
        const maximum = store.list('orders').reduce((value, item) => Number.isSafeInteger(item.queueSequence) ? Math.max(value, item.queueSequence) : value, 0);
        order.queueSequence = Math.max(store.setting('queueSequence', 0), maximum) + 1;
        store.setSetting('queueSequence', order.queueSequence);
      }
      event(order, req.user, STATUS_LABELS[target], reason, target, timing);
      order.version = (order.version ?? 0) + 1;
      store.put('orders', order); saveRetry(retry, order);
    });
    broadcast();
    notify(target === 'cancelled' ? order.assigneeId : order.masterId, order, `Наряд №${order.number}: ${STATUS_LABELS[target]}`, reason || order.title, ['rejected', 'paused'].includes(target) ? 'warning' : 'info');
    res.json(order);
  });
  app.post('/api/orders/:id/complete', roles('worker'), (req, res) => {
    const order = orderFor(req); const body = req.body;
    const retry = retryRecord(req, 'complete', { works: body.works, faultId: body.faultId, materials: body.materials, materialsConfirmed: body.materialsConfirmed, comment: body.comment, photoIds: body.photoIds, recordedAt: body.recordedAt });
    if (retry?.saved) return res.json(retry.saved.response);
    if (body.version !== undefined && body.version !== order.version) fail(409, 'Наряд изменился. Обновите карточку и повторите действие.');
    if (order.status !== 'in_progress') fail(409, 'Отметить исполнение можно только для наряда в работе.');
    const timing = executionTime(body, order, order.startedAt || order.createdAt);
    if (body.faultId) catalog('faults', body.faultId, 'Шифр неисправности');
    if (!Array.isArray(body.materials ?? []) || (body.materials?.length ?? 0) > 40) fail(400, 'Некорректный список материалов.');
    if (body.materialsConfirmed !== undefined && typeof body.materialsConfirmed !== 'boolean') fail(400, 'Подтверждение расхода материалов должно быть логическим значением.');
    const materials = (body.materials ?? []).map(item => { if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, 'Некорректная позиция материала.'); catalog('materials', item.materialId, 'Материал'); return { materialId: item.materialId, quantity: range(item.quantity, 0.001, 1000000, 'Количество материала') }; });
    if (new Set(materials.map(item => item.materialId)).size !== materials.length) fail(400, 'Материал указан повторно.');
    const photos = assignPhotos(body.photoIds ?? [], req.user, order.id, 'after');
    archiveCompletion(order, 'Повторное исполнение');
    order.photos = [...(order.photos ?? []).filter(item => item.kind === 'before'), ...photos];
    order.completion = { works: text(body.works), faultId: body.faultId || '', materials, materialsConfirmed: body.materialsConfirmed ?? Array.isArray(body.materials), comment: text(body.comment), submittedAt: iso() };
    order.completedAt = timing.effectiveAt; delete order.assessment;
    event(order, req.user, 'Исполнение отмечено', order.completion.comment, 'completed', timing);
    event(order, null, 'Отправлен на обязательную проверку ИИ', '', 'ai_review');
    store.transaction(() => { bindPhotos(photos); order.version++; store.put('orders', order); saveRetry(retry, order); }); broadcast();
    notify(order.masterId, order, 'Наряд исполнен', `№${order.number} передан на проверку ИИ.`, 'info');
    res.json(order); void review(order.id);
  });
  app.post('/api/orders/:id/review', roles('master'), (req, res) => {
    const order = orderFor(req, true); const { decision, score } = req.body; const comment = text(req.body.comment);
    if (order.status !== 'ai_review' || !order.assessment) fail(409, 'Закрытие доступно только после завершённой проверки ИИ.');
    if (!['close', 'rework'].includes(decision)) fail(400, 'Выберите решение.');
    if (decision === 'rework' && !comment) fail(400, 'Укажите замечания для доработки.');
    let auditComment = comment;
    if (score !== undefined) {
      const value = range(score, 1, 5, 'Оценка'); if (!Number.isInteger(value)) fail(400, 'Оценка должна быть целой.');
      if (value !== order.assessment.score && !comment) fail(400, 'Объясните изменение оценки ИИ.');
      if (value !== order.assessment.score) auditComment = `Оценка: ${order.assessment.score} → ${value}. ${comment}`;
      order.assessment.masterScore = value;
    }
    order.assessment.masterComment = comment;
    if (decision === 'close') order.closedAt = iso();
    event(order, req.user, decision === 'close' ? 'Мастер подтвердил закрытие' : 'Мастер вернул на доработку', auditComment, decision === 'close' ? 'closed' : 'rework'); save(order);
    notify(order.assigneeId, order, decision === 'close' ? 'Наряд закрыт мастером' : 'Замечания мастера', `№${order.number}. ${comment || 'Результат принят.'}`, decision === 'close' ? 'success' : 'warning');
    res.json(order);
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 5, fields: 5 }, fileFilter: (req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
  app.post('/api/uploads', roles('master', 'worker'), upload.array('photos', 5), async (req, res) => {
    verifyRequestOwner(req);
    const { kind, orderId } = req.body;
    if (!['before', 'after'].includes(kind) || !req.files?.length) fail(400, 'Прикрепите JPEG, PNG или WebP и укажите тип фото.');
    if (orderId !== undefined && typeof orderId !== 'string') fail(400, 'Некорректный идентификатор наряда.');
    if (req.user.role === 'worker' && (kind !== 'after' || !orderId)) fail(403, 'Исполнитель прикладывает фото результата к своему наряду.');
    if (req.user.role === 'master' && kind !== 'before') fail(403, 'Фото результата прикладывает исполнитель.');
    let order;
    if (orderId) {
      order = store.get('orders', orderId);
      if (!order || !visible(order, req.user)) fail(403, 'Нет доступа к наряду.');
    }
    const capturedAt = req.body.capturedAt ? validDate(req.body.capturedAt, 'Время съёмки') : iso();
    const retry = retryRecord(req, `upload:${kind}`, { kind, orderId, capturedAt: req.body.capturedAt ?? null, files: req.files.map(file => ({ mimetype: file.mimetype, hash: sha(file.buffer) })) });
    if (retry?.saved) return res.status(201).json(retry.saved.response);
    if (retry && pendingUploads.has(retry.id)) {
      const pending = pendingUploads.get(retry.id);
      if (pending.bodyHash !== retry.bodyHash) fail(409, 'Идентификатор запроса уже использован с другими данными.');
      return res.status(201).json(await pending.promise);
    }
    if (order && TERMINAL.includes(order.status)) fail(409, 'Наряд уже завершён.');
    const prepare = async () => {
      const prepared = [];
      for (const file of req.files) {
        let bytes, signature;
        try {
          const input = sharp(file.buffer, { limitInputPixels: 40_000_000 });
          const metadata = await input.metadata();
          if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Unsupported image format');
          bytes = await input.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
          signature = await photoSignature(bytes);
        }
        catch { fail(400, 'Файл не является корректным изображением или слишком велик.'); }
        const id = randomUUID(); const filename = `${id}.jpg`;
        prepared.push({ bytes, photo: { id, filename, url: `/uploads/${filename}`, kind, capturedAt, uploadedAt: iso(), authorId: req.user.id, hash: sha(bytes), signature, ...(orderId ? { orderId } : {}) } });
      }
      for (const item of prepared) await writeFile(path.join(uploadDir, item.photo.filename), item.bytes, { flag: 'wx' });
      const response = { photos: prepared.map(item => item.photo) };
      store.transaction(() => { for (const item of prepared) store.put('photos', item.photo); saveRetry(retry, response); });
      return response;
    };
    const promise = prepare();
    if (retry) pendingUploads.set(retry.id, { bodyHash: retry.bodyHash, promise });
    try { res.status(201).json(await promise); }
    finally { if (retry) pendingUploads.delete(retry.id); }
  });
  app.get('/uploads/:filename', authenticate, (req, res) => {
    if (!/^[a-f\d-]+\.jpg$/i.test(req.params.filename)) fail(404, 'Фото не найдено.');
    const photo = store.list('photos').find(item => item.filename === req.params.filename);
    if (!photo) fail(404, 'Фото не найдено.');
    const order = photo.orderId ? store.get('orders', photo.orderId) : null;
    if (photo.authorId !== req.user.id && (!order || !visible(order, req.user))) fail(403, 'Фото недоступно.');
    res.sendFile(path.join(uploadDir, req.params.filename));
  });
  app.post('/api/notifications/read', (req, res) => {
    const ids = req.body.ids;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string'))) fail(400, 'Некорректный список уведомлений.');
    store.transaction(() => { for (const item of store.list('notifications')) if (item.userId === req.user.id && (!ids || ids.includes(item.id))) store.put('notifications', { ...item, read: true }); });
    broadcast(); res.json({ ok: true });
  });
  app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid.publicKey }));
  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body.subscription;
    let endpoint;
    try { endpoint = new URL(subscription?.endpoint); } catch { fail(400, 'Некорректная push-подписка.'); }
    const trusted = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'updates-autopush.stage.mozaws.net', 'web.push.apple.com', 'wns.windows.com', 'notify.windows.com'];
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !trusted.some(host => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`)) || typeof subscription.keys?.auth !== 'string' || typeof subscription.keys?.p256dh !== 'string') fail(400, 'Неподдерживаемый адрес push-сервиса.');
    if (subscription.endpoint.length > 4096 || !/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys.auth) || !/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys.p256dh) || Buffer.from(subscription.keys.auth, 'base64url').length !== 16 || Buffer.from(subscription.keys.p256dh, 'base64url').length !== 65) fail(400, 'Некорректные ключи push-подписки.');
    const id = sha(subscription.endpoint);
    store.put('subscriptions', { id, userId: req.user.id, sessionHash: req.sessionHash, subscription: { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime ?? null, keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh } } });
    res.status(201).json({ ok: true });
  });
  app.patch('/api/settings', roles('master', 'admin'), (req, res) => {
    const reminderMinutes = range(req.body.reminderMinutes, 1, 1440, 'Предупреждение в минутах');
    const repeatMinutes = range(req.body.repeatMinutes, 1, 1440, 'Повтор в минутах');
    const comment = `Предупреждение: ${store.setting('reminderMinutes', 30)} → ${reminderMinutes} мин; повтор: ${store.setting('repeatMinutes', 30)} → ${repeatMinutes} мин.`;
    store.transaction(() => { store.setSetting('reminderMinutes', reminderMinutes); store.setSetting('repeatMinutes', repeatMinutes); store.put('audit', { id: randomUUID(), actorId: req.user.id, actorName: req.user.name, action: 'Настройки уведомлений изменены', kind: 'settings', comment, at: iso(), reminderMinutes, repeatMinutes }); });
    broadcast(); res.json({ reminderMinutes, repeatMinutes, aiProvider: aiProvider() });
  });
  app.post('/api/catalogs/:kind', roles('admin'), (req, res) => {
    const kind = req.params.kind; const body = req.body;
    const record = catalogRecord(kind, body);
    store.transaction(() => { store.put(kind, record); if (kind === 'users') store.db.prepare('INSERT INTO auth(user_id,login,pin_hash) VALUES(?,?,?)').run(record.id, record.login, hashPin(body.pin)); store.put('audit', { id: randomUUID(), at: iso(), actorId: req.user.id, actorName: req.user.name, action: 'Добавлена запись справочника', kind, recordId: record.id, ...catalogAuditDetails(kind, record) }); });
    broadcast(); res.status(201).json(record);
  });
  app.patch('/api/catalogs/:kind/:id', roles('admin'), (req, res) => {
    const { kind, id } = req.params;
    if (!CATALOGS.includes(kind)) fail(400, 'Неизвестный справочник.');
    const existing = store.get(kind, id);
    if (!existing) fail(404, 'Запись справочника не найдена.');
    const record = catalogRecord(kind, req.body, existing);
    const changedFields = Object.keys(record).filter(key => JSON.stringify(record[key]) !== JSON.stringify(existing[key]));
    if (kind === 'users' && req.body.pin !== undefined) changedFields.push('pin');
    if (!changedFields.length) return res.json(existing);
    store.transaction(() => {
      store.put(kind, record);
      if (kind === 'users') {
        store.db.prepare('UPDATE auth SET login=? WHERE user_id=?').run(record.login, id);
        if (req.body.pin !== undefined) store.db.prepare('UPDATE auth SET pin_hash=? WHERE user_id=?').run(hashPin(req.body.pin), id);
      }
      store.put('audit', { id: randomUUID(), at: iso(), actorId: req.user.id, actorName: req.user.name, action: 'Изменена запись справочника', kind, recordId: id, changedFields, ...catalogAuditDetails(kind, record, changedFields) });
    });
    if (kind === 'users' && (req.body.pin !== undefined || record.role !== existing.role)) {
      for (const session of store.db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(id)) revokeSession(session.token_hash);
    }
    broadcast(); res.json(record);
  });

  app.get('/api/reports/export', roles('master', 'manager', 'admin'), async (req, res) => {
    const { default: ExcelJS } = await import('exceljs');
    const filters = {};
    for (const key of ['from', 'to', 'siteId', 'equipmentId', 'assigneeId', 'brigadeId', 'priority', 'status', 'type', 'search', 'dateField']) {
      if (req.query[key] === undefined) continue;
      if (typeof req.query[key] !== 'string') fail(400, 'Некорректные фильтры отчёта.');
      filters[key] = req.query[key];
    }
    for (const key of ['from', 'to']) if (filters[key]) filters[key] = validDate(filters[key], key === 'from' ? 'Начало периода' : 'Конец периода');
    if (filters.from && filters.to && Date.parse(filters.from) >= Date.parse(filters.to)) fail(400, 'Конец периода должен быть позже начала.');
    if (filters.dateField && !['createdAt', 'completedAt', 'closedAt'].includes(filters.dateField)) fail(400, 'Некорректное поле даты.');
    const allOrders = store.list('orders');
    const catalogs = Object.fromEntries(CATALOGS.map(kind => [kind, store.list(kind)]));
    // Use the same inclusive start / exclusive end as the displayed reports and ratings.
    const orders = filterOrders(allOrders, filters, catalogs);
    const workbook = new ExcelJS.Workbook(); workbook.creator = 'НарядAI'; workbook.created = new Date();
    const sheet = workbook.addWorksheet('Наряды');
    sheet.columns = [{ header: 'Номер', key: 'number', width: 14 }, { header: 'Задание', key: 'title', width: 50 }, { header: 'Участок', key: 'site', width: 25 }, { header: 'Оборудование', key: 'equipment', width: 32 }, { header: 'Исполнитель', key: 'worker', width: 30 }, { header: 'Статус', key: 'status', width: 22 }, { header: 'Выдан (UTC)', key: 'createdAt', width: 27 }, { header: 'Срок (UTC)', key: 'dueAt', width: 27 }, { header: 'Исполнен (UTC)', key: 'completedAt', width: 27 }, { header: 'Часы до исполнения', key: 'hours', width: 23 }, { header: 'Оценка', key: 'score', width: 12 }];
    for (const order of orders) sheet.addRow({ ...order, site: store.get('sites', order.siteId)?.name, equipment: store.get('equipment', order.equipmentId)?.name, worker: store.get('users', order.assigneeId)?.name, status: STATUS_LABELS[order.status], hours: order.completedAt ? Math.round((Date.parse(order.completedAt) - Date.parse(order.createdAt)) / 36000) / 100 : undefined, score: order.assessment?.masterScore ?? order.assessment?.score });
    const details = workbook.addWorksheet('Работы и оценка');
    details.columns = [{ header: 'Номер', key: 'number', width: 14 }, { header: 'Описание проблемы', key: 'description', width: 60 }, { header: 'Выполненные работы', key: 'works', width: 60 }, { header: 'Шифр', key: 'fault', width: 18 }, { header: 'Норма, ч', key: 'normHours', width: 14 }, { header: 'Вердикт ИИ', key: 'verdict', width: 24 }, { header: 'Отчёт ИИ', key: 'summary', width: 80 }, { header: 'Комментарий мастера', key: 'masterComment', width: 60 }, { header: 'Комментарий исполнителя', key: 'comment', width: 60 }];
    const verdicts = { accepted: 'Принято', remarks: 'Принято с замечаниями', rework: 'Требует доработки' };
    for (const order of orders) details.addRow({ ...order, works: order.completion?.works, fault: store.get('faults', order.completion?.faultId || order.faultId || '')?.code, verdict: verdicts[order.assessment?.verdict], summary: order.assessment?.summary, masterComment: order.assessment?.masterComment, comment: order.completion?.comment });
    const history = workbook.addWorksheet('История статусов');
    history.columns = [{ header: 'Номер', key: 'number', width: 14 }, { header: 'Время (UTC)', key: 'at', width: 27 }, { header: 'Автор', key: 'actorName', width: 30 }, { header: 'Действие', key: 'action', width: 40 }, { header: 'Из статуса', key: 'fromStatus', width: 24 }, { header: 'В статус', key: 'toStatus', width: 24 }, { header: 'Комментарий / причина', key: 'comment', width: 80 }];
    for (const order of orders) for (const item of order.events ?? []) history.addRow({ ...item, number: order.number, fromStatus: STATUS_LABELS[item.fromStatus], toStatus: STATUS_LABELS[item.toStatus] });
    const ratings = workbook.addWorksheet('Рейтинг'); ratings.columns = [{ header: 'Исполнитель', key: 'name', width: 32 }, { header: 'Закрыто', key: 'closedCount', width: 16 }, { header: 'Рейтинг /100', key: 'score', width: 18 }, { header: 'Средняя оценка /5', key: 'avgQuality', width: 22 }, { header: 'В срок, %', key: 'onTimePercent', width: 16 }, { header: 'Без доработок и повторов, %', key: 'firstPassPercent', width: 30 }, { header: 'Расчёт: закрытия за период', key: 'explanation', width: 95 }];
    const workerRatings = calculateRatings(allOrders, catalogs.users, filters);
    for (const rating of workerRatings) if (rating.evaluated) ratings.addRow(rating);
    const brigades = workbook.addWorksheet('Бригады'); brigades.columns = [{ header: 'Бригада', key: 'name', width: 32 }, { header: 'Закрыто', key: 'closedCount', width: 16 }, { header: 'Рейтинг /100', key: 'score', width: 18 }, { header: 'Средняя оценка /5', key: 'avgQuality', width: 22 }, { header: 'В срок, %', key: 'onTimePercent', width: 16 }];
    for (const rating of calculateBrigadeRatings(workerRatings, catalogs.brigades)) brigades.addRow({ ...rating, name: rating.brigade.name });
    const materials = workbook.addWorksheet('Расход ТМЦ'); materials.columns = [{ header: 'Материал', key: 'name', width: 40 }, { header: 'Единица', key: 'unit', width: 14 }, { header: 'Количество', key: 'quantity', width: 18 }];
    for (const material of catalogs.materials) { const quantity = orders.reduce((sum, order) => sum + (order.completion?.materials ?? []).filter(item => item.materialId === material.id).reduce((total, item) => total + item.quantity, 0), 0); if (quantity) materials.addRow({ ...material, quantity }); }
    const usage = workbook.addWorksheet('ТМЦ по нарядам'); usage.columns = [{ header: 'Номер', key: 'number', width: 14 }, { header: 'Материал', key: 'name', width: 40 }, { header: 'Единица', key: 'unit', width: 14 }, { header: 'Количество', key: 'quantity', width: 18 }, { header: 'Справочный расход', key: 'normalQuantity', width: 22 }, { header: 'Участок', key: 'site', width: 25 }, { header: 'Оборудование', key: 'equipment', width: 32 }, { header: 'Исполнитель', key: 'worker', width: 30 }];
    for (const order of orders) for (const item of order.completion?.materials ?? []) usage.addRow({ ...store.get('materials', item.materialId), quantity: item.quantity, number: order.number, site: store.get('sites', order.siteId)?.name, equipment: store.get('equipment', order.equipmentId)?.name, worker: store.get('users', order.assigneeId)?.name });
    const downtime = workbook.addWorksheet('Расчёт простоя'); downtime.columns = [{ header: 'Оборудование', key: 'name', width: 32 }, { header: 'Нарядов', key: 'orderCount', width: 14 }, { header: 'Оценка простоя, ч', key: 'downtimeHours', width: 22 }, { header: 'Плановый, ч', key: 'plannedDowntimeHours', width: 18 }, { header: 'Внеплановый, ч', key: 'unplannedDowntimeHours', width: 18 }, { header: 'Методика', key: 'method', width: 75 }];
    for (const item of getEquipmentStats(allOrders, catalogs.equipment, filters)) if (item.orderCount) downtime.addRow({ ...item, name: item.equipment.name, method: 'Оценка по интервалам нарядов с объединением пересечений; не телеметрия.' });
    for (const worksheet of workbook.worksheets) { worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF167D62' } }; worksheet.views = [{ state: 'frozen', ySplit: 1 }]; worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columnCount } }; }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename="naryad-ai-report.xlsx"');
    await workbook.xlsx.write(res); res.end();
  });
  app.post('/api/assistant', roles('master', 'manager', 'admin'), async (req, res) => {
    const message = requireText(req.body.message, 'Вопрос', 1000).toLowerCase();
    const orders = store.list('orders'); const active = orders.filter(order => !['closed', 'cancelled', 'ai_review', 'completed', 'rejected'].includes(order.status));
    const late = active.filter(order => Date.parse(order.dueAt) < Date.now());
    const scored = orders.filter(order => order.assessment); const average = scored.length ? (scored.reduce((sum, order) => sum + (order.assessment.masterScore ?? order.assessment.score), 0) / scored.length).toFixed(2) : '—';
    let answer, modelOptions;
    if (/свобод|кто.*(?:электр|слесар|сварщик|механик)/.test(message)) {
      const specialty = /свар/.test(message) ? /свар/i : /электр/.test(message) ? /электромонт|электрик/i : /кип/.test(message) ? /кип/i : /слесар|механик/.test(message) ? /слесар|механик/i : null;
      const workers = store.list('users').filter(person => person.role === 'worker' && (!specialty || specialty.test(person.specialty ?? '')));
      const free = workers.filter(person => getWorkerWorkload(person, orders).status === 'free').sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0));
      answer = `Свободных исполнителей${specialty ? ' указанной специальности' : ''} на смене: ${free.length}. ${free.map(person => `${person.name} — ${person.specialty || 'специальность не указана'}${person.grade ? `, разряд ${person.grade}` : ''}`).join('; ') || 'Подходящих свободных сотрудников нет.'} Занятые, сотрудники с очередью и вне смены исключены. Перед назначением мастер проверяет допуск к работе.`;
    } else if (/аномал|ломает|проблем|отказ|ақау|мәселе/u.test(message) || (/оборуд|конвейер|жабдық/u.test(message) && !/сводк|отч[её]т|есеп|қорытынды/u.test(message))) {
      const catalogs = Object.fromEntries(CATALOGS.map(kind => [kind, store.list(kind)])); const at = new Date();
      const scope = parseAssistantScope(message, catalogs, at, 'month');
      if (scope.error) return res.json({ answer: scope.error, provider: 'demo-rules' });
      answer = buildScopedAnomalyAnswer(message, orders, catalogs, at);
      modelOptions = { at, scopeOrders: filterOrders(orders.filter(order => Date.parse(order.createdAt) <= at.getTime() && order.status !== 'cancelled'), scope.filters, catalogs, at) };
    } else if (/недел|сводк|отч[её]т|апта|есеп|қорытынды/u.test(message)) {
      const catalogs = Object.fromEntries(CATALOGS.map(kind => [kind, store.list(kind)])); const at = new Date();
      const scope = parseAssistantScope(message, catalogs, at, 'shift');
      if (scope.error) return res.json({ answer: scope.error, provider: 'demo-rules' });
      answer = buildScopedSummaryAnswer(message, orders, catalogs, at);
      modelOptions = { at, scopeOrders: filterOrders(orders.filter(order => Date.parse(order.createdAt) <= at.getTime()), scope.filters, catalogs, at) };
    } else if (/просроч|срок/.test(message)) answer = `Сейчас просрочено ${late.length} активных нарядов: ${late.slice(0, 6).map(order => `№${order.number} (${store.get('equipment', order.equipmentId)?.name})`).join(', ') || 'нет'}. Исполнителям и мастерам отправляются повторные уведомления каждые ${store.setting('repeatMinutes', 30)} мин.`;
    else if (/материал|тмц|расход/.test(message)) {
      const excess = orders.filter(order => order.completion?.materials.some(item => item.quantity > (store.get('materials', item.materialId)?.normalQuantity ?? Infinity) * 2));
      answer = `В ${excess.length} нарядах расход хотя бы одной позиции выше справочного более чем вдвое. Это сигнал для проверки, а не доказательство нарушения. Проверьте причины, нормативы и объём фактически выполненных работ. Примеры: ${excess.slice(0, 5).map(order => `№${order.number}`).join(', ') || 'не обнаружены'}.`;
    } else if (/рейтинг|оцен|лучш/.test(message)) answer = `Проверено ${scored.length} нарядов, средняя итоговая оценка ${average}/5. Рейтинг в разделе «Команда» использует оценки мастера при наличии и оценки ИИ в остальных случаях. Сравнивайте сотрудников с учётом специальности и сложности работ.`;
    else answer = `В базе ${orders.length} нарядов, активных ${active.length}, просроченных ${late.length}, ожидают решения мастера ${orders.filter(order => order.status === 'ai_review' && order.assessment).length}. Средняя оценка ${average}/5. Можно спросить о сроках, расходе ТМЦ, рейтинге или проблемном оборудовании.`;
    res.json(await answerAssistant(message, store, req.user, answer, modelOptions));
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API-метод не найден.' }));
  const distDir = path.resolve(options.distDir ?? 'dist');
  if (existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? (error instanceof multer.MulterError ? 400 : 500);
    if (status >= 500) console.error('Ошибка API:', error.message);
    res.status(status).json({ error: error instanceof multer.MulterError ? 'Слишком много файлов или файл больше 8 МБ.' : status >= 500 ? 'Ошибка сервера. Повторите действие.' : error.message });
  });
  const timers = [];
  function sweepWeeklyReports(at = new Date()) { const result = deliverWeeklySummary(store, at); if (result.delivered) broadcast(); return result; }
  if (options.startTimers !== false) {
    sweepDeadlines();
    sweepWeeklyReports();
    timers.push(setInterval(() => { if (!stopping) sweepWeeklyReports(); }, 60000));
    timers.push(setInterval(() => { if (!stopping) { sweepDeadlines(); for (const order of store.list('orders')) if (order.status === 'ai_review' && !order.assessment) void review(order.id); } }, 5000));
    timers.push(setInterval(() => { for (const client of clients) { const session = store.db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(client.sessionHash); if (!session || session.expires_at < Date.now()) { client.res.end(); clients.delete(client); } else client.res.write(': heartbeat\n\n'); } }, 20000));
    for (const timer of timers) timer.unref();
    for (const order of store.list('orders')) if (order.status === 'ai_review' && !order.assessment) void review(order.id);
  }
  return { app, store, sweepDeadlines, sweepWeeklyReports, review, async waitForReviews() { await Promise.all(reviewJobs.values()); }, async close() { stopping = true; timers.forEach(clearInterval); for (const client of clients) client.res.end(); clients.clear(); await Promise.all(reviewJobs.values()); store.close(); } };
}
