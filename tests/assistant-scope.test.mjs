import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantScope, buildScopedAnomalyAnswer, buildScopedSummaryAnswer } from '../server/assistant-scope.mjs';

const now = new Date('2026-10-08T10:00:00Z');
const catalogs = {
  sites: [{ id: 'crushing', name: 'Дробильно-сортировочный комплекс' }, { id: 'enrichment', name: 'Обогатительная фабрика' }],
  equipment: [{ id: 'pump', name: 'Насос ПН-1', inventory: '1001', siteId: 'crushing' }, { id: 'conveyor', name: 'Конвейер К-3', inventory: '1002', siteId: 'crushing' }, { id: 'separator', name: 'Сепаратор СМ-1', inventory: '2001', siteId: 'enrichment' }],
  users: [{ id: 'worker', name: 'Работник', role: 'worker', onShift: true }], brigades: [], faults: [{ id: 'fault', code: 'М-02', name: 'Подшипник' }], materials: [],
};
const order = (id, equipmentId, createdAt, extra = {}) => ({ id, number: id, equipmentId, siteId: catalogs.equipment.find(item => item.id === equipmentId).siteId, assigneeId: 'worker', masterId: 'master', createdAt, startedAt: createdAt, completedAt: new Date(Date.parse(createdAt) + 3600000).toISOString(), closedAt: new Date(Date.parse(createdAt) + 3600000).toISOString(), dueAt: new Date(Date.parse(createdAt) + 7200000).toISOString(), status: 'closed', type: 'unplanned', normHours: 1, priority: 'normal', faultId: 'fault', events: [], completion: { faultId: 'fault', works: 'Заменён подшипник', materials: [] }, photos: [], ...extra });
const orders = [
  order('p1', 'pump', '2026-10-02T08:00:00Z'), order('p2', 'pump', '2026-10-03T08:00:00Z'), order('p3', 'pump', '2026-10-04T08:00:00Z'),
  order('old1', 'pump', '2026-08-01T08:00:00Z'), order('old2', 'conveyor', '2026-08-02T08:00:00Z'),
  order('future', 'conveyor', '2026-10-09T08:00:00Z'),
  order('e1', 'separator', '2026-10-04T08:00:00Z'), order('e2', 'separator', '2026-10-05T08:00:00Z'),
  order('cancelled', 'pump', '2026-10-05T08:00:00Z', { status: 'cancelled' }),
];

test('Assistant scope resolves actual catalog names, codes and RU/KK periods without choosing ambiguous records', () => {
  assert.equal(parseAssistantScope('Покажи проблемы участка дробления за месяц', catalogs, now).filters.siteId, 'crushing');
  assert.equal(parseAssistantScope('Отчёт за неделю по участку обогащения', catalogs, now).filters.siteId, 'enrichment');
  assert.equal(parseAssistantScope('Ұсату учаскесінің бір айдағы мәселелері', catalogs, now).period, 'month');
  assert.equal(parseAssistantScope('Байыту учаскесінің апталық есебі', catalogs, now).filters.siteId, 'enrichment');
  assert.equal(parseAssistantScope('Байыту учаскесінің апталық есебі', catalogs, now).period, 'week');
  assert.equal(parseAssistantScope('Проблемы ПН-1 за сутки', catalogs, now).filters.equipmentId, 'pump');
  assert.equal(parseAssistantScope('Проблемы оборудования 1002 за смену', catalogs, now).filters.equipmentId, 'conveyor');
  assert.equal(parseAssistantScope('Мәселелер бүгін', catalogs, now).period, 'day');
  assert.equal(parseAssistantScope('Проблемы за ауысым', catalogs, now).period, 'shift');
  assert.match(parseAssistantScope('Проблемы участка несуществующего за месяц', catalogs, now).error, /не найден/);
  assert.match(parseAssistantScope('Проблемы конвейера К-999 за месяц', catalogs, now).error, /не найдено/);
  assert.match(parseAssistantScope('Проблемы участка дробления на СМ-1 за месяц', catalogs, now).error, /другому участку/);
  const ambiguous = { ...catalogs, sites: [...catalogs.sites, { id: 'second-crushing', name: 'Дробильный участок №2' }] };
  assert.match(parseAssistantScope('Проблемы дробления за месяц', ambiguous, now).error, /несколько/);
});

test('Problem answers filter site and period, retain recommendations and exclude old, future and cancelled records', () => {
  const crushing = buildScopedAnomalyAnswer('Покажи проблемы участка дробления за месяц', orders, catalogs, now);
  assert.match(crushing, /Дробильно-сортировочный комплекс/);
  assert.match(crushing, /В выбранном периоде: 3 нарядов, внеплановых 3/);
  assert.match(crushing, /Насос ПН-1: повторяется М-02/); assert.match(crushing, /Рекомендация: Проверить соосность/);
  assert.doesNotMatch(crushing, /Сепаратор СМ-1|Конвейер К-3/);
  const enrichment = buildScopedAnomalyAnswer('Покажи проблемы участка обогащения за месяц', orders, catalogs, now);
  assert.match(enrichment, /Обогатительная фабрика/); assert.match(enrichment, /В выбранном периоде: 2 нарядов, внеплановых 2/);
  assert.match(enrichment, /Сепаратор СМ-1/); assert.doesNotMatch(enrichment, /Насос ПН-1|Конвейер К-3/);
  assert.match(enrichment, /пороговые сигналы аномалий не обнаружены/);
  const empty = buildScopedAnomalyAnswer('Проблемы К-3 за месяц', orders, catalogs, now);
  assert.match(empty, /В выбранном периоде: 0 нарядов/); assert.match(empty, /наряды не найдены/);
  assert.doesNotMatch(empty, /Насос ПН-1|Сепаратор СМ-1/);
  assert.match(buildScopedAnomalyAnswer('Проблемы участка неизвестного', orders, catalogs, now), /данные других участков не подставлены/);
});

test('Weekly and shift summaries share the requested scope and cap the period at the current moment', () => {
  const summary = buildScopedSummaryAnswer('Сформируй отчёт за неделю по участку обогащения', orders, catalogs, now);
  assert.match(summary, /Обогатительная фабрика/); assert.match(summary, /выдано 2 нарядов/); assert.doesNotMatch(summary, /Насос ПН-1/);
  const futureToday = order('later-today', 'separator', '2026-10-08T11:00:00Z');
  const current = order('current-shift', 'separator', '2026-10-08T04:00:00Z');
  const scope = parseAssistantScope('Отчёт СМ-1 за смену', catalogs, now);
  assert.equal(scope.filters.to.getTime(), now.getTime() + 1);
  const shift = buildScopedSummaryAnswer('Отчёт СМ-1 за смену', [...orders, current, futureToday], catalogs, now);
  assert.match(shift, /Сепаратор СМ-1/); assert.match(shift, /выдано 1 нарядов/);
});
