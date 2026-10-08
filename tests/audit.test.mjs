import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../server/app.mjs';

async function harness(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'naryad-audit-'));
  const application = createApplication({ dataDir, startTimers: false, seedData: {
    users: [
      { id: 'master', name: 'Мастер Смены', role: 'master' },
      { id: 'worker', name: 'Иван Рабочий', role: 'worker' },
      { id: 'other', name: 'Олег Рабочий', role: 'worker' },
      { id: 'manager', name: 'Начальник Цеха', role: 'manager' },
      { id: 'admin', name: 'Администратор Системы', role: 'admin' },
    ].map(user => ({ ...user, login: user.id, pin: '1234', onShift: true })),
    sites: [{ id: 'site', name: 'Дробильный участок' }, { id: 'remote', name: 'Другой участок' }],
    equipment: [{ id: 'machine', name: 'Насос ПН-1', inventory: '001', type: 'Насос', siteId: 'site' }, { id: 'remote-machine', name: 'Конвейер К-2', inventory: '002', type: 'Конвейер', siteId: 'remote' }],
    brigades: [], faults: [], materials: [], orders: [],
  } });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  async function request(route, role = 'master', method = 'GET', body) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(cookies[role] ? { Cookie: cookies[role] } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  for (const login of ['master', 'worker', 'other', 'manager', 'admin']) {
    const result = await request('/api/auth/login', login, 'POST', { login, pin: '1234' });
    assert.equal(result.status, 200); cookies[login] = result.headers.get('set-cookie').split(';')[0];
  }
  t.after(async () => { await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const create = async (overrides = {}) => {
    const result = await request('/api/orders', 'master', 'POST', { description: 'Проверить насос и восстановить герметичность', type: 'unplanned', siteId: 'site', equipmentId: 'machine', assigneeId: 'worker', priority: 'normal', dueAt: new Date(Date.now() + 3600000).toISOString(), normHours: 2, ...overrides });
    assert.equal(result.status, 201); return result.body;
  };
  return { ...application, request, create };
}

test('Journal respects order visibility and never exposes raw audit or user secrets', async t => {
  const h = await harness(t);
  const own = await h.create();
  const hidden = await h.create({ assigneeId: 'other', equipmentId: 'remote-machine', siteId: 'remote' });
  await h.request(`/api/orders/${hidden.id}/transition`, 'other', 'POST', { status: 'accepted' });
  h.store.put('audit', { id: 'secret-catalog-entry', kind: 'users', recordId: 'other', at: new Date().toISOString(), actorId: 'admin', actorName: 'Администратор Системы', action: 'Изменена запись справочника', changedFields: ['pin'], pin: 'secret-pin', pinHash: 'secret-hash', credentials: { accessToken: 'secret-token' }, snapshot: h.store.get('users', 'other') });
  h.store.put('audit', { id: 'settings', kind: 'settings', at: new Date().toISOString(), actorId: 'admin', action: 'Настройки изменены' });
  assert.equal((await h.request('/api/audit', 'anonymous')).status, 401);
  const mine = await h.request('/api/audit', 'worker');
  assert.equal(mine.status, 200); assert.equal(mine.body.total, 1);
  assert.equal(mine.body.items[0].orderId, own.id);
  assert.deepEqual(mine.body.actors.map(actor => actor.id), ['master']);
  for (const query of ['kind=catalog', 'kind=settings', 'actorId=other', 'equipmentId=remote-machine', `search=${hidden.number}`]) {
    assert.equal((await h.request(`/api/audit?${query}`, 'worker')).body.total, 0);
  }
  for (const role of ['master', 'manager', 'admin']) {
    const all = await h.request('/api/audit', role);
    assert.equal(all.status, 200); assert.equal(all.body.total, 5);
    assert.deepEqual(new Set(all.body.items.map(item => item.kind)), new Set(['order', 'settings', 'catalog']));
    assert.equal(all.body.items.find(item => item.orderId === hidden.id).equipmentName, 'Конвейер К-2');
    const serialized = JSON.stringify(all.body);
    for (const secret of ['secret-pin', 'secret-hash', 'secret-token', 'pinHash', 'credentials', 'snapshot', 'changedFields']) assert.ok(!serialized.includes(secret), `Leaked ${secret}`);
  }
  await h.request(`/api/orders/${own.id}`, 'master', 'PATCH', { assigneeId: 'other' });
  assert.equal((await h.request('/api/audit', 'worker')).body.total, 0, 'Previous assignee must lose journal access with order access');
  assert.equal((await h.request('/api/audit', 'other')).body.total, 5);
});

test('Journal filters use event time, Kostanay calendar days and stable server pagination', async t => {
  const h = await harness(t); const order = await h.create();
  const times = ['2026-10-07T18:59:59.999Z', '2026-10-07T19:00:00.000Z', '2026-10-08T18:59:59.999Z', '2026-10-08T19:00:00.000Z'];
  order.events = times.map((at, index) => ({ id: `event-${index}`, at, actorId: index === 1 ? 'worker' : 'master', actorName: index === 1 ? 'Иван Рабочий' : 'Мастер Смены', action: index === 1 ? 'Устранена течь насоса' : 'Изменён статус', comment: '' }));
  h.store.put('orders', order);
  const day = (await h.request('/api/audit?from=2026-10-08&to=2026-10-08')).body;
  assert.equal(day.total, 2); assert.deepEqual(day.items.map(item => item.at), [times[2], times[1]]);
  const query = new URLSearchParams({ search: 'ТЕЧЬ', siteId: 'site', equipmentId: 'machine', actorId: 'worker', from: '2026-10-08', to: '2026-10-08', kind: 'order' });
  const filtered = (await h.request(`/api/audit?${query}`)).body;
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].actorName, 'Иван Рабочий');
  assert.deepEqual(new Set(filtered.actors.map(actor => actor.id)), new Set(['master', 'worker']), 'Actor options must not disappear with filters');
  const pages = [];
  for (let page = 1; page <= 4; page++) {
    const response = (await h.request(`/api/audit?page=${page}&pageSize=1`)).body;
    assert.equal(response.total, 4); assert.equal(response.page, page); assert.equal(response.pageSize, 1);
    pages.push(response.items[0].id);
  }
  assert.equal(new Set(pages).size, 4);
  const clamped = (await h.request('/api/audit?page=900&pageSize=1')).body;
  assert.equal(clamped.page, 4); assert.equal(clamped.items[0].id, pages[3]);
  const empty = (await h.request('/api/audit?search=not-present&page=900')).body;
  assert.equal(empty.total, 0); assert.equal(empty.page, 1); assert.deepEqual(empty.items, []);
  const isoQuery = new URLSearchParams({ from: times[1], to: times[3] });
  assert.equal((await h.request(`/api/audit?${isoQuery}`)).body.total, 2);
  for (const query of ['page=0', 'page=1.5', 'pageSize=101', 'pageSize=NaN', 'kind=users', 'from=2026-02-30', 'to=invalid', 'from=2026-10-09&to=2026-10-08', 'actorId=worker&actorId=master']) {
    assert.equal((await h.request(`/api/audit?${query}`)).status, 400, query);
  }
});

test('Journal retains named actors and readable changes for edits, reassignment, cancellation and catalogs', async t => {
  const h = await harness(t); const order = await h.create();
  const edit = await h.request(`/api/orders/${order.id}`, 'master', 'PATCH', { priority: 'high', dueAt: new Date(Date.parse(order.dueAt) + 3600000).toISOString(), comment: 'Новый срок согласован', assigneeId: 'other' });
  assert.equal(edit.status, 200);
  const updated = edit.body.events.at(-1);
  assert.match(updated.comment, /Приоритет: Обычный → Высокий/);
  assert.match(updated.comment, /Срок: .* → .*\(Костанай\)/);
  assert.match(updated.comment, /Комментарий: .*Новый срок согласован/);
  assert.match(updated.comment, /Иван Рабочий → Олег Рабочий/);
  assert.equal(updated.actorName, 'Мастер Смены'); assert.ok(Number.isFinite(Date.parse(updated.at)));
  const cancelled = await h.request(`/api/orders/${order.id}/transition`, 'master', 'POST', { status: 'cancelled', reason: 'Работы включены в план капитального ремонта' });
  assert.equal(cancelled.status, 200);
  const cancelEvent = cancelled.body.events.at(-1);
  assert.equal(cancelEvent.fromStatus, 'issued'); assert.equal(cancelEvent.toStatus, 'cancelled'); assert.equal(cancelEvent.actorId, 'master'); assert.match(cancelEvent.comment, /капитального ремонта/);
  assert.equal((await h.request('/api/settings', 'master', 'PATCH', { reminderMinutes: 45, repeatMinutes: 15 })).status, 200);
  const added = await h.request('/api/catalogs/sites', 'admin', 'POST', { name: 'Новый участок' });
  assert.equal(added.status, 201);
  assert.equal((await h.request(`/api/catalogs/sites/${added.body.id}`, 'admin', 'PATCH', { name: 'Переименованный участок' })).status, 200);
  assert.equal((await h.request('/api/catalogs/users/other', 'admin', 'PATCH', { pin: '5678' })).status, 200);
  const settings = (await h.request('/api/audit?kind=settings')).body.items[0];
  assert.equal(settings.actorName, 'Мастер Смены'); assert.match(settings.comment, /30 → 45 мин; повтор: 30 → 15 мин/);
  const catalog = (await h.request('/api/audit?kind=catalog')).body.items;
  assert.equal(catalog.length, 3); assert.ok(catalog.every(item => item.actorName === 'Администратор Системы'));
  assert.ok(catalog.some(item => item.entityLabel === 'Участки: Новый участок'), 'Original creation label must survive subsequent rename');
  assert.ok(catalog.some(item => item.comment.includes('ПИН-код')));
  assert.ok(!JSON.stringify(h.store.list('audit')).includes('5678'));
  assert.ok(!JSON.stringify(catalog).includes('5678'));
});
