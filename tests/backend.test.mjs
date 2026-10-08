import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createECDH } from 'node:crypto';
import sharp from 'sharp';
import { createApplication } from '../server/app.mjs';
import { assessOrder } from '../server/ai.mjs';

// Integration tests must never send task evidence to a configured external service.
delete process.env.AI_BASE_URL;
delete process.env.AI_MODEL;
delete process.env.AI_SEND_PHOTOS;

function fixture() {
  return {
    users: [
      { id: 'master', name: 'Демо Мастер', login: 'master', pin: '1234', role: 'master', onShift: true },
      { id: 'worker', name: 'Демо Рабочий', login: 'worker', pin: '1234', role: 'worker', onShift: true, brigadeId: 'brigade' },
      { id: 'other', name: 'Другой Рабочий', login: 'other', pin: '1234', role: 'worker', onShift: true },
      { id: 'manager', name: 'Руководитель', login: 'manager', pin: '1234', role: 'manager', onShift: true },
      { id: 'admin', name: 'Администратор', login: 'admin', pin: '1234', role: 'admin', onShift: true },
    ],
    sites: [{ id: 'site', name: 'Участок' }], equipment: [{ id: 'machine', name: 'Насос', inventory: '001', type: 'Насос', siteId: 'site' }],
    brigades: [{ id: 'brigade', name: 'Бригада' }], faults: [{ id: 'fault', code: 'F01', name: 'Течь', normHours: 2 }], materials: [{ id: 'oil', name: 'Масло', unit: 'л', normalQuantity: 2 }], orders: [],
  };
}

async function harness(t, dataDir) {
  const ownDir = !dataDir;
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'naryad-api-'));
  const application = createApplication({ dataDir, seedData: fixture(), startTimers: false });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  async function request(method, route, body, role = 'master') {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(cookies[role] ? { Cookie: cookies[role] } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
    return { status: response.status, body: payload, headers: response.headers };
  }
  for (const login of ['master', 'worker', 'other', 'manager', 'admin']) {
    const result = await request('POST', '/api/auth/login', { login, pin: '1234' }, login);
    assert.equal(result.status, 200); cookies[login] = result.headers.get('set-cookie').split(';')[0];
  }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { await close(); if (ownDir) await rm(dataDir, { recursive: true, force: true }); });
  const create = (overrides = {}) => request('POST', '/api/orders', { description: 'Устранить течь масла на насосе', type: 'unplanned', siteId: 'site', equipmentId: 'machine', assigneeId: 'worker', priority: 'emergency', dueAt: new Date(Date.now() + 3600000).toISOString(), normHours: 2, faultId: 'fault', ...overrides });
  return { ...application, request, create, close, dataDir, base, cookies };
}

test('Authentication, authorization and hashed PINs protect work orders', async t => {
  const h = await harness(t);
  assert.equal((await h.request('GET', '/api/bootstrap', undefined, 'anonymous')).status, 401);
  assert.equal((await h.request('POST', '/api/auth/login', { login: 'master', pin: 'bad' })).status, 401);
  const record = h.store.db.prepare('SELECT pin_hash FROM auth WHERE user_id=?').get('master');
  assert.notEqual(record.pin_hash, '1234'); assert.match(record.pin_hash, /^[a-f\d]+:[a-f\d]+$/);
  const created = await h.create(); assert.equal(created.status, 201);
  const order = created.body;
  const all = await h.request('GET', '/api/bootstrap');
  assert.equal(all.body.catalogs.users.some(user => 'pin' in user || 'pinHash' in user), false);
  assert.equal((await h.request('GET', '/api/bootstrap', undefined, 'other')).body.orders.length, 0);
  assert.equal((await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted', version: order.version }, 'other')).status, 403);
  assert.equal((await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'close' }, 'worker')).status, 403);
  assert.equal((await h.request('PATCH', `/api/orders/${order.id}`, { priority: 'high' }, 'manager')).status, 403);
  assert.equal((await h.request('POST', '/api/catalogs/sites', { name: 'Не разрешено' }, 'worker')).status, 403);
});

test('Audited transitions reject stale updates, missing reason and concurrent jobs', async t => {
  const h = await harness(t); const first = (await h.create()).body; const second = (await h.create()).body;
  const accepted = await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'accepted', version: first.version }, 'worker');
  assert.equal(accepted.status, 200); assert.equal(accepted.body.version, first.version + 1);
  assert.equal((await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'in_progress', version: first.version }, 'worker')).status, 409);
  const started = await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'in_progress', version: accepted.body.version }, 'worker');
  assert.equal(started.status, 200); assert.ok(started.body.startedAt);
  assert.equal((await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'closed' }, 'worker')).status, 409);
  assert.equal((await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'paused' }, 'worker')).status, 400);
  await h.request('POST', `/api/orders/${second.id}/transition`, { status: 'accepted' }, 'worker');
  assert.equal((await h.request('POST', `/api/orders/${second.id}/transition`, { status: 'in_progress' }, 'worker')).status, 409);
  assert.equal((await h.request('POST', `/api/orders/${first.id}/transition`, { status: 'paused', reason: 'Нужны запасные части' }, 'worker')).status, 200);
  const next = await h.request('POST', `/api/orders/${second.id}/transition`, { status: 'in_progress' }, 'worker');
  assert.equal(next.status, 200); assert.ok(next.body.events.every(event => event.actorId && event.at && event.action));
});

test('Every completion is reviewed and missing evidence returns to rework', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  assert.equal((await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'close' })).status, 409);
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  assert.equal((await h.request('POST', `/api/orders/${order.id}/complete`, { materials: [null] }, 'worker')).status, 400);
  const completed = await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Заменена манжета, проверена герметичность и выполнен пробный пуск.', faultId: 'fault', materials: [{ materialId: 'oil', quantity: 20 }], photoIds: [] }, 'worker');
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'ai_review');
  assert.deepEqual(completed.body.events.slice(-2).map(item => item.toStatus), ['completed', 'ai_review']);
  await h.waitForReviews(); const reviewed = h.store.get('orders', order.id);
  assert.equal(reviewed.status, 'rework'); assert.equal(reviewed.assessment.verdict, 'rework'); assert.equal(reviewed.assessment.provider, 'demo-rules');
  assert.ok(reviewed.assessment.checks.some(item => item.label === 'Фотоподтверждение' && item.status === 'fail'));
  assert.ok(reviewed.assessment.checks.some(item => item.label === 'Расход ТМЦ' && item.status === 'warn'));
  assert.equal((await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'close' })).status, 409);
  const notifications = h.store.list('notifications').filter(item => item.title === 'Наряд возвращён на доработку');
  assert.deepEqual(new Set(notifications.map(item => item.userId)), new Set(['worker', 'master']));
});

test('Real images are compressed, actor bound and assessed before master closure', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  const bytes = await sharp({ create: { width: 2200, height: 1600, channels: 3, background: '#2d6651' } }).png().toBuffer();
  const form = new FormData(); form.set('kind', 'after'); form.set('orderId', order.id); form.set('capturedAt', new Date().toISOString()); form.append('photos', new Blob([bytes], { type: 'image/png' }), 'repair.png');
  const uploaded = await h.request('POST', '/api/uploads', form, 'worker');
  assert.equal(uploaded.status, 201); const photo = uploaded.body.photos[0]; assert.match(photo.url, /\.jpg$/); assert.ok(photo.hash);
  assert.equal((await h.request('GET', photo.url, undefined, 'other')).status, 403);
  const retrieved = await h.request('GET', photo.url, undefined, 'worker'); assert.equal(retrieved.status, 200);
  const metadata = await sharp(Buffer.from(retrieved.body)).metadata(); assert.ok(metadata.width <= 2048); assert.equal(metadata.exif, undefined);
  const completed = await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Заменена манжета и проверена герметичность после пробного запуска.', faultId: 'fault', materials: [], photoIds: [photo.id] }, 'worker');
  assert.equal(completed.status, 200); await h.waitForReviews(); const reviewed = h.store.get('orders', order.id);
  assert.equal(reviewed.status, 'ai_review'); assert.equal(reviewed.assessment.verdict, 'remarks'); // A few milliseconds is abnormally fast for this task.
  assert.equal((await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'close', score: 3 }, 'master')).status, 400);
  const closed = await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'close', score: 3, comment: 'Результат проверен лично, замечание к оформлению.', version: reviewed.version });
  assert.equal(closed.status, 200); assert.equal(closed.body.status, 'closed'); assert.equal(closed.body.assessment.masterScore, 3);
  assert.equal((await h.request('PATCH', `/api/orders/${order.id}`, { priority: 'high' })).status, 409);
  const next = (await h.create()).body;
  await h.request('POST', `/api/orders/${next.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${next.id}/transition`, { status: 'in_progress' }, 'worker');
  assert.equal((await h.request('POST', `/api/orders/${next.id}/complete`, { works: 'Повторный осмотр и устранение течи', faultId: 'fault', materials: [], photoIds: [photo.id] }, 'worker')).status, 403);
  const repeated = new FormData(); repeated.set('kind', 'after'); repeated.set('orderId', next.id); repeated.append('photos', new Blob([bytes], { type: 'image/png' }), 'same-picture.png');
  const repeatedPhoto = (await h.request('POST', '/api/uploads', repeated, 'worker')).body.photos[0];
  await h.request('POST', `/api/orders/${next.id}/complete`, { works: 'Повторный осмотр и устранение течи', faultId: 'fault', materials: [], photoIds: [repeatedPhoto.id] }, 'worker');
  await h.waitForReviews();
  assert.equal(h.store.get('orders', next.id).status, 'rework');
  assert.ok(h.store.get('orders', next.id).assessment.checks.some(item => item.label === 'Повторное использование снимков' && item.status === 'fail'));
});

test('Deadline sweep notifies worker and master once per slot and stops at completion', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  const now = new Date(); order.dueAt = new Date(now.getTime() - 61000).toISOString(); h.store.put('orders', order);
  h.sweepDeadlines(now); h.sweepDeadlines(now);
  let late = h.store.list('notifications').filter(item => item.title === 'Наряд просрочен'); assert.equal(late.length, 2);
  h.sweepDeadlines(new Date(now.getTime() + 31 * 60000));
  late = h.store.list('notifications').filter(item => item.title === 'Наряд просрочен'); assert.equal(late.length, 4);
  order.status = 'ai_review'; h.store.put('orders', order);
  h.sweepDeadlines(new Date(now.getTime() + 65 * 60000));
  assert.equal(h.store.list('notifications').filter(item => item.title === 'Наряд просрочен').length, 4);
});

test('SQLite persists records and authentication across restart; settings and exports work', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'naryad-persistence-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await harness(t, dataDir); const order = (await first.create()).body;
  assert.equal((await first.request('PATCH', '/api/settings', { reminderMinutes: 12, repeatMinutes: 5 })).status, 200);
  await first.close(); const second = await harness(t, dataDir);
  const bootstrap = await second.request('GET', '/api/bootstrap');
  assert.ok(bootstrap.body.orders.some(item => item.id === order.id)); assert.equal(bootstrap.body.settings.reminderMinutes, 12);
  const exportResult = await second.request('GET', '/api/reports/export', undefined, 'manager');
  assert.equal(exportResult.status, 200); assert.equal(Buffer.from(exportResult.body).subarray(0, 2).toString(), 'PK');
  assert.equal((await second.request('GET', '/api/reports/export', undefined, 'worker')).status, 403);
  assert.equal((await second.request('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://127.0.0.1/private', keys: { auth: 'bad', p256dh: 'bad' } } }, 'worker')).status, 400);
  await second.close();
});

test('Unaccepted emergency escalation suggests a free worker and includes deadline context', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  const now = new Date(); order.createdAt = new Date(now.getTime() - 4 * 60000).toISOString(); order.events[0].at = order.createdAt;
  order.dueAt = new Date(now.getTime() - 60000).toISOString(); h.store.put('orders', order);
  h.sweepDeadlines(now); h.sweepDeadlines(now);
  const escalation = h.store.list('notifications').filter(item => item.title === 'Наряд не принят — требуется решение');
  assert.equal(escalation.length, 1); assert.equal(escalation[0].userId, 'master'); assert.match(escalation[0].message, /Другой Рабочий/);
  const overdue = h.store.list('notifications').find(item => item.title === 'Наряд просрочен');
  assert.match(overdue.message, /Насос/); assert.match(overdue.message, /Участок/); assert.match(overdue.message, /Демо Рабочий/); assert.match(overdue.message, /Статус: Выдан/); assert.match(overdue.message, /1 мин/);
});

test('Planned tasks may pass completeness without photos; catalog writes remain admin-only', async t => {
  const h = await harness(t); const order = (await h.create({ type: 'planned' })).body;
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Плановый осмотр проведён, крепёж проверен, замечаний нет.', faultId: 'fault', materials: [], photoIds: [] }, 'worker');
  await h.waitForReviews(); assert.equal(h.store.get('orders', order.id).status, 'ai_review');
  assert.equal((await h.request('POST', '/api/catalogs/sites', { name: 'Новый участок' }, 'master')).status, 403);
  assert.equal((await h.request('POST', '/api/catalogs/sites', { name: 'Новый участок' }, 'admin')).status, 201);
  assert.equal((await h.request('POST', '/api/catalogs/users', { name: 'Новое Имя', login: 'new-worker', role: 'worker', pin: '4321' }, 'admin')).status, 201);
  const login = await h.request('POST', '/api/auth/login', { login: 'new-worker', pin: '4321' }); assert.equal(login.status, 200); assert.equal(login.body.user.role, 'worker');
});

test('SSE emits an immediate changed event after a mutation', async t => {
  const h = await harness(t); const abort = new AbortController();
  const response = await fetch(`${h.base}/api/events`, { headers: { Cookie: h.cookies.master }, signal: abort.signal });
  const reader = response.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: connected/);
  const start = Date.now(); await h.create();
  const next = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 3000).unref())]);
  assert.match(new TextDecoder().decode(next.value), /event: changed/); assert.ok(Date.now() - start < 3000); abort.abort();
});

test('Pending mandatory AI review resumes after process restart', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  order.status = 'ai_review'; order.completedAt = new Date().toISOString();
  order.completion = { works: 'Устранена течь и проверено давление насоса.', faultId: 'fault', materials: [], comment: '', submittedAt: order.completedAt };
  h.store.put('orders', order); await h.close();
  const recovered = createApplication({ dataDir: h.dataDir, startTimers: true });
  try {
    await recovered.waitForReviews();
    const reviewed = recovered.store.get('orders', order.id);
    assert.equal(reviewed.status, 'rework'); assert.ok(reviewed.assessment); assert.ok(reviewed.events.some(event => event.action === 'Проверка ИИ завершена'));
  } finally { await recovered.close(); }
});

test('External review anonymizes known staff and cannot waive required evidence; failures fall back', async t => {
  const h = await harness(t); const order = (await h.create({ description: 'Демо Рабочий: устранить течь масла. Ким проверил таким образом. Телефон +7 700 123 45 67, worker@example.test' })).body;
  h.store.put('users', { ...h.store.get('users', 'other'), name: 'Алексей Ким' });
  order.completedAt = new Date().toISOString(); order.completion = { works: 'Демо Рабочий заменил манжету и проверил герметичность.', faultId: 'fault', materials: [], submittedAt: order.completedAt };
  const originalFetch = globalThis.fetch; let outbound;
  process.env.AI_BASE_URL = 'https://model.invalid/v1'; process.env.AI_MODEL = 'test-model';
  globalThis.fetch = async (_url, options) => { outbound = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'accepted', score: 5, confidence: 0.4, summary: 'Ответ тестовой модели.', checks: [], strengths: [], improvements: [] }) } }] }), { headers: { 'Content-Type': 'application/json' } }); };
  try {
    const assessment = await assessOrder(order, h.store, path.join(h.dataDir, 'uploads'));
    const content = outbound.messages[1].content;
    assert.equal(content.length, 1); assert.ok(!content[0].text.includes('Демо Рабочий')); assert.ok(!content[0].text.includes('700 123')); assert.ok(!content[0].text.includes('worker@example.test'));
    assert.ok(!content[0].text.includes('Ким')); assert.ok(content[0].text.includes('таким образом'));
    assert.equal(assessment.provider, 'configured-model'); assert.equal(assessment.verdict, 'rework');
    assert.ok(assessment.checks.some(item => item.label === 'Низкая уверенность ИИ'));
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'rework', score: 3, confidence: 0.4, summary: 'Возможен дефект ремонта.', checks: [], strengths: [], improvements: [], masterScore: 5, masterComment: 'Подтверждено мастером', provider: 'forged' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    const uncertain = await assessOrder({ ...order, type: 'planned' }, h.store, path.join(h.dataDir, 'uploads'));
    assert.equal(uncertain.verdict, 'remarks'); assert.match(uncertain.summary, /Нужна проверка мастером/);
    assert.equal(uncertain.provider, 'configured-model'); assert.equal('masterScore' in uncertain, false); assert.equal('masterComment' in uncertain, false);
    process.env.AI_SEND_PHOTOS = 'true';
    const noPhotos = await assessOrder({ ...order, type: 'planned' }, h.store, path.join(h.dataDir, 'uploads'));
    assert.ok(noPhotos.checks.some(item => item.label === 'Визуальная оценка' && item.status === 'warn' && item.detail.includes('отсутствуют')));
    globalThis.fetch = async () => { throw new Error('Offline'); };
    const fallback = await assessOrder(order, h.store, path.join(h.dataDir, 'uploads'));
    assert.equal(fallback.provider, 'demo-rules (fallback)'); assert.equal(fallback.verdict, 'rework'); assert.match(fallback.summary, /недоступна/);
  } finally { globalThis.fetch = originalFetch; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL; delete process.env.AI_SEND_PHOTOS; }
});

test('Push registrations are revoked for the logged-out device and account replacement only', async t => {
  const h = await harness(t);
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const subscription = (device) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, keys: { auth: Buffer.alloc(16, 42).toString('base64url'), p256dh: curve.getPublicKey().toString('base64url') } });
  assert.equal((await h.request('POST', '/api/push/subscribe', { subscription: subscription('device-a') }, 'worker')).status, 201);
  const login = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'worker', pin: '1234' }) });
  const secondCookie = login.headers.get('set-cookie').split(';')[0]; await login.arrayBuffer();
  const registered = await fetch(`${h.base}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondCookie }, body: JSON.stringify({ subscription: subscription('device-b') }) });
  assert.equal(registered.status, 201); await registered.arrayBuffer();
  assert.equal(h.store.list('subscriptions').length, 2);
  assert.equal((await h.request('POST', '/api/auth/logout', {}, 'worker')).status, 200);
  assert.equal((await h.request('GET', '/api/bootstrap', undefined, 'worker')).status, 401);
  assert.equal(h.store.list('subscriptions').length, 1); assert.match(h.store.list('subscriptions')[0].subscription.endpoint, /device-b$/);
  const replacement = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondCookie }, body: JSON.stringify({ login: 'other', pin: '1234' }) });
  assert.equal(replacement.status, 200); await replacement.arrayBuffer(); assert.equal(h.store.list('subscriptions').length, 0);
});

test('Reassignment and repeated completion retain earlier evidence without showing stale results', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Заменена манжета и проверена герметичность насоса.', faultId: 'fault', materials: [], photoIds: [] }, 'worker');
  await h.waitForReviews();
  const firstAssessment = h.store.get('orders', order.id).assessment;
  const reassigned = await h.request('PATCH', `/api/orders/${order.id}`, { assigneeId: 'other' });
  assert.equal(reassigned.status, 200); assert.equal(reassigned.body.status, 'issued');
  assert.equal(reassigned.body.completion, undefined); assert.equal(reassigned.body.assessment, undefined); assert.equal(reassigned.body.completedAt, undefined);
  assert.equal(reassigned.body.completionHistory.length, 1); assert.equal(reassigned.body.completionHistory[0].assigneeId, 'worker');
  assert.deepEqual(reassigned.body.completionHistory[0].assessment, firstAssessment); assert.ok(reassigned.body.completionHistory[0].completedAt);
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'other');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'other');
  await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Повторно проверена герметичность, результат удовлетворительный.', faultId: 'fault', materials: [], photoIds: [] }, 'other');
  await h.waitForReviews();
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'other');
  await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Выполнен контроль давления и герметичности после доработки.', faultId: 'fault', materials: [], photoIds: [] }, 'other');
  await h.waitForReviews(); const final = h.store.get('orders', order.id);
  assert.equal(final.completionHistory.length, 2); assert.equal(final.completionHistory[1].assigneeId, 'other'); assert.ok(final.completionHistory[1].completedAt);
});

test('Unconfirmed materials trigger rework, and rejected assignments stop executor deadline reminders', async t => {
  const h = await harness(t); const order = (await h.create({ type: 'planned' })).body;
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Плановый осмотр выполнен, крепёж проверен, замечаний нет.', faultId: 'fault', materials: [], materialsConfirmed: false, photoIds: [] }, 'worker');
  await h.waitForReviews(); const reviewed = h.store.get('orders', order.id);
  assert.equal(reviewed.status, 'rework'); assert.ok(reviewed.assessment.checks.some(item => item.label === 'Учёт ТМЦ' && item.status === 'fail'));
  const rejected = (await h.create()).body;
  await h.request('POST', `/api/orders/${rejected.id}/transition`, { status: 'rejected', reason: 'Нет допуска к этим работам' }, 'worker');
  const latest = h.store.get('orders', rejected.id); latest.dueAt = new Date(Date.now() - 60000).toISOString(); h.store.put('orders', latest);
  h.sweepDeadlines(); assert.equal(h.store.list('notifications').filter(item => item.orderId === rejected.id && item.title === 'Наряд просрочен').length, 0);
});

test('Assistant answers free-specialty and weekly site questions from actual records', async t => {
  const h = await harness(t);
  h.store.put('users', { ...h.store.get('users', 'worker'), specialty: 'Электромонтёр', grade: 5 });
  h.store.put('users', { ...h.store.get('users', 'other'), specialty: 'Электросварщик', grade: 6 });
  let response = await h.request('POST', '/api/assistant', { message: 'Кто сейчас свободен из электриков?' });
  assert.equal(response.status, 200); assert.match(response.body.answer, /Демо Рабочий/); assert.doesNotMatch(response.body.answer, /Другой Рабочий/);
  const order = (await h.create()).body; await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  response = await h.request('POST', '/api/assistant', { message: 'Кто сейчас свободен из электриков?' });
  assert.match(response.body.answer, /Подходящих свободных сотрудников нет/);
  h.store.put('sites', { id: 'site', name: 'Обогатительная фабрика' });
  response = await h.request('POST', '/api/assistant', { message: 'Сформируй отчёт за неделю по участку обогащения' });
  assert.match(response.body.answer, /Обогатительная фабрика/); assert.match(response.body.answer, /выдано 1 нарядов/);
});

test('Excel export uses exclusive period end and includes execution, material and status details', async t => {
  const h = await harness(t); const order = (await h.create()).body; const boundary = (await h.create()).body;
  order.createdAt = '2026-10-05T03:00:00.000Z'; order.status = 'closed'; order.startedAt = '2026-10-05T03:05:00.000Z'; order.completedAt = '2026-10-05T04:00:00.000Z'; order.closedAt = '2026-10-05T04:10:00.000Z';
  order.completion = { works: 'Устранена течь, заменена манжета, проверена герметичность.', faultId: 'fault', materials: [{ materialId: 'oil', quantity: 2 }], comment: 'Проверено', submittedAt: order.completedAt };
  order.assessment = { verdict: 'accepted', score: 4, summary: 'Работа принята', masterComment: 'Подтверждено' };
  boundary.createdAt = '2026-10-05T15:00:00.000Z'; h.store.put('orders', order); h.store.put('orders', boundary);
  const query = '?from=2026-10-05T03%3A00%3A00.000Z&to=2026-10-05T15%3A00%3A00.000Z';
  const response = await h.request('GET', `/api/reports/export${query}`, undefined, 'manager'); assert.equal(response.status, 200);
  const { default: ExcelJS } = await import('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(response.body));
  const orders = workbook.getWorksheet('Наряды'); assert.equal(orders.rowCount, 2); assert.equal(orders.getCell('A2').value, order.number);
  assert.equal(workbook.getWorksheet('Работы и оценка').getCell('C2').value, order.completion.works);
  assert.equal(workbook.getWorksheet('История статусов').rowCount, order.events.length + 1);
  assert.equal(workbook.getWorksheet('ТМЦ по нарядам').getCell('D2').value, 2);
  assert.equal(workbook.getWorksheet('Рейтинг').getCell('B2').value, 1);
  assert.equal(workbook.getWorksheet('Расчёт простоя').rowCount, 2);
  assert.equal((await h.request('GET', '/api/reports/export?from=2026-10-06&to=2026-10-05', undefined, 'manager')).status, 400);
});

test('Admin catalog edits preserve references, validate credentials and revoke sessions on PIN reset', async t => {
  const h = await harness(t); const order = (await h.create()).body;
  assert.equal((await h.request('PATCH', '/api/catalogs/users/worker', { role: 'admin' }, 'master')).status, 403);
  assert.equal((await h.request('PATCH', '/api/catalogs/users/admin', { role: 'master' }, 'admin')).status, 409);
  assert.equal((await h.request('PATCH', '/api/catalogs/users/worker', { role: 'manager' }, 'admin')).status, 409);
  assert.equal((await h.request('PATCH', '/api/catalogs/users/worker', { login: 'other' }, 'admin')).status, 409);
  assert.equal((await h.request('PATCH', '/api/catalogs/users/worker', { onShift: 'false' }, 'admin')).status, 400);
  assert.equal((await h.request('PATCH', '/api/catalogs/users/worker', { grade: 3.5 }, 'admin')).status, 400);
  const changed = await h.request('PATCH', '/api/catalogs/users/worker', { name: 'Обновлённый Рабочий', onShift: false, grade: 5 }, 'admin');
  assert.equal(changed.status, 200); assert.equal(changed.body.id, 'worker'); assert.equal(changed.body.login, 'worker'); assert.equal(changed.body.onShift, false);
  assert.equal((await h.create()).status, 400);
  assert.equal((await h.request('GET', '/api/auth/me', undefined, 'worker')).status, 200);
  const machine = await h.request('PATCH', '/api/catalogs/equipment/machine', { name: 'Насос после модернизации' }, 'admin');
  assert.equal(machine.status, 200); assert.equal(machine.body.inventory, '001'); assert.equal(machine.body.siteId, 'site');
  const persisted = h.store.get('orders', order.id); assert.equal(persisted.equipmentId, 'machine'); assert.equal(persisted.assigneeId, 'worker');
  assert.equal((await h.request('PATCH', '/api/catalogs/equipment/machine', { siteId: 'missing' }, 'admin')).status, 400);
  assert.equal((await h.request('PATCH', '/api/catalogs/materials/oil', { normalQuantity: -1 }, 'admin')).status, 400);
  assert.equal((await h.request('PATCH', '/api/catalogs/sites/missing', { name: 'Название' }, 'admin')).status, 404);
  const reset = await h.request('PATCH', '/api/catalogs/users/worker', { login: 'worker-renamed', pin: '5678', onShift: true }, 'admin');
  assert.equal(reset.status, 200); assert.equal('pin' in reset.body, false); assert.equal('pinHash' in reset.body, false);
  assert.equal((await h.request('GET', '/api/auth/me', undefined, 'worker')).status, 401);
  assert.equal((await h.request('POST', '/api/auth/login', { login: 'worker-renamed', pin: '1234' }, 'anonymous')).status, 401);
  const login = await h.request('POST', '/api/auth/login', { login: 'worker-renamed', pin: '5678' }, 'anonymous'); assert.equal(login.status, 200); assert.equal(login.body.user.id, 'worker');
  const audit = h.store.list('audit').filter(item => item.recordId === 'worker'); assert.ok(audit.some(item => item.changedFields.includes('pin'))); assert.ok(!JSON.stringify(audit).includes('5678'));
});

test('Rework requires new photographic evidence even within the same work order', async t => {
  const h = await harness(t); const order = (await h.create({ type: 'planned' })).body;
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'accepted' }, 'worker');
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#315d77' } }).png().toBuffer();
  const upload = async () => {
    const form = new FormData(); form.set('kind', 'after'); form.set('orderId', order.id); form.append('photos', new Blob([bytes], { type: 'image/png' }), 'repair.png');
    const result = await h.request('POST', '/api/uploads', form, 'worker'); assert.equal(result.status, 201); return result.body.photos[0];
  };
  const original = await upload();
  const complete = async photo => {
    assert.equal((await h.request('POST', `/api/orders/${order.id}/complete`, { works: 'Плановый осмотр проведён, крепления проверены, замечаний нет.', faultId: 'fault', materials: [], photoIds: [photo.id] }, 'worker')).status, 200);
    await h.waitForReviews(); return h.store.get('orders', order.id);
  };
  assert.equal((await complete(original)).status, 'ai_review');
  assert.equal((await h.request('POST', `/api/orders/${order.id}/review`, { decision: 'rework', comment: 'После дополнительной проверки предоставьте новое фото результата.' })).status, 200);
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  const reused = await complete(original); assert.equal(reused.status, 'rework');
  assert.ok(reused.assessment.checks.some(item => item.label === 'Повторное использование снимков' && item.status === 'fail'));
  await h.request('POST', `/api/orders/${order.id}/transition`, { status: 'in_progress' }, 'worker');
  const reuploaded = await upload(); assert.notEqual(reuploaded.id, original.id);
  assert.equal((await complete(reuploaded)).status, 'rework');
});
