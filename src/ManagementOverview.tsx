import { t } from './i18n';
import type { BootstrapResponse, OrderFilters } from './types';
import * as D from './localizedDomain';

export function ManagementOverview({ data, filters = {}, rankings = false }: { data: BootstrapResponse; filters?: OrderFilters; rankings?: boolean }) {
  const stats = D.getManagementStats(data.orders, data.catalogs, filters);
  return <div className="manager-overview">
    <div className="report-stat-grid manager-stats">
      <section className="panel report-stat"><span>{t("Средняя реакция")}</span><strong>{stats.avgReactionMinutes === null ? '—' : t("{v0} мин", { v0: stats.avgReactionMinutes.toFixed(1) })}</strong><small>{t("Выдача → первый ответ ·")} {stats.reactionSampleCount} {t("нарядов")}</small></section>
      <section className="panel report-stat"><span>{t("Среднее исполнение")}</span><strong>{stats.avgExecutionHours === null ? '—' : D.formatDuration(stats.avgExecutionHours)}</strong><small>{t("Начало → исполнено, включая паузы ·")} {stats.executionSampleCount} {t("нарядов")}</small></section>
      <section className="panel report-stat"><span>{t("Расчётный простой")}</span><strong>{D.formatDuration(stats.downtimeHours)}</strong><small>{t("Сумма по оборудованию без пересечений внутри одного агрегата")}</small></section>
    </div>
    {rankings && <div className="analytics-columns manager-top">
      <section className="panel"><div className="panel-heading"><h2>{t("Топ-5 оборудования по отказам")}</h2></div><div className="equipment-ranking">{stats.topEquipment.map((item, index) => <div key={item.equipment.id}><span className="rank-number">{index + 1}</span><div><strong>{item.equipment.name}</strong><small>{D.formatDuration(item.unplannedDowntimeHours)} {t("внепланового простоя")}</small></div><b>{item.unplannedCount}</b></div>)}</div></section>
      <section className="panel"><div className="panel-heading"><h2>{t("Топ-5 исполнителей")}</h2></div>{stats.topWorkers.length ? stats.topWorkers.map((item, index) => <div className="team-person" key={item.userId}><span className="rank-number">{index + 1}</span><div><strong>{item.user.name}</strong><small>{item.closedCount} {t("закрыто ·")} {item.onTimePercent}{t("% в срок")}</small></div><b>{item.score}/100</b></div>) : <p className="panel-subtitle">{t("Пока нет оценённых работ за период")}</p>}</section>
    </div>}
  </div>;
}
