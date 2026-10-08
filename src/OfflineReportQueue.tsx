import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { discardQueuedReport, listQueued, syncQueuedReports } from './offlineReports';
import type { QueuedReport } from './offlineReports';
import type { Order } from './types';

export const outboxChanged = () => window.dispatchEvent(new Event('naryad-outbox-change'));

export function OfflineReportQueue({ ownerId, online, orders, refresh, open, notify }: { ownerId: string; online: boolean; orders: Order[]; refresh: () => Promise<void>; open: (id: string) => void; notify: (s: string, error?: boolean) => void }) {
  const [queued, setQueued] = useState<QueuedReport[]>([]), [generation, setGeneration] = useState(0), [error, setError] = useState('');
  const currentOwner = useRef(ownerId); currentOwner.current = ownerId;
  useEffect(() => {
    const changed = () => setGeneration(value => value + 1);
    window.addEventListener('naryad-outbox-change', changed);
    const interval = setInterval(changed, 30_000);
    return () => { window.removeEventListener('naryad-outbox-change', changed); clearInterval(interval); };
  }, []);
  useEffect(() => {
    let active = true;
    const current = () => active && currentOwner.current === ownerId;
    (async () => {
      const initial = await listQueued(ownerId);
      if (current()) { setQueued(initial); setError(''); }
      if (online && initial.length) {
        const result = await syncQueuedReports(ownerId);
        if (!current()) return;
        setQueued(await listQueued(ownerId));
        if (result.sent) { await refresh(); notify(t("Отчёты синхронизированы: {v0}", { v0: result.sent })); }
      }
    })().catch(e => { if (current()) setError((e as Error).message); });
    return () => { active = false; };
  }, [ownerId, online, generation, notify, refresh]);
  if (!queued.length && !error) return null;
  return <section className="report-outbox" aria-label={t("Очередь отчётов")}>
    <strong><Clock3 size={18} />{t("Отчёты на устройстве:")} {queued.length}</strong>
    {error && <p role="alert">{t(error)}</p>}
    {queued.map(item => <div className="report-outbox-item" key={item.key}><div><b>№{orders.find(order => order.id === item.orderId)?.number || item.orderId}</b><span>{item.status === 'conflict' ? t('Требуется сверка с текущим нарядом') : online ? t('Отправляется при доступности сервера') : t('Отправим после подключения')}</span>{item.error && <small>{item.error}</small>}<small>{t("Фото сохранено:")} {item.draft.photos.length}</small></div><button className="text-button" onClick={() => open(item.orderId)}>{t("Открыть наряд")}</button>{item.status === 'conflict' && <button className="button secondary" onClick={async () => { try { await discardQueuedReport(ownerId,item.orderId); outboxChanged(); await refresh(); open(item.orderId); notify('Отчёт возвращён в черновик. Сверьте изменения перед повторной отправкой.'); } catch (e) { notify((e as Error).message,true); } }}>{t("Вернуть в черновик")}</button>}</div>)}
  </section>;
}
