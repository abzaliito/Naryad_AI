import { t, actionLabel, criticalityLabel } from './i18n';
import type { Assessment, BootstrapResponse, Completion, Order, Photo } from './types';
import { formatDate, PRIORITY_LABELS, STATUS_LABELS, TIME_ZONE, VERDICT_LABELS } from './localizedDomain';
import './print.css';

const stamp = (value?: string) => formatDate(value, { year: 'numeric', hour: '2-digit', minute: '2-digit' });
const checkLabels = { pass: 'Пройдено', warn: 'Замечание', fail: 'Не пройдено' } as const;

function PrintPhotos({ photos, data }: { photos: Photo[]; data: BootstrapResponse }) {
  if (!photos.length) return <p className="order-print-muted">{t("Фотографии не приложены.")}</p>;
  return <div className="order-print-photos">{photos.map(photo => <figure key={photo.id}>
    <img src={photo.url} alt={photo.kind === 'before' ? t('Фото до ремонта') : t('Фото после ремонта')} />
    <figcaption><strong>{photo.kind === 'before' ? t('До ремонта') : t('После ремонта')}</strong>
      <span>{t("Заявленное время снимка:")} {stamp(photo.capturedAt)}</span>
      <span>{t("Загружено:")} {stamp(photo.uploadedAt)}</span>
      <span>{t("Автор:")} {data.catalogs.users.find(user => user.id === photo.authorId)?.name || t('Не указан')}</span>
    </figcaption>
  </figure>)}</div>;
}

function PrintCompletion({ completion, data }: { completion?: Completion; data: BootstrapResponse }) {
  if (!completion) return <p className="order-print-muted">{t("Отчёт об исполнении ещё не представлен.")}</p>;
  const fault = data.catalogs.faults.find(item => item.id === completion.faultId);
  return <>
    <p className="order-print-text">{completion.works || t('Выполненные работы не описаны.')}</p>
    <p><strong>{t("Шифр неисправности:")}</strong> {fault ? `${fault.code} — ${fault.name}` : completion.faultId || t('Не указан')}</p>
    <p><strong>{t("Отчёт отправлен:")}</strong> {stamp(completion.submittedAt)}</p>
    <h3>{t("Материалы и запчасти")}</h3>
    {completion.materials.length ? <table><thead><tr><th scope="col">{t("Материал")}</th><th scope="col">{t("Количество")}</th><th scope="col">{t("Единица")}</th></tr></thead>
      <tbody>{completion.materials.map((usage, index) => {
        const material = data.catalogs.materials.find(item => item.id === usage.materialId);
        return <tr key={`${usage.materialId}-${index}`}><td>{material?.name || usage.materialId}</td><td>{usage.quantity}</td><td>{material?.unit || '—'}</td></tr>;
      })}</tbody></table> : <p>{completion.materialsConfirmed === true ? t('Исполнитель подтвердил: материалы не использовались.') : completion.materialsConfirmed === false ? t('Исполнитель не подтвердил сведения о материалах.') : t('Материалы не указаны в отчёте.')}</p>}
    {completion.comment && <p className="order-print-text"><strong>{t("Комментарий исполнителя:")}</strong> {completion.comment}</p>}
  </>;
}

function PrintAssessment({ assessment }: { assessment?: Assessment }) {
  if (!assessment) return <p className="order-print-muted">{t("Заключение проверки пока отсутствует.")}</p>;
  return <>
    <div className="order-print-assessment">
      <strong>{t(VERDICT_LABELS[assessment.verdict])}</strong>
      <span>{t("Оценка системы:")} {assessment.score} / 5{assessment.masterScore !== undefined && t(" · Оценка мастера: {v0} / 5", { v0: assessment.masterScore })}</span>
      <span>{t("Провайдер:")} {assessment.provider} {t("· Уверенность:")} {Math.round(assessment.confidence * 100)}%</span>
      <span>{t("Проверено:")} {stamp(assessment.reviewedAt)}</span>
    </div>
    <p className="order-print-text">{assessment.summary}</p>
    <table className="order-print-checks"><thead><tr><th scope="col">{t("Проверка")}</th><th scope="col">{t("Результат")}</th><th scope="col">{t("Обоснование")}</th></tr></thead><tbody>{assessment.checks.map((check, index) => <tr key={index}>
      <td>{check.label}</td><td>{t(checkLabels[check.status])}</td><td>{check.detail}</td>
    </tr>)}</tbody></table>
    {!!assessment.strengths.length && <><h3>{t("Что сделано хорошо")}</h3><ul>{assessment.strengths.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {!!assessment.improvements.length && <><h3>{t("Замечания и рекомендации")}</h3><ul>{assessment.improvements.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {assessment.masterComment && <p className="order-print-text"><strong>{t("Комментарий мастера:")}</strong> {assessment.masterComment}</p>}
    <p className="order-print-muted">{t("Проверка системы является рекомендацией. Окончательное закрытие подтверждает мастер; текущий статус указан в карточке.")}</p>
  </>;
}

/** Independent of the active screen tab: printing always contains the complete saved report. */
export default function OrderPrint({ order, data }: { order: Order; data: BootstrapResponse }) {
  const catalogs = data.catalogs;
  const equipment = catalogs.equipment.find(item => item.id === order.equipmentId);
  const assignee = catalogs.users.find(user => user.id === order.assigneeId);
  const brigade = catalogs.brigades.find(item => item.id === (order.brigadeId || assignee?.brigadeId));
  const events = [...order.events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return <article className="order-print" aria-label={t("Полный отчёт по наряду №{v0}", { v0: order.number })}>
    <header className="order-print-header">
      <p>{t("АО «Костанайские минералы» · НарядAI")}</p>
      <h1>{t("Наряд №")}{order.number}</h1>
      <h2>{order.title || order.description}</h2>
      <p><strong>{t(STATUS_LABELS[order.status])}</strong> · {t(PRIORITY_LABELS[order.priority])} · {order.type === 'planned' ? t('Плановые работы') : t('Внеплановые работы')}</p>
    </header>

    <section><h2>{t("Карточка наряда")}</h2><dl className="order-print-facts">
      <div><dt>{t("Участок")}</dt><dd>{catalogs.sites.find(item => item.id === order.siteId)?.name || order.siteId}</dd></div>
      <div><dt>{t("Оборудование")}</dt><dd>{equipment?.name || order.equipmentId}</dd></div>
      <div><dt>{t("Инвентарный номер")}</dt><dd>{equipment?.inventory || '—'}</dd></div>
      <div><dt>{t("Тип / критичность оборудования")}</dt><dd>{equipment?.type || '—'} / {criticalityLabel(equipment?.criticality)}</dd></div>
      <div><dt>{t("Исполнитель")}</dt><dd>{assignee?.name || order.assigneeId}</dd></div>
      <div><dt>{t("Специальность / бригада")}</dt><dd>{assignee?.specialty || '—'} / {brigade?.name || t('Не указана')}</dd></div>
      <div><dt>{t("Выдал мастер")}</dt><dd>{catalogs.users.find(user => user.id === order.masterId)?.name || order.masterId}</dd></div>
      <div><dt>{t("Норматив")}</dt><dd>{order.normHours} {t("ч")}</dd></div>
      <div><dt>{t("Выдан")}</dt><dd>{stamp(order.createdAt)}</dd></div>
      <div><dt>{t("Срок исполнения")}</dt><dd>{stamp(order.dueAt)}</dd></div>
      <div><dt>{t("Начало исполнения")}</dt><dd>{stamp(order.startedAt)}</dd></div>
      <div><dt>{t("Исполнение отмечено")}</dt><dd>{stamp(order.completedAt)}</dd></div>
      <div><dt>{t("Закрыт мастером")}</dt><dd>{stamp(order.closedAt)}</dd></div>
    </dl></section>

    <section><h2>{t("Задание")}</h2><p className="order-print-text">{order.description}</p>{order.comment && <p className="order-print-text"><strong>{t("Комментарий мастера:")}</strong> {order.comment}</p>}</section>
    <section><h2>{t("Текущий отчёт об исполнении")}</h2><PrintCompletion completion={order.completion} data={data} /></section>
    <section><h2>{t("Фотографии до и после")}</h2><PrintPhotos photos={order.photos} data={data} /></section>
    <section><h2>{t("Проверка и оценка качества")}</h2><PrintAssessment assessment={order.assessment} /></section>

    {!!order.completionHistory?.length && <section><h2>{t("Предыдущие попытки исполнения")}</h2>{order.completionHistory.map((attempt, index) => <div className="order-print-attempt" key={`${attempt.archivedAt}-${index}`}>
      <h3>{t("Попытка")} {index + 1} · {catalogs.users.find(user => user.id === attempt.assigneeId)?.name || attempt.assigneeId}</h3>
      <p>{t("Исполнено:")} {stamp(attempt.completedAt || attempt.completion.submittedAt)} {t("· Архивировано:")} {stamp(attempt.archivedAt)}</p>
      <p className="order-print-text"><strong>{t("Причина сохранения:")}</strong> {attempt.reason}</p>
      <PrintCompletion completion={attempt.completion} data={data} />
      <h3>{t("Фото предыдущей попытки")}</h3><PrintPhotos photos={attempt.photos} data={data} />
      <h3>{t("Заключение предыдущей проверки")}</h3><PrintAssessment assessment={attempt.assessment} />
    </div>)}</section>}

    <section><h2>{t("Полная хронология")}</h2>{events.length ? <table className="order-print-timeline"><thead><tr><th scope="col">{t("Дата и автор")}</th><th scope="col">{t("Действие / статус")}</th><th scope="col">{t("Комментарий")}</th></tr></thead><tbody>{events.map(event => <tr key={event.id}>
      <td>{stamp(event.at)}<br />{event.actorName || catalogs.users.find(user => user.id === event.actorId)?.name || event.actorId || t('Система')}</td>
      <td>{actionLabel(event.action)}{event.toStatus && <span className="order-print-transition">{event.fromStatus ? `${t(STATUS_LABELS[event.fromStatus])} → ` : ''}{t(STATUS_LABELS[event.toStatus])}</span>}</td>
      <td className="order-print-text">{event.comment || '—'}</td>
    </tr>)}</tbody></table> : <p>{t("События не зарегистрированы.")}</p>}</section>

    <footer className="order-print-footer">{t("НарядAI · Версия наряда")} {order.version} {t("· Сформировано")} {stamp(new Date().toISOString())}<br />{t("Время в отчёте:")} {TIME_ZONE}{t(". Учебный стенд · Qostanai Industry Hackathon 2026.")}</footer>
  </article>;
}
