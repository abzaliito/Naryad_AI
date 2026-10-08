import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getShiftRange, isOverdue, isOnTime, calculateRatings, calculateBrigadeRatings,
  repeatedRepairIds, getWorkerWorkload, getEquipmentStats, getOrderTrend,
  filterOrders, detectAnomalies, getMaterialStats, getDashboardStats, buildShiftSummary,
} from '../src/domain.ts';
import { createSeed } from '../server/seed.mjs';

const now = new Date('2026-10-05T07:00:00.000Z');
const user = { id: 'worker', name: 'Тестовый исполнитель', role: 'worker', onShift: true, brigadeId: 'brigade' };
const order = (overrides = {}) => ({
  id: 'repair', number: 1, title: 'Замена подшипника', description: 'Повреждение подшипника',
  type: 'unplanned', equipmentId: 'equipment', siteId: 'site', assigneeId: 'worker',
  priority: 'normal', status: 'closed', createdAt: '2026-10-05T04:00:00Z',
  startedAt: '2026-10-05T04:05:00Z', dueAt: '2026-10-05T05:00:00Z',
  completedAt: '2026-10-05T04:50:00Z', closedAt: '2026-10-05T05:10:00Z',
  normHours: 1, faultId: 'bearing', photos: [], events: [],
  assessment: { score: 5, verdict: 'accepted' }, ...overrides,
});

test('08–20 shift boundaries use Asia/Qyzylorda, regardless of host zone', () => {
  const day = getShiftRange('2026-10-05T04:00:00Z');
  assert.equal(day.from.toISOString(), '2026-10-05T03:00:00.000Z');
  assert.equal(day.to.toISOString(), '2026-10-05T15:00:00.000Z');
  assert.equal(day.isDay, true);
  const earlyMorning = getShiftRange('2026-10-05T01:00:00Z');
  assert.equal(earlyMorning.from.toISOString(), '2026-10-04T15:00:00.000Z');
  assert.equal(earlyMorning.isDay, false);
  assert.equal(getShiftRange('2026-10-05T15:00:00Z').isDay, false);
});

test('deadline monitoring stops at completion and resumes for rework', () => {
  for (const status of ['completed', 'ai_review', 'closed', 'rejected', 'cancelled']) {
    assert.equal(isOverdue(order({ status }), now), false, status);
  }
  for (const status of ['issued', 'accepted', 'queued', 'in_progress', 'paused', 'rework']) {
    assert.equal(isOverdue(order({ status }), now), true, status);
  }
  assert.equal(isOverdue(order({ status: 'in_progress', dueAt: '2026-10-05T08:00:00Z' }), now), false);
  assert.equal(isOnTime(order()), true, 'Master approval after the deadline must not penalize timely work');
});

test('rating components total 100 and human quality override is respected', () => {
  const perfect = calculateRatings([order()], [user])[0];
  assert.equal(perfect.score, 100);
  assert.deepEqual(perfect.weighted, { quality: 40, onTime: 25, firstPass: 20, volume: 10, reasonableRejections: 5 });
  const override = calculateRatings([order({ assessment: { score: 5, masterScore: 3, verdict: 'accepted' } })], [user])[0];
  assert.equal(override.weighted.quality, 24);
  assert.equal(override.score, 84);
  assert.equal(calculateRatings([], [user])[0].evaluated, false);
  assert.equal(calculateRatings([], [user])[0].score, 0);
});

test('a repeated fault penalizes the preceding repair within 7 days, across period boundaries', () => {
  const original = order();
  const repeated = order({ id: 'repeat', assigneeId: 'another', createdAt: '2026-10-06T04:00:00Z', completedAt: '2026-10-06T04:50:00Z', closedAt: '2026-10-06T05:10:00Z' });
  assert.deepEqual([...repeatedRepairIds([original, repeated])], ['repair']);
  const rating = calculateRatings([original, repeated], [user], { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' })[0];
  assert.equal(rating.closedCount, 1);
  assert.equal(rating.repeatFaultCount, 1);
  assert.equal(rating.weighted.firstPass, 0);
  assert.equal(rating.score, 80);
  assert.equal(repeatedRepairIds([original, { ...repeated, createdAt: '2026-10-13T04:00:00Z' }]).size, 0);
});

test('rejection evaluation uses the event time and actor after reassignment', () => {
  const old = order({ id: 'old', assigneeId: 'another', createdAt: '2026-10-01T00:00:00Z', events: [{ actorId: 'worker', toStatus: 'rejected', at: '2026-10-05T04:00:00Z', comment: 'Нет допуска' }] });
  const ratings = calculateRatings([order(), old], [user], { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' });
  assert.equal(ratings[0].rejectedCount, 1);
  assert.equal(ratings[0].unreasonableRejections, 0);
  assert.equal(ratings[0].weighted.reasonableRejections, 5);
  const filtered = calculateRatings([order(), old], [user], { assigneeId: 'worker', from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' });
  assert.equal(filtered[0].rejectedCount, 1, 'Selecting the worker must not hide their earlier rejection after reassignment');
});

test('dashboard statistics respect report scope while counting completions across issue-date boundaries', () => {
  const carried = order({ createdAt: '2026-10-04T04:00:00Z' });
  const unrelated = order({ id: 'other', equipmentId: 'other-equipment', siteId: 'other-site', assigneeId: 'other-worker', completedAt: '2026-10-05T06:00:00Z', assessment: { score: 1, verdict: 'remarks' } });
  const otherUser = { ...user, id: 'other-worker', brigadeId: 'other-brigade' };
  const filters = { from: '2026-10-05T03:00:00Z', to: '2026-10-05T15:00:00Z' };
  for (const scope of [{ siteId: 'site' }, { equipmentId: 'equipment' }, { assigneeId: 'worker' }, { brigadeId: 'brigade' }]) {
    const stats = getDashboardStats([carried, unrelated], [user, otherUser], { ...filters, ...scope }, now);
    assert.equal(stats.issued, 0, JSON.stringify(scope));
    assert.equal(stats.completed, 1, JSON.stringify(scope));
    assert.equal(stats.closed, 1, JSON.stringify(scope));
    assert.equal(stats.averageScore, 5, JSON.stringify(scope));
    assert.equal(stats.onTimePercent, 100, JSON.stringify(scope));
  }
  const summary = buildShiftSummary([carried, unrelated], { users: [user, otherUser] }, { ...filters, siteId: 'site' }, now);
  assert.match(summary, /выдано 0 нарядов, исполнено 1, закрыто мастером 1/);
});

test('worker availability uses current work outside the report date and equipment selection', () => {
  const current = order({ createdAt: '2026-10-01T04:00:00Z', status: 'in_progress', completedAt: undefined, equipmentId: 'other-equipment' });
  const stats = getDashboardStats([order(), current], [user], { equipmentId: 'equipment', from: '2026-10-05T03:00:00Z', to: '2026-10-05T15:00:00Z' }, now);
  assert.equal(stats.freeWorkers, 0);
  assert.equal(stats.onShiftWorkers, 1);
});

test('workload separates current work, queue, and employees not on shift', () => {
  const own = [order({ status: 'in_progress' }), order({ id: 'queued', status: 'queued' })];
  const load = getWorkerWorkload(user, own, now);
  assert.equal(load.status, 'busy');
  assert.equal(load.current.id, 'repair');
  assert.equal(load.queueCount, 1);
  assert.equal(load.overdueCount, 2);
  assert.equal(getWorkerWorkload({ ...user, onShift: false }, own).status, 'off_shift');
});

test('equipment downtime merges overlapping work-order intervals', () => {
  const overlapping = [order(), order({ id: 'overlap', createdAt: '2026-10-05T04:10:00Z' })];
  const stats = getEquipmentStats(overlapping, [{ id: 'equipment', name: 'Насос', siteId: 'site' }])[0];
  assert.equal(stats.downtimeHours, 0.8);
  assert.equal(stats.estimated, true);
  assert.equal(stats.orderCount, 2);
});

test('period downtime includes carried repairs and clips both boundaries without duplicate hours', () => {
  const carried = order({ createdAt: '2026-10-04T21:00:00Z', completedAt: '2026-10-05T05:00:00Z' });
  const overlapping = order({ id: 'second', createdAt: '2026-10-05T04:00:00Z', completedAt: '2026-10-05T08:00:00Z' });
  const stats = getEquipmentStats([carried, overlapping], [{ id: 'equipment', name: 'Насос', siteId: 'site' }], { from: '2026-10-05T03:00:00Z', to: '2026-10-05T06:00:00Z' }, now)[0];
  assert.equal(stats.orderCount, 1, 'Issued-order counts retain their issue-date basis');
  assert.equal(stats.downtimeHours, 3, 'Intervals crossing the period boundary still contribute only their overlap');
  assert.equal(stats.unplannedDowntimeHours, 3);
});

test('active rework downtime continues despite evidence of an earlier rejected completion', () => {
  const repair = order({ status: 'in_progress', completedAt: undefined, completion: { submittedAt: '2026-10-05T04:50:00Z' } });
  const stats = getEquipmentStats([repair], [{ id: 'equipment', name: 'Насос', siteId: 'site' }], {}, now)[0];
  assert.equal(stats.downtimeHours, 3);
});

test('filters use an exclusive period end, and trends group by local calendar date', () => {
  const midnight = order({ createdAt: '2026-10-04T20:00:00Z' }); // Oct 5, 01:00 in Qyzylorda.
  assert.equal(getOrderTrend([midnight], {}, 'day', now).find(point => point.total).key, '2026-10-05');
  assert.equal(filterOrders([order()], { from: '2026-10-05T04:00:00Z', to: '2026-10-05T04:00:00Z' }).length, 0);
  assert.equal(filterOrders([order()], { search: 'подшипник' }).length, 1);
});

test('seed meets case volume and exposes planted anomalies from actual order evidence', () => {
  const seed = createSeed(now);
  assert.ok(seed.sites.length >= 4);
  assert.ok(seed.equipment.length >= 25);
  assert.equal(seed.users.filter(person => person.role === 'worker').length, 15);
  assert.ok(seed.faults.length >= 20);
  assert.ok(seed.materials.length >= 40);
  assert.ok(seed.orders.length >= 550);
  const dates = seed.orders.map(item => Date.parse(item.createdAt));
  assert.ok(Math.max(...dates) - Math.min(...dates) >= 90 * 86_400_000);
  const findings = detectAnomalies(seed.orders, seed);
  for (const type of ['repeat_fault', 'materials', 'post_maintenance', 'rework']) {
    assert.ok(findings.some(finding => finding.type === type), `Expected planted ${type} signal`);
  }
  assert.ok(findings.some(finding => finding.equipmentId === 'eq-k3' && finding.type === 'repeat_fault'));
  const actualIds = new Set(seed.orders.map(item => item.id));
  assert.ok(findings.every(finding => finding.orderIds.length > 0 && finding.orderIds.every(id => actualIds.has(id))));
  assert.deepEqual(detectAnomalies([], seed), []);
  const ratings = calculateRatings(seed.orders, seed.users);
  assert.ok(ratings.every(rating => rating.score >= 0 && rating.score <= 100));
  assert.equal(calculateBrigadeRatings(ratings, seed.brigades).length, 3);
  assert.ok(getMaterialStats(seed.orders, seed.materials).some(item => item.outlierCount > 0));
});
