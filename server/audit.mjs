const CATALOG_LABELS = { sites: 'Участки', equipment: 'Оборудование', brigades: 'Бригады', faults: 'Шифры неисправностей', materials: 'Материалы', users: 'Сотрудники' };
const FIELD_LABELS = { name: 'название', siteId: 'участок', inventory: 'инвентарный номер', type: 'тип', criticality: 'критичность', code: 'шифр', specialty: 'специальность', normHours: 'норматив времени', unit: 'единица измерения', normalQuantity: 'норма расхода', login: 'логин', role: 'роль', grade: 'разряд', onShift: 'статус смены', brigadeId: 'бригада', avatar: 'инициалы', pin: 'ПИН-код' };
const invalid = message => { const error = new Error(message); error.status = 400; throw error; };
const string = value => typeof value === 'string' ? value : '';

function dateBoundary(value, end) {
  if (!value) return undefined;
  const calendarDay = value.slice(0, 10);
  const day = new Date(`${calendarDay}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDay) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDay) invalid('Некорректная дата журнала.');
  let timestamp;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Production dates are calendar days in Kostanay (UTC+05:00), independent of browser/server timezone.
    timestamp = Date.parse(`${value}T00:00:00+05:00`) + (end ? 86400000 : 0);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid('Укажите дату или время с часовым поясом.');
    timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) invalid('Некорректная дата журнала.');
  }
  return timestamp;
}

function parseFilters(query) {
  const filters = {};
  for (const key of ['search', 'siteId', 'equipmentId', 'actorId', 'from', 'to', 'kind', 'page', 'pageSize']) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string' || query[key].length > 500) invalid('Некорректные фильтры журнала.');
    filters[key] = query[key].trim();
  }
  if (filters.kind && !['order', 'catalog', 'settings'].includes(filters.kind)) invalid('Неизвестный тип события журнала.');
  for (const [key, fallback, maximum] of [['page', 1, Number.MAX_SAFE_INTEGER], ['pageSize', 50, 100]]) {
    if (filters[key] === undefined || filters[key] === '') filters[key] = fallback;
    else if (!/^[1-9]\d*$/.test(filters[key]) || !Number.isSafeInteger(Number(filters[key])) || Number(filters[key]) > maximum) invalid('Некорректный номер или размер страницы журнала.');
    else filters[key] = Number(filters[key]);
  }
  filters.from = dateBoundary(filters.from, false);
  filters.to = dateBoundary(filters.to, true);
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) invalid('Конец периода должен быть позже начала.');
  return filters;
}

export function catalogAuditDetails(kind, record, changedFields) {
  return {
    entityLabel: `${CATALOG_LABELS[kind] ?? 'Справочник'}: ${record.name}`,
    comment: changedFields ? `Изменены поля: ${changedFields.map(field => FIELD_LABELS[field] ?? 'поле').join(', ')}.` : 'Создана запись справочника.',
    ...(kind === 'equipment' ? { equipmentId: record.id, siteId: record.siteId } : kind === 'sites' ? { siteId: record.id } : {}),
  };
}

/** Read-only projection: never expose arbitrary stored audit properties, auth data or record snapshots. */
export function buildAuditLog(store, user, query = {}, isVisible = (order, actor) => actor.role !== 'worker' || order.assigneeId === actor.id) {
  const filters = parseFilters(query);
  const users = new Map(store.list('users').map(person => [person.id, person]));
  const sites = new Map(store.list('sites').map(site => [site.id, site]));
  const equipment = new Map(store.list('equipment').map(machine => [machine.id, machine]));
  const actorName = item => string(item.actorName) || users.get(item.actorId)?.name || (item.actorId === 'system' ? 'НарядAI' : 'Пользователь');
  const context = item => ({
    ...(item.siteId ? { siteId: item.siteId, siteName: sites.get(item.siteId)?.name ?? 'Участок не найден' } : {}),
    ...(item.equipmentId ? { equipmentId: item.equipmentId, equipmentName: equipment.get(item.equipmentId)?.name ?? 'Оборудование не найдено' } : {}),
  });
  const items = [];
  for (const order of store.list('orders').filter(order => isVisible(order, user))) {
    for (const entry of order.events ?? []) {
      items.push({ id: `order:${order.id}:${entry.id}`, at: entry.at, actorId: entry.actorId ?? 'system', actorName: actorName(entry), action: string(entry.action), comment: string(entry.comment), kind: 'order', orderId: order.id, orderNumber: String(order.number), entityLabel: order.title || `Наряд №${order.number}`, ...context(order), ...(entry.fromStatus ? { fromStatus: entry.fromStatus } : {}), ...(entry.toStatus ? { toStatus: entry.toStatus } : {}) });
    }
  }
  if (user.role !== 'worker') {
    for (const entry of store.list('audit')) {
      const kind = CATALOG_LABELS[entry.kind] ? 'catalog' : entry.kind === 'catalog' ? 'catalog' : 'settings';
      const record = CATALOG_LABELS[entry.kind] && entry.recordId ? store.get(entry.kind, entry.recordId) : null;
      const legacy = record ? catalogAuditDetails(entry.kind, record, entry.changedFields) : {};
      items.push({ id: `audit:${entry.id}`, at: entry.at, actorId: entry.actorId ?? 'system', actorName: actorName(entry), action: string(entry.action), comment: string(entry.comment) || legacy.comment || '', kind, entityLabel: string(entry.entityLabel) || legacy.entityLabel || (kind === 'settings' ? 'Настройки уведомлений' : 'Справочник'), ...context({ siteId: entry.siteId ?? legacy.siteId, equipmentId: entry.equipmentId ?? legacy.equipmentId }) });
    }
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const actorOptions = new Map();
  for (const item of items) if (!actorOptions.has(item.actorId)) actorOptions.set(item.actorId, { id: item.actorId, name: users.get(item.actorId)?.name ?? item.actorName });
  const actors = [...actorOptions.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const search = (filters.search ?? '').toLocaleLowerCase('ru');
  const filtered = items.filter(item => {
    const at = Date.parse(item.at);
    return (!filters.kind || item.kind === filters.kind)
      && (!filters.siteId || item.siteId === filters.siteId)
      && (!filters.equipmentId || item.equipmentId === filters.equipmentId)
      && (!filters.actorId || item.actorId === filters.actorId)
      && (filters.from === undefined || at >= filters.from)
      && (filters.to === undefined || at < filters.to)
      && (!search || [item.action, item.comment, item.actorName, item.orderNumber, item.entityLabel, item.equipmentName, item.siteName].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(search));
  });
  const page = Math.min(filters.page, Math.max(1, Math.ceil(filtered.length / filters.pageSize)));
  return { items: filtered.slice((page - 1) * filters.pageSize, page * filters.pageSize), total: filtered.length, page, pageSize: filters.pageSize, actors };
}
