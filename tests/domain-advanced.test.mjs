import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomalies, getManagementStats, buildShiftSummary } from '../src/domain.ts';

const now = new Date('2026-10-29T00:00:00Z');
const people = [
  { id: 'worker-a', name: 'Первый исполнитель', role: 'worker', onShift: true, brigadeId: 'brigade-a' },
  { id: 'worker-b', name: 'Второй исполнитель', role: 'worker', onShift: true, brigadeId: 'brigade-b' },
];
const catalogs = {
  users: people,
  equipment: [{ id: 'pump', name: 'Насос', siteId: 'site-a' }, { id: 'other', name: 'Конвейер', siteId: 'site-b' }],
  sites: [{ id: 'site-a', name: 'Участок А' }, { id: 'site-b', name: 'Участок Б' }],
  brigades: [{ id: 'brigade-a', name: 'Первая бригада' }, { id: 'brigade-b', name: 'Вторая бригада' }],
  faults: [], materials: [],
};
const repair = (id, createdAt, extras = {}) => {
  const time = Date.parse(createdAt);
  return {
    id, number: id, title: 'Ремонт', description: 'Ремонт насоса', type: 'unplanned',
    equipmentId: 'pump', siteId: 'site-a', assigneeId: 'worker-a', priority: 'normal', status: 'closed',
    createdAt, dueAt: new Date(time + 7200000).toISOString(), startedAt: new Date(time + 300000).toISOString(),
    completedAt: new Date(time + 3600000).toISOString(), closedAt: new Date(time + 3660000).toISOString(),
    normHours: 1, faultId: id, photos: [], events: [], assessment: { score: 5, verdict: 'accepted' }, ...extras,
  };
};

test('growth warning compares equal windows, cites all evidence, and excludes future/cancelled work', () => {
  const orders = [3, 8, 16, 18, 20, 24, 28].map(day => repair(`growth-${day}`, `2026-10-${String(day).padStart(2, '0')}T06:00:00Z`));
  orders.push(repair('cancelled', '2026-10-26T06:00:00Z', { status: 'cancelled' }), repair('future', '2026-11-02T06:00:00Z'));
  const finding = detectAnomalies(orders, catalogs, { from: '2026-10-01T00:00:00Z', to: '2026-11-05T00:00:00Z' }, now).find(item => item.type === 'failure_growth');
  assert.ok(finding);
  assert.deepEqual(finding.evidence, { currentCount: 5, previousCount: 2, windowDays: 14, ratio: 2.5 });
  assert.equal(finding.orderIds.length, 7);
  assert.ok(!finding.orderIds.includes('future') && !finding.orderIds.includes('cancelled'));
  assert.match(finding.description, /не рассчитанная вероятность/);
  assert.ok(finding.recommendation.length > 30);
  assert.equal(detectAnomalies(orders, catalogs, { siteId: 'site-b' }, now).some(item => item.type === 'failure_growth'), false);
});

test('growth warnings require baseline, several observation days, and two sufficiently long windows', () => {
  const base = [3, 8].map(day => repair(`old-${day}`, `2026-10-0${day}T06:00:00Z`));
  const recent = [16, 18, 20, 24, 28].map(day => repair(`new-${day}`, `2026-10-${day}T06:00:00Z`));
  const hasGrowth = (orders, filters = {}) => detectAnomalies(orders, catalogs, filters, now).some(item => item.type === 'failure_growth');
  assert.equal(hasGrowth(recent), false, 'No baseline is not proof of growth');
  assert.equal(hasGrowth([...base, ...recent.slice(0, 2)]), false, 'A small recent sample must stay silent');
  assert.equal(hasGrowth([...base, ...recent.map(item => ({ ...item, createdAt: '2026-10-28T06:00:00Z' }))]), false, 'One batch of duplicate-date work is not a sustained trend');
  assert.equal(hasGrowth([...base, ...recent], { from: '2026-10-22T00:00:00Z' }), false, 'A single week cannot support two seven-day comparison windows');
});

test('shift dependency compares unplanned proportions using local day/night boundaries', () => {
  const orders = Array.from({ length: 10 }, (_, index) => [
    repair(`day-${index}`, '2026-10-05T06:00:00Z', { type: index < 2 ? 'unplanned' : 'planned' }),
    repair(`night-${index}`, '2026-10-05T18:00:00Z', { type: index < 8 ? 'unplanned' : 'planned' }),
  ]).flat();
  const findings = detectAnomalies(orders, catalogs, {}, now).filter(item => item.type === 'shift_dependency');
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /Ночная/);
  assert.match(findings[0].description, /8 из 10.*80%.*2 из 10.*20%/);
  assert.equal(findings[0].orderIds.length, 20, 'Evidence includes the comparison group, not only flagged orders');
  assert.equal(detectAnomalies(orders.slice(0, 12), catalogs, {}, now).some(item => item.type === 'shift_dependency'), false);
  const balanced = orders.map((item, index) => ({ ...item, type: index < 10 ? 'unplanned' : 'planned' }));
  assert.equal(detectAnomalies(balanced, catalogs, {}, now).some(item => item.type === 'shift_dependency'), false);
});

test('worker and brigade dependencies require sufficient mature repairs and never infer blame', () => {
  const orders = Array.from({ length: 8 }, (_, index) => [
    repair(`a-${index}`, '2026-10-05T06:00:00Z', { events: index < 4 ? [{ toStatus: 'rework', at: '2026-10-05T06:30:00Z', comment: 'Уточнить результат' }] : [] }),
    repair(`b-${index}`, '2026-10-05T06:00:00Z', { assigneeId: 'worker-b' }),
  ]).flat();
  const dependencies = rows => detectAnomalies(rows, catalogs, {}, now).filter(item => ['worker_dependency', 'brigade_dependency'].includes(item.type));
  const findings = dependencies(orders);
  assert.equal(findings.length, 2);
  assert.ok(findings.some(item => item.userId === 'worker-a'));
  assert.ok(findings.some(item => item.brigadeId === 'brigade-a'));
  assert.ok(findings.every(item => /не доказывает вину/.test(item.description)));
  assert.equal(dependencies(orders.filter(item => item.id !== 'a-7')).length, 0, 'Seven repairs are below the sample guard');
  assert.equal(dependencies(orders.map(item => ({ ...item, completedAt: '2026-10-27T06:00:00Z' }))).length, 0, 'Recent repairs do not yet have a full repeat-failure observation window');
  assert.equal(detectAnomalies(orders, catalogs, { assigneeId: 'worker-a' }, now).some(item => item.type === 'worker_dependency'), false, 'A single selected employee has no comparison group');
});

test('management metrics use scoped event times and preserve carried-over execution and downtime', () => {
  const orders = [
    repair('carried', '2026-10-04T22:00:00Z', { startedAt: '2026-10-04T23:00:00Z', completedAt: '2026-10-05T05:00:00Z', closedAt: '2026-10-05T05:05:00Z' }),
    repair('fresh', '2026-10-05T04:00:00Z', { startedAt: '2026-10-05T04:10:00Z', completedAt: '2026-10-05T04:40:00Z', closedAt: '2026-10-05T04:45:00Z', events: [{ toStatus: 'queued', at: '2026-10-05T04:02:00Z', comment: '' }, { toStatus: 'accepted', at: '2026-10-05T04:05:00Z', comment: '' }] }),
    repair('outside', '2026-10-05T04:00:00Z', { equipmentId: 'other', siteId: 'site-b', assigneeId: 'worker-b' }),
  ];
  const range = { from: '2026-10-05T03:00:00Z', to: '2026-10-05T15:00:00Z' };
  for (const filter of [{ siteId: 'site-a' }, { equipmentId: 'pump' }, { assigneeId: 'worker-a' }, { brigadeId: 'brigade-a' }]) {
    const stats = getManagementStats(orders, catalogs, { ...range, ...filter }, '2026-10-05T15:00:00Z');
    assert.equal(stats.avgReactionMinutes, 2, JSON.stringify(filter));
    assert.equal(stats.reactionSampleCount, 1);
    assert.equal(stats.avgExecutionHours, 3.25);
    assert.equal(stats.executionSampleCount, 2);
    assert.equal(stats.downtimeHours, 2, 'Overlapping repairs are merged and clipped to the period');
    assert.equal(stats.topEquipment.length, 1);
    assert.equal(stats.topWorkers.length, 1);
    assert.equal(stats.topWorkers[0].userId, 'worker-a');
  }
});

test('management metrics distinguish missing timing from zero and summary includes rejection and workload', () => {
  const empty = getManagementStats([], catalogs, {}, now);
  assert.equal(empty.avgReactionMinutes, null);
  assert.equal(empty.avgExecutionHours, null);
  const rejected = repair('rejected', '2026-10-28T04:00:00Z', { status: 'rejected', startedAt: undefined, completedAt: undefined, closedAt: undefined, events: [{ toStatus: 'rejected', at: '2026-10-28T04:01:00Z', actorId: 'worker-a', comment: 'Нет допуска' }] });
  const summary = buildShiftSummary([rejected], catalogs, { from: '2026-10-28T00:00:00Z', to: now }, now);
  assert.match(summary, /Отклонено исполнителями: 1/);
  assert.match(summary, /заняты или имеют очередь/);
  assert.match(summary, /Средняя реакция.*1 мин/);
  assert.match(summary, /Расчётный простой/);
});
