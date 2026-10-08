import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.mjs';
import { deliverWeeklySummary, previousFullWeek } from '../server/weekly-summary.mjs';

test('Weekly report boundaries follow Monday midnight in Kostanay, including year changes', () => {
  const sunday = previousFullWeek('2026-10-04T18:59:59.999Z');
  assert.equal(sunday.key, '2026-09-28');
  const monday = previousFullWeek('2026-10-04T19:00:00.000Z');
  assert.equal(monday.key, '2026-10-05');
  assert.equal(monday.from.toISOString(), '2026-09-27T19:00:00.000Z');
  assert.equal(monday.to.toISOString(), '2026-10-04T19:00:00.000Z');
  const newYear = previousFullWeek('2026-01-01T08:00:00Z');
  assert.equal(newYear.key, '2025-12-29');
  assert.equal(newYear.from.toISOString(), '2025-12-21T19:00:00.000Z');
  assert.throws(() => previousFullWeek('invalid'), /Invalid/);
});

test('Automatic weekly summary contains period statistics and recommendations, with persistent per-recipient deduplication', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'naryad-weekly-'));
  const orders = ['2026-09-29T08:00:00Z', '2026-09-30T08:00:00Z', '2026-10-02T08:00:00Z', '2026-10-06T08:00:00Z'].map((createdAt, index) => ({ id: `order-${index}`, number: String(index), title: 'Ремонт', assigneeId: 'worker', masterId: 'master', equipmentId: 'machine', siteId: 'site', type: 'unplanned', status: 'closed', priority: 'normal', faultId: 'fault', normHours: 2, createdAt, startedAt: createdAt, dueAt: new Date(Date.parse(createdAt) + 7200000).toISOString(), completedAt: new Date(Date.parse(createdAt) + 3600000).toISOString(), closedAt: new Date(Date.parse(createdAt) + 3600000).toISOString(), events: [], photos: [], completion: { works: 'Заменён подшипник', materials: [], faultId: 'fault' }, assessment: { score: 4, verdict: 'accepted' } }));
  let store = openStore(dataDir, {
    users: ['master', 'manager', 'worker', 'admin'].map(role => ({ id: role, login: role, name: role, role, onShift: true })),
    sites: [{ id: 'site', name: 'Участок' }], equipment: [{ id: 'machine', name: 'Насос ПН-1', siteId: 'site' }], faults: [{ id: 'fault', code: 'М-02', name: 'Подшипник' }], brigades: [], materials: [], orders,
  });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const now = new Date('2026-10-08T10:00:00Z');
  assert.equal(deliverWeeklySummary(store, now).delivered, 2);
  const messages = store.list('notifications');
  assert.deepEqual(new Set(messages.map(item => item.userId)), new Set(['master', 'manager']));
  assert.ok(messages.every(item => !item.orderId && item.kind === 'info' && item.read === false));
  assert.match(messages[0].title, /28\.09\.2026 — 04\.10\.2026/);
  assert.match(messages[0].message, /выдано 3 нарядов/);
  assert.match(messages[0].message, /Насос ПН-1: повторяется М-02/);
  assert.match(messages[0].message, /Рекомендация: Проверить соосность/);
  assert.equal(deliverWeeklySummary(store, now).delivered, 0);
  store.close(); store = openStore(dataDir);
  assert.equal(deliverWeeklySummary(store, new Date('2026-10-09T10:00:00Z')).delivered, 0, 'Restart must not duplicate the weekly report');
  assert.equal(store.list('notifications').length, 2);
  assert.equal(deliverWeeklySummary(store, new Date('2026-10-11T19:00:00Z')).delivered, 2, 'New local calendar week must produce a new report');
  assert.equal(store.list('notifications').length, 4);
  store.put('users', { id: 'new-master', name: 'Новый мастер', role: 'master' });
  assert.equal(deliverWeeklySummary(store, new Date('2026-10-12T05:00:00Z')).delivered, 1, 'A new master gets the current report without resending to existing recipients');
});
