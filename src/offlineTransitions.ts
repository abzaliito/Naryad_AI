import { api, ApiError } from './api';
import type { BootstrapResponse, Order, OrderStatus } from './types';

export interface QueuedTransition {
  ownerId: string; orderId: string; requestId: string; queuedAt: string;
  fromStatus?: OrderStatus; status: 'queued' | 'conflict'; error?: string;
  body: { status: OrderStatus; reason: string; version: number; requestId: string; ownerId: string; recordedAt?: string };
}
interface Outbox { items: QueuedTransition[]; confirmed: Order[] }
export interface TransitionSyncResult { sent: number; blocked: number; pending: number; auth: boolean }
const key = (ownerId: string) => `naryad-transitions-v2:${ownerId}`;
const locks = new Map<string, Promise<unknown>>();

export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const outboxChanged = () => window.dispatchEvent(new Event('naryad-outbox-change'));

/** Status replay, photo uploads and completion use the SAME lock in every tab. */
export async function withOutboxLock<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
  if (navigator.locks) return await navigator.locks.request(`naryad-outbox:${ownerId}`, work);
  // HTTP LAN browsers without Web Locks still serialize within this page; request IDs
  // protect the server from duplicated delivery by another tab.
  const previous = locks.get(ownerId) || Promise.resolve();
  const job = previous.catch(() => undefined).then(work);
  locks.set(ownerId, job);
  void job.finally(() => { if (locks.get(ownerId) === job) locks.delete(ownerId); }).catch(() => undefined);
  return job;
}

function read(ownerId: string): Outbox {
  try {
    const raw = localStorage.getItem(key(ownerId));
    if (raw) {
      const value = JSON.parse(raw) as Outbox;
      if (!Array.isArray(value.items) || !Array.isArray(value.confirmed) || value.items.some(item => item.ownerId !== ownerId || !item.orderId || !item.requestId || !Number.isInteger(item.body?.version))) throw new Error();
      return value;
    }
    const legacy = JSON.parse(localStorage.getItem(`naryad-pending-${ownerId}`) || '[]') as { path: string; body: {status: OrderStatus; reason?: string; version: number} }[];
    if (!Array.isArray(legacy)) throw new Error();
    const items = legacy.map(item => {
      const match = /^\/orders\/([^/]+)\/transition$/.exec(item.path);
      if (!match || !Number.isInteger(item.body?.version)) throw new Error();
      const requestId = newRequestId();
      return { ownerId, orderId: decodeURIComponent(match[1]), requestId, queuedAt: new Date().toISOString(), status: 'queued' as const, body: { ...item.body, reason: item.body.reason || '', requestId, ownerId } };
    });
    const value = { items, confirmed: [] };
    if (items.length) { write(ownerId, value); localStorage.removeItem(`naryad-pending-${ownerId}`); }
    return value;
  } catch { throw new Error('Не удалось прочитать локальную очередь. Сохранённые действия не удалены.'); }
}

function write(ownerId: string, value: Outbox) {
  try { localStorage.setItem(key(ownerId), JSON.stringify(value)); }
  catch { throw new Error('Не удалось сохранить действие на устройстве. Освободите место и повторите.'); }
}

export const listTransitions = (ownerId: string) => read(ownerId).items;

/** Caller holds the outbox lock; preserve acknowledgements even if the next
 * bootstrap refresh fails or the device immediately loses its connection. */
export function rememberConfirmedOrder(ownerId: string, order: Order): void {
  const state = read(ownerId), existing = state.confirmed.find(value => value.id === order.id);
  if (existing && existing.version > order.version) return;
  state.confirmed = [...state.confirmed.filter(value => value.id !== order.id), order].slice(-50);
  write(ownerId, state);
}

/** Always derive the view from the SERVER snapshot, never cache projected versions. */
export function projectTransitions(snapshot: BootstrapResponse): BootstrapResponse {
  const state = read(snapshot.user.id);
  const queueSequence = Math.max(0, ...snapshot.orders.map(order => order.queueSequence || 0));
  if (!state.items.length && !state.confirmed.length) return snapshot;
  return { ...snapshot, orders: snapshot.orders.map(original => {
    const receipt = state.confirmed.find(order => order.id === original.id);
    let order = receipt && receipt.version > original.version && receipt.assigneeId === original.assigneeId ? receipt : original;
    const chain = state.items.filter(item => item.orderId === order.id);
    if (chain.some(item => item.status === 'conflict')) return order;
    for (const item of chain) {
      if (order.version !== item.body.version || (item.fromStatus && order.status !== item.fromStatus)) continue;
      order = { ...order, status: item.body.status, version: order.version + 1,
        ...(item.body.status === 'in_progress' && !order.startedAt ? { startedAt: item.queuedAt } : {}),
        ...(item.body.status === 'queued' ? { queuedAt: item.queuedAt, queueSequence: queueSequence + state.items.indexOf(item) + 1 } : {}) };
    }
    return order;
  }) };
}

export async function queueTransition(ownerId: string, order: Order, status: OrderStatus, reason = ''): Promise<void> {
  await withOutboxLock(ownerId, async () => {
    const state = read(ownerId), chain = state.items.filter(item => item.orderId === order.id);
    if (chain.some(item => item.status === 'conflict')) throw new Error('Сначала сверьте конфликт сохранённых действий с текущим нарядом.');
    const last = chain.at(-1);
    if (last && (last.body.version + 1 !== order.version || last.body.status !== order.status)) throw new Error('Действие уже изменено в другой вкладке. Обновите карточку наряда.');
    const requestId = newRequestId(), queuedAt = new Date().toISOString();
    state.items.push({ ownerId, orderId: order.id, requestId, queuedAt, fromStatus: order.status, status: 'queued', body: { status, reason, version: order.version, requestId, ownerId, recordedAt: queuedAt } });
    write(ownerId, state);
  });
  outboxChanged();
}

/** Explicit conflict resolution only: saved reports/photos are not deleted. */
export async function discardTransitions(ownerId: string, orderId: string): Promise<void> {
  await withOutboxLock(ownerId, async () => {
    const state = read(ownerId);
    state.items = state.items.filter(item => item.orderId !== orderId);
    write(ownerId, state);
  });
  outboxChanged();
}

/** Caller must hold withOutboxLock until dependent reports have also finished. */
export async function replayTransitions(ownerId: string, beforeNext?: (item: QueuedTransition) => Promise<boolean>): Promise<TransitionSyncResult> {
  let sent = 0, auth = false;
  for (const queued of read(ownerId).items) {
    if (!navigator.onLine) break;
    const current = read(ownerId), item = current.items.find(value => value.requestId === queued.requestId);
    if (!item || item.status === 'conflict' || current.items.some(value => value.orderId === item.orderId && value.status === 'conflict')) continue;
    if (beforeNext && !await beforeNext(item)) break;
    try {
      const session = await api<{ user: { id: string } }>('/auth/me');
      if (session.user.id !== ownerId) { auth = true; break; }
      const order = await api<Order>(`/orders/${encodeURIComponent(item.orderId)}/transition`, item.body);
      const latest = read(ownerId);
      latest.items = latest.items.filter(value => value.requestId !== item.requestId);
      latest.confirmed = [...latest.confirmed.filter(value => value.id !== order.id), order].slice(-50);
      write(ownerId, latest);
      sent += 1;
      outboxChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { auth = true; break; }
      if (error instanceof ApiError && error.status === 403) {
        const session = await api<{ user: { id: string } }>('/auth/me').catch(() => null);
        if (!session || session.user.id !== ownerId) { auth = true; break; }
      }
      const latest = read(ownerId), existing = latest.items.find(value => value.requestId === item.requestId);
      if (!existing) continue;
      existing.error = error instanceof Error ? error.message : 'Не удалось отправить действие.';
      const conflict = error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408,429].includes(error.status);
      if (conflict) for (const value of latest.items.filter(value => value.orderId === item.orderId)) { value.status = 'conflict'; value.error = existing.error; }
      write(ownerId, latest); if (conflict) outboxChanged();
      if (!conflict) break;
    }
  }
  const remaining = read(ownerId).items;
  return { sent, blocked: remaining.filter(item => item.status === 'conflict').length, pending: remaining.length, auth };
}
