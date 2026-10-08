import { t } from './i18n';
import { useEffect, useState } from 'react';
import { Download, QrCode } from 'lucide-react';
import type { Equipment } from './types';
import './equipment-qr.css';

export function EquipmentQR({ equipment }: { equipment: Equipment }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const target = new URL(`/?equipment=${encodeURIComponent(equipment.id)}`, location.origin).href;
  useEffect(() => {
    let disposed = false;
    setUrl(''); setError('');
    import('qrcode').then(qr => qr.toDataURL(target, { width: 360, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#163c2b', light: '#ffffff' } }))
      .then(value => { if (!disposed) setUrl(value); }).catch(() => { if (!disposed) setError('Не удалось создать QR-код'); });
    return () => { disposed = true; };
  }, [target]);
  return <section className="equipment-qr" aria-label={t("QR-код оборудования")}>
    <div className="equipment-qr-image">{url ? <img src={url} alt={t("QR-код: {v0}", { v0: equipment.inventory })} /> : <QrCode size={64} />}</div>
    <div><h3>{t("Карточка по QR-коду")}</h3><p>{t("Отсканируйте камерой телефона: откроются оборудование, история ремонтов и выдача наряда.")}</p><code>{equipment.inventory}</code>
      {url && <a className="button secondary" href={url} download={`QR-${equipment.inventory}.png`}><Download size={16} />{t("Скачать QR-код")}</a>}
      <small className="qr-target">{target}</small>
      {['localhost','127.0.0.1'].includes(location.hostname) && <small>{t("Для телефона откройте систему по сетевому или публичному адресу и скачайте QR-код оттуда.")}</small>}
      {error && <p role="alert">{t(error)}</p>}
    </div>
  </section>;
}
