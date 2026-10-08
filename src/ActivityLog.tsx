import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, ClipboardList, History, RefreshCw, Search, Settings2, SlidersHorizontal, UserRound } from 'lucide-react';
import { api } from './api';
import { t, useLocale, actionLabel } from './i18n';
import { formatDate, formatTime, STATUS_LABELS } from './localizedDomain';
import type { BootstrapResponse, OrderStatus } from './types';
import './activity-log.css';

interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  comment: string;
  kind: 'order' | 'catalog' | 'settings';
  orderId?: string;
  orderNumber?: string;
  equipmentId?: string;
  equipmentName?: string;
  siteId?: string;
  siteName?: string;
  fromStatus?: OrderStatus;
  toStatus?: OrderStatus;
  entityLabel?: string;
}

interface AuditResponse {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  actors: { id: string; name: string }[];
}

type Filters = { search: string; from: string; to: string; siteId: string; equipmentId: string; actorId: string; kind: string; page: number };
const emptyFilters: Filters = { search: '', from: '', to: '', siteId: '', equipmentId: '', actorId: '', kind: '', page: 1 };
const kindLabels = { order: 'Наряды', catalog: 'Справочники', settings: 'Настройки' };
const kindIcons = { order: ClipboardList, catalog: SlidersHorizontal, settings: Settings2 };

function EventDescription({ entry }: { entry: AuditEntry }) {
  const Icon = kindIcons[entry.kind];
  return <div className="activity-event">
    <span className={`activity-event-icon ${entry.kind}`}><Icon size={18} aria-hidden="true" /></span>
    <div>
      <strong>{actionLabel(entry.action)}</strong>
      {entry.toStatus && entry.toStatus !== entry.fromStatus && <div className="activity-transition">
        {entry.fromStatus && <><span>{t(STATUS_LABELS[entry.fromStatus] || entry.fromStatus)}</span><ArrowRight size={12} aria-hidden="true" /></>}
        <span className={`activity-status ${entry.toStatus}`}>{t(STATUS_LABELS[entry.toStatus] || entry.toStatus)}</span>
      </div>}
      {entry.comment && <p>{entry.comment}</p>}
    </div>
  </div>;
}

function EventObject({ entry, open }: { entry: AuditEntry; open: (id: string) => void }) {
  return <div className="activity-object">
    {entry.orderId ? <button type="button" className="activity-order-link" onClick={() => open(entry.orderId!)}> {t("Наряд №")}{entry.orderNumber || entry.orderId}<ArrowRight size={14} aria-hidden="true" />
    </button> : <strong>{entry.entityLabel || t(kindLabels[entry.kind])}</strong>}
    {entry.equipmentName && <span>{entry.equipmentName}</span>}
    {entry.siteName && <small>{entry.siteName}</small>}
  </div>;
}

export function ActivityLog({ data, open }: { data: BootstrapResponse; open: (orderId: string) => void }) {
  const { locale } = useLocale();
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [searchDraft, setSearchDraft] = useState('');
  const [result, setResult] = useState<{ query: string; value: AuditResponse } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(previous => previous.search === searchDraft.trim()
      ? previous : { ...previous, search: searchDraft.trim(), page: 1 }), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(filters.page), pageSize: '50' });
    for (const [key, value] of Object.entries(filters)) if (key !== 'page' && value) params.set(key, String(value));
    return params.toString();
  }, [filters]);
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);

  useEffect(() => {
    let current = true;
    if (invalidRange) { setLoading(false); setError(t('Дата начала должна быть раньше даты окончания или совпадать с ней.')); return; }
    setLoading(true);
    setError('');
    api<AuditResponse>(`/audit?${query}`).then(value => {
      if (current) setResult({ query, value });
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : t('Не удалось загрузить журнал действий.'));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, data.serverTime, refresh, invalidRange, locale]);

  const visible = result?.query === query && !invalidRange ? result.value : null;
  const actors = result?.value.actors || [];
  const filtered = Object.entries(filters).some(([key, value]) => key !== 'page' && Boolean(value)) || Boolean(searchDraft);
  const page = visible?.page || filters.page;
  const pageCount = Math.max(1, Math.ceil((visible?.total || 0) / (visible?.pageSize || 50)));
  const changeFilter = (name: keyof Omit<Filters, 'page' | 'search'>, value: string) => {
    setFilters(previous => ({ ...previous, [name]: value, page: 1, ...(name === 'siteId' ? { equipmentId: '' } : {}) }));
  };
  const reset = () => { setSearchDraft(''); setFilters(emptyFilters); };

  return <div className="activity-log">
    <section className="activity-filters" aria-label={t("Фильтры журнала действий")}>
      <div className="activity-search-row">
        <label className="activity-search"><Search size={18} aria-hidden="true" /><input
          type="search" aria-label={t("Поиск по журналу")} value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
          placeholder={t("Наряд, действие или комментарий…")} /></label>
        <button className="activity-refresh" type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading || invalidRange} aria-label={t("Обновить журнал")}>
          <RefreshCw size={17} className={loading ? 'activity-spinning' : ''} aria-hidden="true" /><span>{t("Обновить")}</span>
        </button>
      </div>
      <div className="activity-filter-grid">
        <label>{t("С даты")}<input type="date" value={filters.from} max={filters.to || undefined} onChange={event => changeFilter('from', event.target.value)} /></label>
        <label>{t("По дату")}<input type="date" value={filters.to} min={filters.from || undefined} onChange={event => changeFilter('to', event.target.value)} /></label>
        <label>{t("Автор")}<select value={filters.actorId} onChange={event => changeFilter('actorId', event.target.value)}>
          <option value="">{t("Все авторы")}</option>{actors.map(actor => <option value={actor.id} key={actor.id}>{actor.name}</option>)}
        </select></label>
        <label>{t("Участок")}<select value={filters.siteId} onChange={event => changeFilter('siteId', event.target.value)}>
          <option value="">{t("Все участки")}</option>{data.catalogs.sites.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}
        </select></label>
        <label>{t("Оборудование")}<select value={filters.equipmentId} onChange={event => changeFilter('equipmentId', event.target.value)}>
          <option value="">{t("Всё оборудование")}</option>{data.catalogs.equipment.filter(item => !filters.siteId || item.siteId === filters.siteId).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <label>{t("Тип события")}<select value={filters.kind} onChange={event => changeFilter('kind', event.target.value)}>
          <option value="">{t("Все события")}</option><option value="order">{t("Наряды")}</option>
          {data.user.role !== 'worker' && <><option value="catalog">{t("Справочники")}</option><option value="settings">{t("Настройки")}</option></>}
        </select></label>
      </div>
      {filtered && <button type="button" className="activity-reset" onClick={reset}>{t("Сбросить фильтры")}</button>}
    </section>

    <section className="activity-results" aria-label={t("События журнала")} aria-busy={loading}>
      <div className="activity-results-heading"><div><History size={20} aria-hidden="true" /><strong>{t("История действий")}</strong>
        {visible && <span className="activity-count">{visible.total.toLocaleString('ru-RU')}</span>}</div>
        <span className="activity-timezone">{t("Время Костаная · UTC+5")}</span>
      </div>
      <div className="activity-live" role="status" aria-live="polite">{loading ? t('Загрузка событий…') : visible ? t('Найдено событий: {count}', { count: visible.total }) : ''}</div>
      {error && <div className="activity-error" role="alert"><p>{t(error)}</p>{!invalidRange && <button type="button" onClick={() => setRefresh(value => value + 1)}>{t("Повторить загрузку")}</button>}</div>}
      {!visible && loading && <div className="activity-empty"><RefreshCw className="activity-spinning" size={26} aria-hidden="true" /><strong>{t("Загружаем события")}</strong><p>{t("Собираем историю нарядов и изменений.")}</p></div>}
      {visible && visible.items.length === 0 && !loading && !error && <div className="activity-empty"><History size={32} aria-hidden="true" /><strong>{filtered ? t('Событий по этим фильтрам нет') : t('Действий пока нет')}</strong><p>{filtered ? t('Измените период или сбросьте фильтры.') : t('Здесь появятся выдача нарядов, смена статусов и другие действия.')}</p>{filtered && <button type="button" className="activity-reset" onClick={reset}>{t("Сбросить фильтры")}</button>}</div>}
      {visible && visible.items.length > 0 && <>
        <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>{t("Когда")}</th><th>{t("Кто")}</th><th>{t("Действие")}</th><th>{t("Объект")}</th></tr></thead>
          <tbody>{visible.items.map(entry => <tr key={entry.id}>
            <td className="activity-date"><time dateTime={entry.at}><strong>{formatTime(entry.at)}</strong><span>{formatDate(entry.at, { year: 'numeric' })}</span></time></td>
            <td className="activity-actor"><span>{entry.actorName || t('Система')}</span><small>{t(kindLabels[entry.kind])}</small></td>
            <td><EventDescription entry={entry} /></td><td><EventObject entry={entry} open={open} /></td>
          </tr>)}</tbody>
        </table></div>
        <ol className="activity-cards">{visible.items.map(entry => <li key={entry.id} className="activity-card">
          <div className="activity-card-meta"><span>{t(kindLabels[entry.kind])}</span><time dateTime={entry.at}>{formatDate(entry.at, { year: 'numeric' })} · {formatTime(entry.at)}</time></div>
          <EventDescription entry={entry} />
          <div className="activity-card-footer"><EventObject entry={entry} open={open} /><span className="activity-card-actor"><UserRound size={14} aria-hidden="true" />{entry.actorName || t('Система')}</span></div>
        </li>)}</ol>
      </>}
      {visible && visible.total > 0 && <div className="activity-pagination">
        <span>{t('Показано {from}–{to} из {total}', { from: ((page - 1) * visible.pageSize + 1).toLocaleString(locale), to: Math.min(page * visible.pageSize, visible.total).toLocaleString(locale), total: visible.total.toLocaleString(locale) })}</span>
        <div><button type="button" disabled={page <= 1 || loading} onClick={() => setFilters(previous => ({ ...previous, page: page - 1 }))} aria-label={t("Предыдущая страница журнала")}><ChevronLeft size={18} /></button>
          <span>{page} / {pageCount}</span><button type="button" disabled={page >= pageCount || loading} onClick={() => setFilters(previous => ({ ...previous, page: page + 1 }))} aria-label={t("Следующая страница журнала")}><ChevronRight size={18} /></button>
        </div>
      </div>}
    </section>
  </div>;
}
