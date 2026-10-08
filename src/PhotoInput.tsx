import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Check, EyeOff, Loader2, Undo2, Upload, X } from 'lucide-react';
import { t } from './i18n';
import './photo-input.css';

type Point = { x: number; y: number };
type Mask = Point & { width: number; height: number };

function PhotoRedactor({ file, onSave, onCancel }: { file: File; onSave: (file: File) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLCanvasElement | null>(null);
  const start = useRef<Point | null>(null);
  const [masks, setMasks] = useState<Mask[]>([]);
  const [selection, setSelection] = useState<Mask | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setReady(false); setMasks([]); setSelection(null); setError('');
    createImageBitmap(file).then(bitmap => {
      if (!active) { bitmap.close(); return; }
      const original = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      original.width = Math.round(bitmap.width * scale);
      original.height = Math.round(bitmap.height * scale);
      original.getContext('2d')!.drawImage(bitmap, 0, 0, original.width, original.height);
      bitmap.close();
      source.current = original;
      setReady(true);
    }).catch(() => { if (active) setError(t('Не удалось открыть фото. Выберите JPEG или PNG.')); });
    return () => { active = false; source.current = null; };
  }, [file]);

  useEffect(() => {
    const target = canvas.current, original = source.current;
    if (!target || !original || !ready) return;
    target.width = original.width;
    target.height = original.height;
    const context = target.getContext('2d')!;
    context.drawImage(original, 0, 0);
    context.fillStyle = '#111111';
    for (const mask of masks) context.fillRect(mask.x, mask.y, mask.width, mask.height);
    if (selection) {
      context.fillStyle = '#111111bb';
      context.fillRect(selection.x, selection.y, selection.width, selection.height);
      context.strokeStyle = '#ffffff';
      context.lineWidth = 3;
      context.strokeRect(selection.x, selection.y, selection.width, selection.height);
    }
  }, [ready, masks, selection]);

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const target = event.currentTarget, rect = target.getBoundingClientRect();
    return { x: Math.max(0, Math.min(target.width, (event.clientX - rect.left) * target.width / rect.width)), y: Math.max(0, Math.min(target.height, (event.clientY - rect.top) * target.height / rect.height)) };
  }
  function rectangle(end: Point): Mask | null {
    const from = start.current;
    return from ? { x: Math.floor(Math.min(from.x, end.x)), y: Math.floor(Math.min(from.y, end.y)), width: Math.ceil(Math.abs(end.x - from.x)), height: Math.ceil(Math.abs(end.y - from.y)) } : null;
  }
  function finish(event: PointerEvent<HTMLCanvasElement>) {
    const mask = rectangle(point(event));
    start.current = null;
    setSelection(null);
    if (mask && mask.width >= 3 && mask.height >= 3) setMasks(previous => [...previous, mask]);
  }
  async function save() {
    const original = source.current;
    if (!original || !masks.length) return;
    setBusy(true);
    try {
      // Export only the flattened, opaque masks; the original pixels never leave the device.
      const output = document.createElement('canvas');
      output.width = original.width; output.height = original.height;
      const context = output.getContext('2d')!;
      context.drawImage(original, 0, 0);
      context.fillStyle = '#111111';
      masks.forEach(mask => context.fillRect(mask.x, mask.y, mask.width, mask.height));
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error()), 'image/jpeg', 0.9));
      onSave(new File([blob], 'photo-redacted.jpg', { type: 'image/jpeg', lastModified: file.lastModified }));
    } catch { setError(t('Не удалось сохранить фото. Повторите попытку.')); setBusy(false); }
  }

  return <section className="photo-redactor" aria-label={t('Скрыть личные данные на фото')}>
    <div className="photo-redactor-heading"><EyeOff size={20}/><strong>{t('Скрыть личные данные на фото')}</strong></div>
    <p>{t('Обведите лица, бейджи или документы пальцем. Выделенные области закрасятся перед загрузкой.')}</p>
    {error && <p role="alert">{error}</p>}
    {!ready && !error && <Loader2 className="spin" size={22}/>}
    <canvas ref={canvas} hidden={!ready} aria-label={t('Выделите область на фото')} onPointerDown={event => {
      if (busy || !ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event);
    }} onPointerMove={event => { if (start.current) setSelection(rectangle(point(event))); }} onPointerUp={finish} onPointerCancel={() => { start.current = null; setSelection(null); }}/>
    <div className="photo-redactor-actions">
      <button type="button" className="button secondary" disabled={!masks.length || busy} onClick={() => setMasks(previous => previous.slice(0, -1))}><Undo2 size={16}/>{t('Отменить выделение')}</button>
      <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>{t('Отмена')}</button>
      <button type="button" className="button primary" disabled={!ready || !masks.length || busy} onClick={save}>{busy ? <Loader2 className="spin" size={16}/> : <Check size={16}/>} {t('Сохранить фото')}</button>
    </div>
  </section>;
}

export function PhotoInput({ files, setFiles, kind }: { files: File[]; setFiles: (files: File[]) => void; kind: string }) {
  const container = useRef<HTMLDivElement>(null);
  const previews = useMemo(() => files.map(file => URL.createObjectURL(file)), [files]);
  const [editing, setEditing] = useState<File | null>(null);
  const [submitBlocked, setSubmitBlocked] = useState(false);
  useEffect(() => () => previews.forEach(URL.revokeObjectURL), [previews]);
  useEffect(() => {
    setSubmitBlocked(false);
    if (!editing) return;
    const form = container.current?.closest('form');
    const block = (event: Event) => {
      event.preventDefault(); event.stopImmediatePropagation(); setSubmitBlocked(true);
      container.current?.scrollIntoView({ block: 'nearest' });
    };
    // Never submit the original file while a mask is still an unsaved preview.
    form?.addEventListener('submit', block, true);
    return () => form?.removeEventListener('submit', block, true);
  }, [editing]);
  return <div className="photo-input" ref={container}>
    <label className="upload-zone"><Upload size={22}/><strong>{t('Добавить фото')} {t(kind)}</strong><span>{t('Камера или галерея · до 5 фото · сжатие автоматически')}</span><input type="file" accept="image/*" multiple onChange={event => { setFiles([...files, ...Array.from(event.target.files || [])].slice(0, 5)); event.target.value = ''; }}/></label>
    {files.length > 0 && <><p className="photo-privacy-hint">{t('Перед отправкой скройте лица, бейджи и личные данные, если они попали в кадр.')}</p><div className="photo-previews photo-input-previews">{previews.map((url, index) => <div className="photo-input-preview" key={url}>
      <img src={url} alt={t('Фото {v0}', { v0: index + 1 })}/>
      <button type="button" className="photo-remove" aria-label={t('Удалить фото {v0}', { v0: index + 1 })} onClick={() => { if (editing === files[index]) setEditing(null); setFiles(files.filter((_, other) => index !== other)); }}><X size={18}/></button>
      <button type="button" className="photo-redact" aria-label={t('Скрыть данные на фото {v0}', { v0: index + 1 })} onClick={() => setEditing(files[index])}><EyeOff size={16}/>{t('Скрыть данные')}</button>
    </div>)}</div></>}
    {editing && <PhotoRedactor key={`${editing.name}:${editing.lastModified}`} file={editing} onCancel={() => setEditing(null)} onSave={replacement => { setFiles(files.map(file => file === editing ? replacement : file)); setEditing(null); }}/>}
    {submitBlocked && <p className="photo-privacy-hint" role="alert">{t('Сначала сохраните фото или отмените редактирование.')}</p>}
  </div>;
}
