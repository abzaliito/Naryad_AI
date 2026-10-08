import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../src/domain.ts';
import * as ui from '../src/localizedDomain.ts';
import { setLocale } from '../src/i18n.ts';
import { createSeed } from '../server/seed.mjs';

const now = new Date('2026-10-08T10:00:00Z');
const seed = createSeed(now);
const filters = { from: new Date('2026-09-01T00:00:00Z'), to: now };

test('Russian presentation facade preserves domain output exactly', t => {
  setLocale('ru'); t.after(() => setLocale('ru'));
  for (const [name, args] of [
    ['formatDate', [now]], ['formatTime', [now]], ['formatDateTime', [now]], ['formatDuration', [1.25]], ['relativeTime', [now, now]],
    ['getShiftRange', [now]], ['getPeriodRange', ['shift', now]], ['getOrderTrend', [seed.orders, filters, 'month', now]],
    ['getWorkerWorkloads', [seed.users, seed.orders, now]], ['calculateRatings', [seed.orders, seed.users, filters]],
    ['getManagementStats', [seed.orders, seed, filters, now]], ['buildShiftSummary', [seed.orders, seed, filters, now]],
    ['detectAnomalies', [seed.orders, seed, filters, now]],
  ]) assert.deepEqual(ui[name](...args), domain[name](...args), name);
});

test('Kazakh summaries, ratings, dates and workload labels preserve numbers and original record names', t => {
  setLocale('kk'); t.after(() => setLocale('ru'));
  assert.equal(ui.formatDate(now), new Intl.DateTimeFormat('kk-KZ', { day: '2-digit', month: 'short', timeZone: domain.TIME_ZONE }).format(now));
  assert.equal(ui.formatDuration(1.25), '1 сағ 15 мин'); assert.equal(ui.formatDuration(0.5), '30 мин'); assert.equal(ui.formatDate(null), '—');
  assert.equal(ui.relativeTime(now, now), 'қазір'); assert.match(ui.getShiftRange(now).label, /Күндізгі ауысым/);
  const worker = { id: 'worker', role: 'worker', name: 'Мастер Рабочий', onShift: true };
  const order = { id: 'order', assigneeId: 'worker', status: 'in_progress', number: '001', dueAt: now.toISOString(), createdAt: now.toISOString() };
  assert.equal(ui.getWorkerWorkload(worker, [order], now).label, 'Орындалуда №001');
  assert.equal(ui.getWorkerWorkload(worker, [{ ...order, status: 'paused' }], now).label, 'Уақытша тоқтатылды №001');
  assert.equal(ui.getWorkerWorkload(worker, [{ ...order, status: 'accepted' }], now).label, 'Қабылданды №001');
  assert.equal(ui.getWorkerWorkload(worker, [{ ...order, status: 'queued' }], now).label, 'Кезекте: 1');
  assert.equal(ui.getWorkerWorkload(worker, [], now).label, 'Бос');
  assert.equal(ui.getWorkerWorkload({ ...worker, onShift: false }, [], now).label, 'Ауысымда емес');
  assert.equal(ui.getWorkerWorkload(worker, [order], now).user.name, worker.name);
  const stats = domain.getDashboardStats(seed.orders, seed.users, filters, now);
  const summary = ui.buildShiftSummary(seed.orders, seed, filters, now);
  assert.ok(summary.includes(`${stats.issued} наряд берілді`)); assert.ok(summary.includes(`${stats.completed} наряд орындалды`)); assert.ok(summary.includes(`${stats.overdue} нарядтың мерзімі өткен`));
  const before = domain.calculateRatings(seed.orders, seed.users, filters), after = ui.calculateRatings(seed.orders, seed.users, filters);
  assert.deepEqual(after.map(({ explanation, ...row }) => row), before.map(({ explanation, ...row }) => row));
  assert.ok(after.filter(row => row.evaluated).every(row => row.explanation.includes('7 күн ішінде') && row.explanation.includes(`${row.weighted.quality}/40`)));
  const trendBefore = domain.getOrderTrend(seed.orders, filters, 'month', now), trendAfter = ui.getOrderTrend(seed.orders, filters, 'month', now);
  assert.deepEqual(trendAfter.map(({ label, ...row }) => row), trendBefore.map(({ label, ...row }) => row));
});

test('All nine anomaly kinds translate generated conclusions while retaining data and statistical caveats', t => {
  setLocale('kk'); t.after(() => setLocale('ru'));
  const catalogs = { equipment: [{ id: 'machine', name: 'Насос — В работе' }], users: [{ id: 'worker', name: 'Иван Мастер' }], brigades: [{ id: 'team', name: 'Бригада — Команда' }], faults: [{ id: 'fault', code: 'М-02', name: 'Подшипник — Ремонт' }], materials: [{ id: 'oil', name: 'Масло — Склад', unit: 'л', normalQuantity: 2 }], sites: [] };
  const orders = [{ id: 'order', createdAt: now.toISOString(), equipmentId: 'machine', faultId: 'fault', completion: { materials: [{ materialId: 'oil', quantity: 5 }] } }];
  const common = { severity: 'medium', orderIds: ['order'], count: 5, recommendation: 'Исходная рекомендация', title: 'Исходный заголовок' };
  const findings = [
    { id: 'frequency-machine', type: 'frequency', equipmentId: 'machine', description: '10 внеплановых нарядов — в 5 раза выше медианы оборудования (2) за выбранный период. Расчётный простой: 12.5 ч.' },
    { id: 'repeat-machine-fault', type: 'repeat_fault', equipmentId: 'machine', description: '5 внеплановых нарядов с одной неисправностью «Подшипник — Ремонт». Возможен неустранённый первичный дефект.' },
    { id: 'material-oil', type: 'materials', description: 'В 5 нарядах расход выше справочного норматива более чем на 50%. Среднее: 5 л, норматив: 2 л на работу.' },
    { id: 'maintenance-machine', type: 'post_maintenance', equipmentId: 'machine', description: '5 внеплановых нарядов возникли в течение 7 дней после планового обслуживания. Связь во времени требует проверки, причина пока не установлена.' },
    { id: 'rework-worker', type: 'rework', userId: 'worker', description: '5 из 10 проверенных нарядов (50%) возвращались на доработку. Учитывайте сложность работ перед оценкой сотрудника.' },
    { id: 'shift-night', type: 'shift_dependency', description: '8 из 10 выданных нарядов (80%) — внеплановые; в другой смене 2 из 10 (20%). Группа определяется по времени выдачи в Asia/Qyzylorda; это связь в заявках, а не установленное время поломки или её причина.' },
    ...['worker', 'brigade'].map(kind => ({ id: `dependency-${kind}-test`, type: `${kind}_dependency`, userId: kind === 'worker' ? 'worker' : undefined, brigadeId: kind === 'brigade' ? 'team' : undefined, description: 'В 5 из 10 закрытых ремонтов (50%) была доработка или тот же дефект в следующие 7 дней; в остальной выбранной группе — 1 из 10 (10%). Учтены только ремонты с полными 7 днями наблюдения. Связь не доказывает вину исполнителя или бригады.' })),
    { id: 'growth-machine', type: 'failure_growth', equipmentId: 'machine', evidence: { windowDays: 14, currentCount: 10, previousCount: 3, ratio: 3.3 }, description: 'За последние 14 дней — 10 внеплановых нарядов, за предыдущие равные 14 дней — 3; рост в 3.3 раза. Это ранний сигнал риска по заявкам, а не рассчитанная вероятность или дата отказа.' },
  ].map(row => ({ ...common, ...row }));
  for (const finding of findings) {
    const translated = ui.localizeAnomaly(finding, orders, catalogs, {}, now);
    assert.notEqual(translated.title, finding.title, finding.type); assert.notEqual(translated.description, finding.description, finding.type); assert.notEqual(translated.recommendation, finding.recommendation, finding.type);
    const { title: _title, description: _description, recommendation: _recommendation, ...expected } = finding;
    const { title, description, recommendation, ...actual } = translated;
    assert.deepEqual(actual, expected);
    if (finding.equipmentId) assert.ok(title.includes(catalogs.equipment[0].name), finding.type);
    if (finding.userId) assert.ok(title.includes(catalogs.users[0].name), finding.type);
    if (finding.brigadeId) assert.ok(title.includes(catalogs.brigades[0].name), finding.type);
    if (finding.type === 'repeat_fault') assert.ok(description.includes(catalogs.faults[0].name));
    if (finding.type === 'materials') { assert.ok(title.includes(catalogs.materials[0].name)); assert.match(description, /50%/); }
    if (finding.type.endsWith('_dependency') && finding.type !== 'shift_dependency') { assert.match(description, /толық 7 күн/); assert.match(description, /кінәсін дәлелдемейді/); assert.match(description, /50%/); assert.match(description, /10%/); }
    if (finding.type === 'shift_dependency') { assert.match(description, /80%/); assert.match(description, /20%/); assert.match(description, /себебі емес/); }
    if (finding.type === 'post_maintenance') { assert.match(description, /7 күн/); assert.match(description, /себеп әлі анықталмаған/); }
    if (finding.type === 'failure_growth') { assert.match(description, /3.3 есе/); assert.match(description, /оң жақ шекара кірмейді/); assert.match(description, /ықтималдығы немесе күні емес/); }
  }
  const actualRussian = domain.detectAnomalies(seed.orders, seed, filters, now);
  const actualKazakh = ui.detectAnomalies(seed.orders, seed, filters, now);
  assert.equal(actualKazakh.length, actualRussian.length);
  assert.ok(actualRussian.length > 0);
  for (let index = 0; index < actualRussian.length; index++) {
    assert.equal(actualKazakh[index].id, actualRussian[index].id); assert.equal(actualKazakh[index].count, actualRussian[index].count);
    assert.notEqual(actualKazakh[index].description, actualRussian[index].description, actualRussian[index].type);
  }
});
