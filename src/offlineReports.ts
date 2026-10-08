import { api, ApiError, compressImage } from './api';
import type { MaterialUsage, Photo } from './types';

export interface OfflinePhoto { blob: Blob; name: string; capturedAt: string; lastModified: number }
export interface ReportDraft {
  works: string; faultId: string; materials: MaterialUsage[]; materialsConfirmed: boolean
  comment: string; version: number; photos: OfflinePhoto[]
}
export interface QueuedReport {
  key: string; ownerId: string; orderId: string; requestId: string; queuedAt: string
  draft: ReportDraft; uploadedPhotoIds: string[]; status: 'queued' | 'conflict'; error?: string
}
export interface ReportSyncUpdate { kind: 'sent' | 'conflict' | 'pending' | 'auth'; orderId: string; message?: string }
export interface ReportSyncResult { sent: number; blocked: number; pending: number }
interface StoredDraft { key: string; ownerId: string; orderId: string; updatedAt: string; draft: ReportDraft }

const DB_NAME = 'naryad-offline-reports';
let database: Promise<IDBDatabase> | undefined;
const syncs = new Map<string, Promise<ReportSyncResult>>();
const recordKey = (ownerId: string, orderId: string) => JSON.stringify([ownerId, orderId]);
const requestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure origin; getRandomValues also works on a LAN HTTP demo.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function db(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('Браузер не поддерживает сохранение отчётов на устройстве.'));
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        for (const name of ['drafts', 'reports']) {
          const store = open.result.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('ownerId', 'ownerId');
        }
      };
      open.onsuccess = () => {
        const connection = open.result;
        connection.onversionchange = () => { connection.close(); database = undefined; };
        resolve(connection);
      };
      open.onerror = () => { database = undefined; reject(new Error('Не удалось открыть локальное хранилище. Проверьте свободное место и разрешения браузера.')); };
      open.onblocked = () => { database = undefined; reject(new Error('Закройте другие вкладки приложения и повторите сохранение отчёта.')); };
    });
  }
  return database;
}

async function readRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error || new Error('Не удалось прочитать сохранённый отчёт.'));
  });
}

async function writeRecord(storeName: string, value: StoredDraft | QueuedReport): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Не удалось сохранить отчёт на устройстве. Проверьте свободное место.'));
    transaction.onabort = () => reject(new Error('Сохранение прервано. Оставьте форму открытой и повторите действие.'));
  });
}

async function removeRecord(storeName: string, ownerId: string, orderId: string): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(recordKey(ownerId, orderId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Не удалось обновить локальное хранилище.'));
  });
}

export function photoFromFile(file: File): OfflinePhoto {
  const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : Date.now();
  return { blob: file, name: file.name, capturedAt: new Date(lastModified).toISOString(), lastModified };
}
export function fileFromPhoto(photo: OfflinePhoto): File {
  return new File([photo.blob], photo.name, { type: photo.blob.type, lastModified: photo.lastModified });
}
export async function saveDraft(ownerId: string, orderId: string, draft: ReportDraft): Promise<void> {
  if (!ownerId || !orderId) throw new Error('Не определён владелец отчёта. Войдите снова.');
  await writeRecord('drafts', { key: recordKey(ownerId, orderId), ownerId, orderId, updatedAt: new Date().toISOString(), draft });
}
export async function loadDraft(ownerId: string, orderId: string): Promise<ReportDraft | null> {
  return (await readRecord<StoredDraft>('drafts', recordKey(ownerId, orderId)))?.draft || null;
}
export async function removeDraft(ownerId: string, orderId: string): Promise<void> {
  await removeRecord('drafts', ownerId, orderId);
}

/** The complete report and original image blobs are committed in one IndexedDB transaction. */
export async function queueReport(ownerId: string, orderId: string, draft: ReportDraft): Promise<QueuedReport> {
  if (!ownerId || !orderId || !Number.isInteger(draft.version) || draft.version < 1) throw new Error('Обновите карточку перед отправкой отчёта.');
  if (draft.photos.length > 5) throw new Error('Можно приложить не более 5 фотографий.');
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(['drafts', 'reports'], 'readwrite');
    const key = recordKey(ownerId, orderId), reports = transaction.objectStore('reports');
    const request = reports.get(key);
    let value: QueuedReport, duplicate = false;
    request.onsuccess = () => {
      if (request.result) { duplicate = true; transaction.abort(); return; }
      value = { key, ownerId, orderId, requestId: requestId(), queuedAt: new Date().toISOString(), draft, uploadedPhotoIds: [], status: 'queued' };
      reports.put(value);
      transaction.objectStore('drafts').put({ key, ownerId, orderId, updatedAt: value.queuedAt, draft } satisfies StoredDraft);
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(new Error('Отчёт не сохранён. Проверьте свободное место на устройстве.'));
    transaction.onabort = () => reject(new Error(duplicate ? 'Этот отчёт уже ожидает отправки. Проверьте очередь перед повторной отправкой.' : 'Сохранение отчёта прервано. Повторите действие.'));
  });
}

export async function listQueued(ownerId: string): Promise<QueuedReport[]> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction('reports', 'readonly');
    const request = transaction.objectStore('reports').index('ownerId').getAll(ownerId);
    request.onsuccess = () => resolve((request.result as QueuedReport[]).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)));
    request.onerror = () => reject(request.error || new Error('Не удалось прочитать очередь отчётов.'));
  });
}

/** An explicit user decision after a version conflict; the editable draft and photos are retained. */
export async function discardQueuedReport(ownerId: string, orderId: string): Promise<void> {
  await removeRecord('reports', ownerId, orderId);
}

async function finishReport(item: QueuedReport): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(['drafts', 'reports'], 'readwrite');
    transaction.objectStore('reports').delete(item.key);
    const drafts = transaction.objectStore('drafts'), request = drafts.get(item.key);
    request.onsuccess = () => {
      const draft = request.result as StoredDraft | undefined;
      // Never discard edits made after the user queued this particular copy.
      if (draft && draft.updatedAt <= item.queuedAt) drafts.delete(item.key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Не удалось подтвердить отправку в локальной очереди.'));
    transaction.onabort = () => reject(new Error('Обновление очереди прервано. Повторная отправка защищена от дублирования.'));
  });
}

async function synchronize(ownerId: string, onUpdate?: (update: ReportSyncUpdate) => void): Promise<ReportSyncResult> {
  const queued = await listQueued(ownerId);
  let sent = 0;
  const emit = (update: ReportSyncUpdate) => { try { onUpdate?.(update); } catch { /* UI failures must not replay a sent report. */ } };
  for (const item of queued) {
    if (!navigator.onLine) break;
    if (item.status === 'conflict') continue;
    try {
      const session = await api<{ user: { id: string } }>('/auth/me');
      if (session.user.id !== ownerId) { emit({ kind: 'auth', orderId: item.orderId, message: 'Отчёт сохранён для другого аккаунта. Войдите под его автором.' }); break; }
      for (let index = item.uploadedPhotoIds.length; index < item.draft.photos.length; index += 1) {
        const photo = item.draft.photos[index], form = new FormData();
        form.append('photos', await compressImage(fileFromPhoto(photo)));
        form.append('kind', 'after'); form.append('orderId', item.orderId);
        form.append('capturedAt', photo.capturedAt);
        form.append('requestId', `${item.requestId}:${index}`);
        const response = await api<{ photos: Photo[] }>('/uploads', form);
        if (response.photos.length !== 1 || !response.photos[0].id) throw new Error('Сервер не подтвердил загрузку фотографии.');
        item.uploadedPhotoIds.push(response.photos[0].id);
        delete item.error;
        // A retry starts at the next photo; requestId also protects a lost upload response.
        await writeRecord('reports', item);
      }
      const { photos: _photos, ...report } = item.draft;
      await api(`/orders/${encodeURIComponent(item.orderId)}/complete`, { ...report, requestId: item.requestId, photoIds: item.uploadedPhotoIds });
      await finishReport(item);
      sent += 1;
      emit({ kind: 'sent', orderId: item.orderId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось отправить отчёт.';
      if (error instanceof ApiError && error.status === 401) { emit({ kind: 'auth', orderId: item.orderId, message: 'Войдите в систему, чтобы отправить сохранённый отчёт.' }); break; }
      item.error = message;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        item.status = 'conflict';
        await writeRecord('reports', item);
        emit({ kind: 'conflict', orderId: item.orderId, message });
      } else {
        await writeRecord('reports', item);
        emit({ kind: 'pending', orderId: item.orderId, message });
        break;
      }
    }
  }
  const remaining = await listQueued(ownerId);
  return { sent, blocked: remaining.filter(item => item.status === 'conflict').length, pending: remaining.length };
}

/** Call on connection restoration and session restore. Web Locks serialize replay across tabs. */
export function syncQueuedReports(ownerId: string, onUpdate?: (update: ReportSyncUpdate) => void): Promise<ReportSyncResult> {
  const running = syncs.get(ownerId);
  if (running) return running;
  const job = (async () => navigator.locks
    ? await navigator.locks.request(`naryad-report-sync:${ownerId}`, () => synchronize(ownerId, onUpdate))
    : await synchronize(ownerId, onUpdate))().finally(() => syncs.delete(ownerId));
  syncs.set(ownerId, job);
  return job;
}
