import type { Assessment, BootstrapResponse, Completion, Order, Photo } from './types';
import { formatDate, PRIORITY_LABELS, STATUS_LABELS, TIME_ZONE, VERDICT_LABELS } from './domain';
import './print.css';

const stamp = (value?: string) => formatDate(value, { year: 'numeric', hour: '2-digit', minute: '2-digit' });
const checkLabels = { pass: 'Пройдено', warn: 'Замечание', fail: 'Не пройдено' } as const;

function PrintPhotos({ photos, data }: { photos: Photo[]; data: BootstrapResponse }) {
  if (!photos.length) return <p className="order-print-muted">Фотографии не приложены.</p>;
  return <div className="order-print-photos">{photos.map(photo => <figure key={photo.id}>
    <img src={photo.url} alt={photo.kind === 'before' ? 'Фото до ремонта' : 'Фото после ремонта'} />
    <figcaption><strong>{photo.kind === 'before' ? 'До ремонта' : 'После ремонта'}</strong>
      <span>Заявленное время снимка: {stamp(photo.capturedAt)}</span>
      <span>Загружено: {stamp(photo.uploadedAt)}</span>
      <span>Автор: {data.catalogs.users.find(user => user.id === photo.authorId)?.name || 'Не указан'}</span>
    </figcaption>
  </figure>)}</div>;
}

function PrintCompletion({ completion, data }: { completion?: Completion; data: BootstrapResponse }) {
  if (!completion) return <p className="order-print-muted">Отчёт об исполнении ещё не представлен.</p>;
  const fault = data.catalogs.faults.find(item => item.id === completion.faultId);
  return <>
    <p className="order-print-text">{completion.works || 'Выполненные работы не описаны.'}</p>
    <p><strong>Шифр неисправности:</strong> {fault ? `${fault.code} — ${fault.name}` : completion.faultId || 'Не указан'}</p>
    <p><strong>Отчёт отправлен:</strong> {stamp(completion.submittedAt)}</p>
    <h3>Материалы и запчасти</h3>
    {completion.materials.length ? <table><thead><tr><th scope="col">Материал</th><th scope="col">Количество</th><th scope="col">Единица</th></tr></thead>
      <tbody>{completion.materials.map((usage, index) => {
        const material = data.catalogs.materials.find(item => item.id === usage.materialId);
        return <tr key={`${usage.materialId}-${index}`}><td>{material?.name || usage.materialId}</td><td>{usage.quantity}</td><td>{material?.unit || '—'}</td></tr>;
      })}</tbody></table> : <p>{completion.materialsConfirmed === true ? 'Исполнитель подтвердил: материалы не использовались.' : completion.materialsConfirmed === false ? 'Исполнитель не подтвердил сведения о материалах.' : 'Материалы не указаны в отчёте.'}</p>}
    {completion.comment && <p className="order-print-text"><strong>Комментарий исполнителя:</strong> {completion.comment}</p>}
  </>;
}

function PrintAssessment({ assessment }: { assessment?: Assessment }) {
  if (!assessment) return <p className="order-print-muted">Заключение проверки пока отсутствует.</p>;
  return <>
    <div className="order-print-assessment">
      <strong>{VERDICT_LABELS[assessment.verdict]}</strong>
      <span>Оценка системы: {assessment.score} / 5{assessment.masterScore !== undefined && ` · Оценка мастера: ${assessment.masterScore} / 5`}</span>
      <span>Провайдер: {assessment.provider} · Уверенность: {Math.round(assessment.confidence * 100)}%</span>
      <span>Проверено: {stamp(assessment.reviewedAt)}</span>
    </div>
    <p className="order-print-text">{assessment.summary}</p>
    <table className="order-print-checks"><thead><tr><th scope="col">Проверка</th><th scope="col">Результат</th><th scope="col">Обоснование</th></tr></thead><tbody>{assessment.checks.map((check, index) => <tr key={index}>
      <td>{check.label}</td><td>{checkLabels[check.status]}</td><td>{check.detail}</td>
    </tr>)}</tbody></table>
    {!!assessment.strengths.length && <><h3>Что сделано хорошо</h3><ul>{assessment.strengths.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {!!assessment.improvements.length && <><h3>Замечания и рекомендации</h3><ul>{assessment.improvements.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {assessment.masterComment && <p className="order-print-text"><strong>Комментарий мастера:</strong> {assessment.masterComment}</p>}
    <p className="order-print-muted">Проверка системы является рекомендацией. Окончательное закрытие подтверждает мастер; текущий статус указан в карточке.</p>
  </>;
}

/** Independent of the active screen tab: printing always contains the complete saved report. */
export default function OrderPrint({ order, data }: { order: Order; data: BootstrapResponse }) {
  const catalogs = data.catalogs;
  const equipment = catalogs.equipment.find(item => item.id === order.equipmentId);
  const assignee = catalogs.users.find(user => user.id === order.assigneeId);
  const brigade = catalogs.brigades.find(item => item.id === (order.brigadeId || assignee?.brigadeId));
  const events = [...order.events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return <article className="order-print" aria-label={`Полный отчёт по наряду №${order.number}`}>
    <header className="order-print-header">
      <p>АО «Костанайские минералы» · НарядAI</p>
      <h1>Наряд №{order.number}</h1>
      <h2>{order.title || order.description}</h2>
      <p><strong>{STATUS_LABELS[order.status]}</strong> · {PRIORITY_LABELS[order.priority]} · {order.type === 'planned' ? 'Плановые работы' : 'Внеплановые работы'}</p>
    </header>

    <section><h2>Карточка наряда</h2><dl className="order-print-facts">
      <div><dt>Участок</dt><dd>{catalogs.sites.find(item => item.id === order.siteId)?.name || order.siteId}</dd></div>
      <div><dt>Оборудование</dt><dd>{equipment?.name || order.equipmentId}</dd></div>
      <div><dt>Инвентарный номер</dt><dd>{equipment?.inventory || '—'}</dd></div>
      <div><dt>Тип / критичность оборудования</dt><dd>{equipment?.type || '—'} / {equipment?.criticality || '—'}</dd></div>
      <div><dt>Исполнитель</dt><dd>{assignee?.name || order.assigneeId}</dd></div>
      <div><dt>Специальность / бригада</dt><dd>{assignee?.specialty || '—'} / {brigade?.name || 'Не указана'}</dd></div>
      <div><dt>Выдал мастер</dt><dd>{catalogs.users.find(user => user.id === order.masterId)?.name || order.masterId}</dd></div>
      <div><dt>Норматив</dt><dd>{order.normHours} ч</dd></div>
      <div><dt>Выдан</dt><dd>{stamp(order.createdAt)}</dd></div>
      <div><dt>Срок исполнения</dt><dd>{stamp(order.dueAt)}</dd></div>
      <div><dt>Начало исполнения</dt><dd>{stamp(order.startedAt)}</dd></div>
      <div><dt>Исполнение отмечено</dt><dd>{stamp(order.completedAt)}</dd></div>
      <div><dt>Закрыт мастером</dt><dd>{stamp(order.closedAt)}</dd></div>
    </dl></section>

    <section><h2>Задание</h2><p className="order-print-text">{order.description}</p>{order.comment && <p className="order-print-text"><strong>Комментарий мастера:</strong> {order.comment}</p>}</section>
    <section><h2>Текущий отчёт об исполнении</h2><PrintCompletion completion={order.completion} data={data} /></section>
    <section><h2>Фотографии до и после</h2><PrintPhotos photos={order.photos} data={data} /></section>
    <section><h2>Проверка и оценка качества</h2><PrintAssessment assessment={order.assessment} /></section>

    {!!order.completionHistory?.length && <section><h2>Предыдущие попытки исполнения</h2>{order.completionHistory.map((attempt, index) => <div className="order-print-attempt" key={`${attempt.archivedAt}-${index}`}>
      <h3>Попытка {index + 1} · {catalogs.users.find(user => user.id === attempt.assigneeId)?.name || attempt.assigneeId}</h3>
      <p>Исполнено: {stamp(attempt.completedAt || attempt.completion.submittedAt)} · Архивировано: {stamp(attempt.archivedAt)}</p>
      <p className="order-print-text"><strong>Причина сохранения:</strong> {attempt.reason}</p>
      <PrintCompletion completion={attempt.completion} data={data} />
      <h3>Фото предыдущей попытки</h3><PrintPhotos photos={attempt.photos} data={data} />
      <h3>Заключение предыдущей проверки</h3><PrintAssessment assessment={attempt.assessment} />
    </div>)}</section>}

    <section><h2>Полная хронология</h2>{events.length ? <table className="order-print-timeline"><thead><tr><th scope="col">Дата и автор</th><th scope="col">Действие / статус</th><th scope="col">Комментарий</th></tr></thead><tbody>{events.map(event => <tr key={event.id}>
      <td>{stamp(event.at)}<br />{event.actorName || catalogs.users.find(user => user.id === event.actorId)?.name || event.actorId || 'Система'}</td>
      <td>{event.action}{event.toStatus && <span className="order-print-transition">{event.fromStatus ? `${STATUS_LABELS[event.fromStatus]} → ` : ''}{STATUS_LABELS[event.toStatus]}</span>}</td>
      <td className="order-print-text">{event.comment || '—'}</td>
    </tr>)}</tbody></table> : <p>События не зарегистрированы.</p>}</section>

    <footer className="order-print-footer">НарядAI · Версия наряда {order.version} · Сформировано {stamp(new Date().toISOString())}<br />Время в отчёте: {TIME_ZONE}. Учебный стенд · Qostanai Industry Hackathon 2026.</footer>
  </article>;
}
