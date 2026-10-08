import { filterOrders, getPeriodRange, getEquipmentStats, detectAnomalies, buildShiftSummary, formatDate } from '../src/domain.ts';

const normalize = value => String(value ?? '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[‐‑–—]/g, '-').trim();
const words = value => normalize(value).match(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu) ?? [];
const token = value => value.replace(/[-_]/g, '');
const canonical = value => /^(?:дроб|ұсат|майдала)/u.test(value) ? 'дроб' : /^(?:обог|байыт)/u.test(value) ? 'обог' : value.slice(0, 4);
const SITE_GENERIC = /^(?:участ|учаск|комплекс|фабрик|цех|завод|өндір|бөлім)/u;
const EQUIPMENT_GENERIC = /^(?:насос|сорғы|конвей|дробил|грохот|компресс|электродвиг|двигат|сепарат|мельниц|оборуд|жабдық|машин|агрегат|установ)/u;

function matchCatalog(question, records, kind) {
  const queryWords = words(question);
  const queryTokens = new Set(queryWords.map(token));
  const padded = ` ${queryWords.join(' ')} `;
  const ranked = records.map(record => {
    const nameWords = words(record.name);
    let score = padded.includes(` ${nameWords.join(' ')} `) ? 100 + nameWords.length : 0;
    for (const part of nameWords) {
      if (/\d/.test(part) && queryTokens.has(token(part))) score += 25;
      else if (kind === 'site' && part.length >= 4 && !SITE_GENERIC.test(part) && queryWords.some(word => word.length >= 4 && canonical(word) === canonical(part))) score += 2;
      else if (kind === 'equipment' && part.length >= 4 && !EQUIPMENT_GENERIC.test(part) && queryTokens.has(token(part))) score += 2;
    }
    if (kind === 'equipment' && record.inventory && queryTokens.has(token(normalize(record.inventory)))) score += 30;
    return { record, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return { match: ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].record : undefined, ambiguous: ranked.length > 1 && ranked[0].score === ranked[1].score };
}

export function parseAssistantScope(question, catalogs, now = new Date(), defaultPeriod = 'month') {
  const message = normalize(question);
  const at = new Date(now);
  const siteResult = matchCatalog(message, catalogs.sites, 'site');
  const equipmentResult = matchCatalog(message, catalogs.equipment, 'equipment');
  const site = siteResult.match;
  const equipment = equipmentResult.match;
  let error;
  if (siteResult.ambiguous || equipmentResult.ambiguous) error = 'Найдено несколько подходящих участков или единиц оборудования. Уточните название или инвентарный номер из справочника.';
  if (site && equipment && equipment.siteId !== site.id) error = 'Указанное оборудование относится к другому участку. Уточните участок или оборудование.';
  if (!site && !equipment && /участ|учаск/u.test(message) && !/(?:все|всем|всех|барлық)\s+участ|барлық\s+учаск/u.test(message)) error ??= 'Участок из вопроса не найден в справочнике. Укажите его название; данные других участков не подставлены.';
  if (!equipment && words(message).some(word => /^[\p{L}]{1,8}-?\d+[\p{L}\d-]*$/u.test(word))) error ??= 'Оборудование с указанным обозначением не найдено в справочнике. Уточните название или инвентарный номер.';
  const period = /вс[юяе].*истори|барлық.*тарих/u.test(message) ? 'all'
    : /недел|апта/u.test(message) ? 'week'
      : /месяц|(?:^|\s)ай(?:да|дағы|лық|ға|\s|$)/u.test(message) ? 'month'
        : /сутк|сегодня|сег[оө]дня|бүгін|тәулік/u.test(message) ? 'day'
          : /смен|ауысым/u.test(message) ? 'shift' : defaultPeriod;
  const range = getPeriodRange(period, at);
  // Future records must not enter answers, including the unelapsed part of the current shift.
  const to = new Date(Math.min(range.to ? new Date(range.to).getTime() : Infinity, at.getTime() + 1));
  const filters = { ...range, to, ...(site ? { siteId: site.id } : equipment ? { siteId: equipment.siteId } : {}), ...(equipment ? { equipmentId: equipment.id } : {}) };
  const effectiveSite = site ?? (equipment && catalogs.sites.find(item => item.id === equipment.siteId));
  const label = [effectiveSite?.name ?? 'Все участки', equipment?.name].filter(Boolean).join(' · ');
  return { filters, label, period, error, at };
}

const periodLabel = scope => `${scope.label}. Период: ${scope.filters.from ? formatDate(scope.filters.from) : 'начало истории'} — ${formatDate(scope.filters.to)} (до текущего момента).`;

export function buildScopedAnomalyAnswer(question, orders, catalogs, now = new Date()) {
  const scope = parseAssistantScope(question, catalogs, now, 'month');
  if (scope.error) return scope.error;
  const history = orders.filter(order => Date.parse(order.createdAt) <= scope.at.getTime());
  const selected = filterOrders(history, scope.filters, catalogs, scope.at).filter(order => order.status !== 'cancelled');
  const scopedEquipment = catalogs.equipment.filter(item => (!scope.filters.siteId || item.siteId === scope.filters.siteId) && (!scope.filters.equipmentId || item.id === scope.filters.equipmentId));
  const stats = getEquipmentStats(history, scopedEquipment, scope.filters, scope.at).filter(item => item.orderCount > 0).sort((a, b) => b.unplannedCount - a.unplannedCount || b.downtimeHours - a.downtimeHours);
  const findings = detectAnomalies(history, { ...catalogs, equipment: scopedEquipment }, scope.filters, scope.at);
  const unplanned = selected.filter(order => order.type === 'unplanned').length;
  const top = stats.slice(0, 3).map(item => `${item.equipment.name} — ${item.unplannedCount} внеплановых нарядов, расчётный простой ${item.downtimeHours} ч`).join('; ');
  const details = findings.slice(0, 4).map(item => `${item.title}. ${item.description} Рекомендация: ${item.recommendation}`).join('\n\n');
  return `${periodLabel(scope)} В выбранном периоде: ${selected.length} нарядов, внеплановых ${unplanned}; отменённые исключены. ${top ? `Оборудование с наибольшим числом внеплановых нарядов: ${top}.` : 'За выбранный период наряды не найдены.'}\n\n${details || 'По доступным данным периода пороговые сигналы аномалий не обнаружены. Рекомендуется продолжать контроль повторных дефектов и качества приёмки.'}${findings.length > 4 ? `\n\nЕщё ${findings.length - 4} сигналов доступны в аналитике с теми же фильтрами.` : ''}\n\nЭто наблюдения по нарядам и расчётные интервалы простоя, а не доказательство причины или вероятности отказа.`;
}

export function buildScopedSummaryAnswer(question, orders, catalogs, now = new Date()) {
  const scope = parseAssistantScope(question, catalogs, now, 'shift');
  if (scope.error) return scope.error;
  const history = orders.filter(order => Date.parse(order.createdAt) <= scope.at.getTime());
  return `${periodLabel(scope)} ${buildShiftSummary(history, catalogs, scope.filters, scope.at)} Полную выгрузку за этот период можно получить в разделе «Отчёты».`;
}
