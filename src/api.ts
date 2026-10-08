import type { BootstrapResponse as Bootstrap } from './types';

export class ApiError extends Error {
  constructor(message:string, public status:number) { super(message); this.name='ApiError'; }
}

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({ error: 'Сервер временно недоступен' }));
    throw new ApiError(value.error || `Ошибка ${response.status}`,response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function cacheSnapshot(data: Bootstrap) {
  try { localStorage.setItem('naryad-snapshot', JSON.stringify(data)); } catch { /* Storage can be full. */ }
}
export function readSnapshot(): Bootstrap | null {
  try { return JSON.parse(localStorage.getItem('naryad-snapshot') || 'null'); } catch { return null; }
}

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Выберите изображение');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось обработать фото')), 'image/jpeg', 0.82));
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
}

export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext)
    throw new Error('Push работает через HTTPS или localhost. Откройте приложение по защищённому адресу.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Разрешите уведомления в настройках браузера');
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/push/key');
  const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(raw, c => c.charCodeAt(0));
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/push/subscribe', { subscription: subscription.toJSON() });
}
