import { randomUUID } from 'node:crypto';
import { buildShiftSummary, detectAnomalies } from '../src/domain.ts';

const DAY = 86400000;
const LOCAL_OFFSET = 5 * 3600000;
const dateLabel = value => new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Asia/Qyzylorda' });

export function previousFullWeek(at = new Date()) {
  const timestamp = new Date(at).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid report timestamp');
  const local = new Date(timestamp + LOCAL_OFFSET);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const monday = localMidnight - ((local.getUTCDay() + 6) % 7) * DAY;
  return { from: new Date(monday - LOCAL_OFFSET - 7 * DAY), to: new Date(monday - LOCAL_OFFSET), key: new Date(monday).toISOString().slice(0, 10) };
}

/** Internal inbox only: this automatic report does not contact an external model or delivery service. */
export function deliverWeeklySummary(store, at = new Date()) {
  const now = new Date(at);
  const period = previousFullWeek(now);
  const recipients = store.list('users').filter(user => ['master', 'manager'].includes(user.role))
    .filter(user => !store.get('notificationKeys', `weekly-summary:${period.key}:${user.id}`));
  if (!recipients.length) return { delivered: 0, ...period };
  const catalogs = Object.fromEntries(['users', 'sites', 'equipment', 'brigades', 'faults', 'materials'].map(kind => [kind, store.list(kind)]));
  const orders = store.list('orders');
  const findings = detectAnomalies(orders, catalogs, period, now);
  const insights = findings.slice(0, 4).map(item => `${item.title}. ${item.description} Рекомендация: ${item.recommendation}`).join('\n\n');
  const title = `Еженедельная сводка · ${dateLabel(period.from)} — ${dateLabel(period.to.getTime() - 1)}`;
  const message = `Статистическая сводка за полную неделю, понедельник–воскресенье (время Костаная).\n\n${buildShiftSummary(orders, catalogs, period, now)}\n\n${insights || 'Сигналы повторяющихся проблем за период не обнаружены. Продолжайте контроль сроков и качества приёмки.'}${findings.length > 4 ? `\n\nЕщё ${findings.length - 4} сигналов доступны в аналитике с фильтром за этот период.` : ''}\n\nРасчётный простой получен из интервалов нарядов. Сигналы требуют проверки мастером и не доказывают причину отказа.`;
  store.transaction(() => {
    for (const user of recipients) {
      const key = `weekly-summary:${period.key}:${user.id}`;
      store.put('notifications', { id: randomUUID(), userId: user.id, title, message, kind: 'info', createdAt: now.toISOString(), read: false });
      store.put('notificationKeys', { id: key, at: now.getTime() });
    }
  });
  return { delivered: recipients.length, ...period };
}
