import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

const workerId = 'usr-worker-12';
const account = 'worker12';

async function login(page: Page, login = 'master') {
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('ПИН-код', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'Войти в систему' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function stored(page: Page, store: 'drafts' | 'reports', orderId: string, ownerId = workerId) {
  return page.evaluate(async ({ store, orderId, ownerId }) => {
    if (!(await indexedDB.databases()).some(item => item.name === 'naryad-offline-reports')) return null;
    return await new Promise<any>((resolve, reject) => {
      const open = indexedDB.open('naryad-offline-reports', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const connection = open.result;
        const request = connection.transaction(store).objectStore(store).get(JSON.stringify([ownerId, orderId]));
        request.onsuccess = () => {
          const record = request.result;
          connection.close();
          resolve(record ? {
            ownerId: record.ownerId, status: record.status, error: record.error,
            requestId: record.requestId, uploadedPhotoIds: record.uploadedPhotoIds,
            works: record.draft.works, version: record.draft.version,
            photos: record.draft.photos.map((photo: { blob: Blob; capturedAt: string }) => ({ size: photo.blob.size, capturedAt: photo.capturedAt })),
          } : null);
        };
        request.onerror = () => { connection.close(); reject(request.error); };
      };
    });
  }, { store, orderId, ownerId });
}

async function getOrder(master: Page, id: string) {
  return (await (await master.request.get('/api/bootstrap')).json()).orders.find((item: { id: string }) => item.id === id);
}

async function prepare(master: Page, worker: Page, title: string) {
  const data = await (await master.request.get('/api/bootstrap')).json();
  const equipment = data.catalogs.equipment[0];
  const response = await master.request.post('/api/orders', { data: {
    title, description: `${title}: устранить неисправность и проверить оборудование.`, type: 'unplanned',
    siteId: equipment.siteId, equipmentId: equipment.id, assigneeId: workerId,
    priority: 'normal', normHours: 1, dueAt: new Date(Date.now() + 3600000).toISOString(),
  } });
  expect(response.status()).toBe(201);
  const order = await response.json();
  const current = (await (await worker.request.get('/api/bootstrap')).json()).orders;
  for (const active of current.filter((item: { status: string }) => item.status === 'in_progress')) {
    expect((await worker.request.post(`/api/orders/${active.id}/transition`, { data: { status: 'paused', reason: 'Подготовка независимого теста автономной работы', version: active.version } })).ok()).toBeTruthy();
  }
  for (const status of ['accepted', 'in_progress']) {
    const latest = await getOrder(master, order.id);
    expect((await worker.request.post(`/api/orders/${order.id}/transition`, { data: { status, version: latest.version } })).ok()).toBeTruthy();
  }
  await worker.goto(`/?order=${order.id}`);
  await expect(worker.getByRole('dialog', { name: `Наряд №${order.number}`, exact: true })).toBeVisible();
  await worker.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await worker.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true }).click();
  return order;
}

async function fillReport(worker: Page, color: string) {
  const form = worker.getByRole('dialog', { name: /^Отчёт об исполнении/ });
  const works = 'Проверен и заменён подшипник, выполнены центровка и контрольный запуск. Тест автономного отчёта с фотографией.';
  await form.getByLabel(/^Выполненные работы/).fill(works);
  await form.getByRole('combobox', { name: 'Шифр неисправности', exact: true }).selectOption('fault-bearing');
  await form.getByLabel('Материалы не использовались', { exact: true }).check();
  const bytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: color } }).png().toBuffer();
  await form.locator('input[type=file]').setInputFiles({ name: 'offline-repair.png', mimeType: 'image/png', buffer: bytes });
  await expect(form.locator('.photo-previews img')).toHaveCount(1);
  return { form, works };
}

test('офлайн-отчёт и фотография переживают перезагрузку и автоматически отправляются после восстановления сети', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  await login(page);
  const worker = await browser.newPage({ baseURL, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda' });
  try {
    await login(worker, account);
    const order = await prepare(page, worker, 'Автономный отчёт после перезагрузки');
    await worker.context().setOffline(true);
    const { works } = await fillReport(worker, '#47ad63');
    await expect.poll(async () => (await stored(worker, 'drafts', order.id))?.photos.length).toBe(1);
    const draft = await stored(worker, 'drafts', order.id);
    expect(draft.photos[0].size).toBeGreaterThan(0);
    await worker.reload();
    await expect(worker.locator('.app-shell')).toBeVisible();
    await worker.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true }).click();
    const restored = worker.getByRole('dialog', { name: /^Отчёт об исполнении/ });
    await expect(restored.getByLabel(/^Выполненные работы/)).toHaveValue(works);
    await expect(restored.locator('.photo-previews img')).toHaveCount(1);
    await restored.getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
    await expect(restored).not.toBeVisible();
    await expect.poll(async () => (await stored(worker, 'reports', order.id))?.photos.length).toBe(1);
    await worker.reload();
    expect((await stored(worker, 'reports', order.id))?.photos[0].capturedAt).toBe(draft.photos[0].capturedAt);
    expect((await getOrder(page, order.id)).status).toBe('in_progress');
    await worker.context().setOffline(false);
    await expect.poll(async () => (await getOrder(page, order.id)).completion?.works, { timeout: 25000 }).toBe(works);
    const finished = await getOrder(page, order.id);
    expect(finished.photos).toHaveLength(1);
    expect(finished.photos[0].capturedAt).toBe(draft.photos[0].capturedAt);
    expect(finished.events.filter((item: { toStatus: string }) => item.toStatus === 'completed')).toHaveLength(1);
    await expect.poll(() => stored(worker, 'reports', order.id)).toBeNull();
    await expect.poll(() => stored(worker, 'drafts', order.id)).toBeNull();
  } finally { await worker.context().setOffline(false); await worker.close(); }
});

test('сохранённый отчёт изолирован по аккаунту, а конфликт версии сохраняет фото и требует решения человека', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  await login(page);
  const worker = await browser.newPage({ baseURL, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda' });
  try {
    await login(worker, account);
    const order = await prepare(page, worker, 'Конфликт автономного отчёта');
    await worker.context().setOffline(true);
    const { form } = await fillReport(worker, '#3d87c1');
    await form.getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
    await expect.poll(async () => (await stored(worker, 'reports', order.id))?.status).toBe('queued');
    const queued = await stored(worker, 'reports', order.id);
    // A different account can use this browser, but may not replay the previous account's report.
    expect((await worker.request.post('/api/auth/login', { data: { login: 'worker11', pin: '1234' } })).ok()).toBeTruthy();
    await worker.context().setOffline(false);
    await worker.reload();
    await expect.poll(async () => (await (await worker.request.get('/api/auth/me')).json()).user.id).toBe('usr-worker-11');
    await expect(worker.locator('.app-shell')).toBeVisible();
    expect(await stored(worker, 'reports', order.id, 'usr-worker-11')).toBeNull();
    expect((await stored(worker, 'reports', order.id))?.requestId).toBe(queued.requestId);
    expect((await getOrder(page, order.id)).completion).toBeUndefined();
    const latest = await getOrder(page, order.id);
    expect((await page.request.patch(`/api/orders/${order.id}`, { data: { priority: 'high', version: latest.version } })).ok()).toBeTruthy();
    expect((await worker.request.post('/api/auth/login', { data: { login: account, pin: '1234' } })).ok()).toBeTruthy();
    await worker.reload();
    await expect.poll(async () => (await stored(worker, 'reports', order.id))?.status, { timeout: 25000 }).toBe('conflict');
    const conflict = await stored(worker, 'reports', order.id);
    expect(conflict.version).toBe(queued.version);
    expect(conflict.photos).toHaveLength(1);
    expect(conflict.uploadedPhotoIds).toHaveLength(1);
    expect(conflict.error).toMatch(/изменился|верси|обнов/i);
    expect((await stored(worker, 'drafts', order.id))?.photos).toHaveLength(1);
    expect((await getOrder(page, order.id)).status).toBe('in_progress');
    await worker.reload();
    expect((await stored(worker, 'reports', order.id))?.uploadedPhotoIds).toEqual(conflict.uploadedPhotoIds);
  } finally { await worker.context().setOffline(false); await worker.close(); }
});
