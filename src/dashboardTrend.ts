import type { Order } from './types';

const DAY = 86_400_000;
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qyzylorda', year: 'numeric', month: '2-digit', day: '2-digit' });
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/** One pass over history. Issue and closure count on their respective local calendar days. */
export function dashboardTrend(orders: Order[], now = Date.now(), locale = 'ru') {
  let weekday = weekdayFormatters.get(locale);
  if (!weekday) { weekday = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Qyzylorda', weekday: 'short' }); weekdayFormatters.set(locale, weekday); }
  const rows = Array.from({ length: 7 }, (_, index) => {
    const at = now - (6 - index) * DAY;
    return { key: dayFormatter.format(at), name: weekday!.format(at), issued: 0, done: 0 };
  });
  const days = new Map(rows.map(row => [row.key, row]));
  for (const order of orders) {
    const issued = Date.parse(order.createdAt), closed = Date.parse(order.closedAt || '');
    if (Number.isFinite(issued) && issued <= now) { const row = days.get(dayFormatter.format(issued)); if (row) row.issued++; }
    if (Number.isFinite(closed) && closed <= now) { const row = days.get(dayFormatter.format(closed)); if (row) row.done++; }
  }
  return rows;
}
