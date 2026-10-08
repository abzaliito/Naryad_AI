import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { BootstrapResponse, Order } from '../src/types';

async function login(page: Page, account = 'master') {
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(account);
  await page.getByLabel('ПИН-код', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'Войти в систему' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function getOrder(page: Page, id: string) {
  const response = await page.request.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  return data.orders.find((order: { id: string }) => order.id === id);
}

async function createOrder(page: Page, planned = false) {
  await page.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Выдать новый наряд' });
  await form.getByRole('button', { name: planned ? 'Плановое ТО' : 'Замена подшипника', exact: true }).click();
  await form.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption('usr-worker-1');
  const created = page.waitForResponse(response => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const order = await response.json();
  await expect(form).not.toBeVisible();
  return order;
}

async function completeOrder(page: Page, id: string, planned = false) {
  await page.goto(`/?order=${id}`);
  const detail = page.getByRole('dialog', { name: /^Наряд №/ });
  await detail.getByRole('button', { name: 'Принять в работу', exact: true }).click();
  await detail.getByRole('button', { name: 'Начать исполнение', exact: true }).click();
  await expect.poll(async () => (await getOrder(page, id))?.status).toBe('in_progress');
  await detail.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true }).click();
  const report = page.getByRole('dialog', { name: /^Отчёт об исполнении/ });
  if (planned) {
    // Escape must dismiss only the top dialog and restore focus to its opener.
    await expect(report).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(report).not.toBeVisible();
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await detail.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true }).click();
  }
  await report.getByLabel(/^Выполненные работы/).fill(planned
    ? 'Выполнены осмотр, очистка и проверка соединений. При контрольном включении отклонений не обнаружено. Учебная запись автоматического теста.'
    : 'Заменён подшипниковый узел привода, выполнены центровка и пробный пуск. Повышенный нагрев отсутствует. Учебная запись автоматического теста.');
  await report.getByRole('combobox', { name: 'Шифр неисправности', exact: true }).selectOption(planned ? 'fault-inspection' : 'fault-bearing');
  await report.getByLabel('Материалы не использовались', { exact: true }).check();
  if (!planned) await expect(report.getByText('Отчёт без фото будет отправлен на доработку.', { exact: false })).toBeVisible();
  await report.getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
  await expect(report).not.toBeVisible();
}

test('мастер видит рабочую смену, учебный архив и уведомления', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Всё о смене. В одном месте.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Динамика нарядов' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выдать наряд', exact: true })).toBeVisible();
  const response = await page.request.get('/api/bootstrap');
  const data = await response.json();
  expect(data.orders.length).toBeGreaterThanOrEqual(600);
  const activeCount = data.orders.filter((order: Order) => !['closed', 'cancelled'].includes(order.status)).length;
  const reviewingCount = data.orders.filter((order: Order) => order.status === 'ai_review').length;
  expect(await page.locator('.stat-card').nth(0).locator('.stat-value').evaluate(element => Number(element.firstChild?.textContent?.trim()))).toBe(activeCount);
  expect(await page.locator('.stat-card').nth(1).locator('.stat-value').evaluate(element => Number(element.firstChild?.textContent?.trim()))).toBe(reviewingCount);
  expect(data.catalogs.equipment.length).toBeGreaterThanOrEqual(25);
  expect(data.catalogs.users.filter((user: { role: string }) => user.role === 'worker')).toHaveLength(15);
  expect(data.settings.aiProvider).toBe('demo-rules');
  await screenshot(page, testInfo, 'desktop-dashboard.png');

  await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
  await expect(page.locator('.notification-panel')).toBeVisible();
  const beforeRead = await (await page.request.get('/api/bootstrap')).json();
  const notificationIds = new Set(beforeRead.notifications.map((item: { id: string }) => item.id));
  const marked = page.waitForResponse(response => response.url().endsWith('/api/notifications/read') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Прочитать все' }).click();
  expect((await marked).ok()).toBeTruthy();
  await expect.poll(async () => {
    const data = await (await page.request.get('/api/bootstrap')).json();
    // The live deadline monitor may deliver a new message after the read operation.
    // Every message that already existed must be read; new arrivals remain unread.
    return data.notifications.filter((item: { id: string; read: boolean }) => notificationIds.has(item.id) && !item.read).length;
  }).toBe(0);
  await page.getByRole('button', { name: 'Закрыть уведомления' }).click();
  expect(pageErrors).toEqual([]);
});

test('мобильный экран 390 px: меню и карточка без горизонтального переполнения', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByRole('button', { name: 'Открыть меню' })).toBeVisible();
  const noHorizontalOverflow = async () => page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  let widths = await noHorizontalOverflow();
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
  await screenshot(page, testInfo, 'mobile-dashboard.png');
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  await expect(page.locator('nav').getByRole('button', { name: 'Настройки', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-bottom .nav-item')).toHaveCount(0);
  await page.locator('nav').getByRole('button', { name: /^Наряды/ }).click();
  await expect(page.getByRole('heading', { name: 'Наряды', exact: true })).toBeVisible();
  widths = await noHorizontalOverflow();
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  await page.goto('/?order=live-001');
  await expect(page.getByRole('dialog')).toBeVisible();
  widths = await noHorizontalOverflow();
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  await screenshot(page, testInfo, 'mobile-order.png');
});

test('наряд проходит исполнение и обязательную проверку; отсутствие фото возвращает на доработку', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  const order = await createOrder(page);
  expect(order.status).toBe('issued');
  expect(order.type).toBe('unplanned');
  expect(order.assigneeId).toBe('usr-worker-1');
  const premature = await page.request.post(`/api/orders/${order.id}/review`, {
    data: { decision: 'close', comment: 'Попытка преждевременного закрытия в автоматическом тесте.' },
  });
  expect(premature.status()).toBe(409);

  const worker = await browser.newPage({ baseURL, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda' });
  try {
    await login(worker, 'worker');
    const bootstrap = await (await worker.request.get('/api/bootstrap')).json();
    expect(bootstrap.notifications.some((notification: { orderId?: string }) => notification.orderId === order.id)).toBeTruthy();
    // Free the demo worker's current task through the normal UI and retain its audit trail.
    await worker.goto('/?order=live-001');
    const current = worker.getByRole('dialog', { name: /^Наряд №/ });
    await current.getByRole('button', { name: 'Приостановить', exact: true }).click();
    await current.getByLabel(/^Причина приостановки/).fill('Учебный тест: ожидаем комплект подшипников со склада.');
    await current.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await expect.poll(async () => (await getOrder(worker, 'live-001'))?.status).toBe('paused');
    await completeOrder(worker, order.id);
    await expect.poll(async () => (await getOrder(worker, order.id))?.status).toBe('rework');
    const checked = await getOrder(worker, order.id);
    expect(checked.assessment.verdict).toBe('rework');
    expect(checked.assessment.checks.some((check: { label: string; status: string }) => check.label === 'Фотоподтверждение' && check.status === 'fail')).toBeTruthy();
    expect(checked.events.map((event: { toStatus?: string }) => event.toStatus)).toEqual(expect.arrayContaining(['issued', 'accepted', 'in_progress', 'completed', 'ai_review', 'rework']));
    await worker.getByRole('button', { name: 'Проверка и отчёт' }).click();
    await expect(worker.locator('.assessment-hero.rework')).toBeVisible();
    await screenshot(worker, testInfo, 'worker-ai-rework.png');
    const blocked = await page.request.post(`/api/orders/${order.id}/review`, { data: { decision: 'close' } });
    expect(blocked.status()).toBe(409);
  } finally { await worker.close(); }
});

test('плановое обслуживание без расхода ТМЦ проходит проверку и закрывается мастером', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  const order = await createOrder(page, true);
  const worker = await browser.newPage({ baseURL, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda' });
  try {
    await login(worker, 'worker');
    // This also keeps the test independently runnable with --grep.
    const current = await getOrder(worker, 'live-001');
    if (current.status === 'in_progress') {
      const paused = await worker.request.post('/api/orders/live-001/transition', {
        data: { status: 'paused', reason: 'Учебный тест: ожидание запасных частей.', version: current.version },
      });
      expect(paused.ok()).toBeTruthy();
    }
    await completeOrder(worker, order.id, true);
    // A seconds-long automated run may receive a legitimate duration remark.
    await expect.poll(async () => ['accepted', 'remarks'].includes((await getOrder(worker, order.id))?.assessment?.verdict)).toBeTruthy();
    const reviewed = await getOrder(worker, order.id);
    expect(reviewed.status).toBe('ai_review');
    expect(reviewed.completion.materials).toHaveLength(0);
    await page.goto(`/?order=${order.id}`);
    const detail = page.getByRole('dialog', { name: /^Наряд №/ });
    await detail.getByLabel('Комментарий мастера', { exact: true }).fill('Учебный тест: плановый осмотр подтверждён мастером.');
    await detail.getByRole('button', { name: 'Принять и закрыть', exact: true }).click();
    await expect.poll(async () => (await getOrder(page, order.id))?.status).toBe('closed');
    const closed = await getOrder(page, order.id);
    expect(closed.closedAt).toBeTruthy();
    expect(closed.assessment.masterComment).toContain('подтверждён мастером');
    await detail.getByRole('button', { name: 'Проверка и отчёт' }).click();
    await screenshot(page, testInfo, 'master-accepted-report.png');
    await expect.poll(async () => {
      const bootstrap = await (await worker.request.get('/api/bootstrap')).json();
      return bootstrap.notifications.some((notification: { orderId?: string; title: string }) => notification.orderId === order.id && notification.title.includes('закрыт'));
    }).toBeTruthy();
    // The printout contains the complete saved report regardless of the active tab.
    await detail.getByRole('button', { name: 'Карточка', exact: true }).click();
    await page.emulateMedia({ media: 'print' });
    const printed = page.getByRole('article', { name: `Полный отчёт по наряду №${order.number}`, exact: true });
    await expect(printed).toBeVisible();
    await expect(detail.locator('.detail-content')).not.toBeVisible();
    await expect(printed.getByRole('heading', { name: 'Текущий отчёт об исполнении', exact: true })).toBeVisible();
    await expect(printed.getByRole('heading', { name: 'Проверка и оценка качества', exact: true })).toBeVisible();
    await expect(printed.getByRole('heading', { name: 'Фотографии до и после', exact: true })).toBeVisible();
    await expect(printed.locator('.order-print-timeline tbody tr')).toHaveCount(closed.events.length);
    await expect(printed).toContainText(closed.completion.works);
    await expect(printed).toContainText(closed.assessment.masterComment);
    await screenshot(page, testInfo, 'complete-order-print.png');
    const pdf = testInfo.outputPath('complete-order.pdf');
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
    expect((await readFile(pdf)).subarray(0, 4).toString()).toBe('%PDF');
    await testInfo.attach('complete-order.pdf', { path: pdf, contentType: 'application/pdf' });
    await page.emulateMedia({ media: 'screen' });
  } finally { await worker.close(); }
});

test('аналитика показывает рассчитанные аномалии и выгружает настоящий Excel', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  await page.locator('nav').getByRole('button', { name: 'Аналитика и отчёты', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Аналитика и отчёты', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Плановые и внеплановые работы' })).toBeVisible();
  await screenshot(page, testInfo, 'analytics-overview.png');
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать Excel', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
  const exported = testInfo.outputPath('orders-export.xlsx');
  await download.saveAs(exported);
  const bytes = await readFile(exported);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(exported);
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
    'Наряды', 'Работы и оценка', 'История статусов', 'Рейтинг',
    'Бригады', 'Расход ТМЦ', 'ТМЦ по нарядам', 'Расчёт простоя',
  ]);
  expect(workbook.getWorksheet('Наряды')!.rowCount).toBeGreaterThan(500);
  expect(workbook.getWorksheet('Работы и оценка')!.rowCount).toBeGreaterThan(500);
  expect(workbook.getWorksheet('История статусов')!.rowCount).toBeGreaterThan(500);
  expect(workbook.getWorksheet('Рейтинг')!.rowCount).toBeGreaterThan(10);
  expect(workbook.getWorksheet('Расход ТМЦ')!.rowCount).toBeGreaterThan(20);
  expect(workbook.getWorksheet('ТМЦ по нарядам')!.rowCount).toBeGreaterThan(100);
  expect(workbook.getWorksheet('Расчёт простоя')!.rowCount).toBeGreaterThan(20);
  await testInfo.attach('orders-export.xlsx', { path: exported, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  await page.getByRole('button', { name: /^Аномалии/ }).click();
  await expect(page.getByRole('heading', { name: /К-3: повторяется/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Масло гидравлическое.*повышенный расход/ })).toBeVisible();
  await screenshot(page, testInfo, 'analytics-anomalies.png');
  await page.getByRole('button', { name: 'Рейтинг исполнителей', exact: true }).click();
  await expect(page.getByText('Понятный рейтинг — максимум 100 баллов')).toBeVisible();
  await expect(page.locator('.rating-table tbody tr')).toHaveCount(15);
});

test('исполнитель сохраняет два офлайн-действия и видит конфликт версии после восстановления сети', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await login(page);
  const data: BootstrapResponse = await (await page.request.get('/api/bootstrap')).json();
  const equipment = data.catalogs.equipment[0];
  const orders: Order[] = [];
  for (const name of ['Первое', 'Второе', 'Конфликтующее']) {
    const created = await page.request.post('/api/orders', { data: {
      title: `${name} офлайн-задание`, description: `${name} учебное задание для проверки очереди действий без сети.`,
      siteId: equipment.siteId, equipmentId: equipment.id, assigneeId: 'usr-worker-1',
      type: 'planned', priority: 'normal', normHours: 2, dueAt: new Date(Date.now() + 7_200_000).toISOString(),
    } });
    expect(created.status()).toBe(201);
    orders.push(await created.json());
  }
  const worker = await browser.newPage({ baseURL, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda' });
  const pendingKey = 'naryad-pending-usr-worker-1';
  const pending = () => worker.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), pendingKey);
  try {
    await login(worker, 'worker');
    await expect(worker.getByRole('button', { name: 'Выдать наряд', exact: true })).toHaveCount(0);
    await worker.locator('nav').getByRole('button', { name: 'Мой рейтинг', exact: true }).click();
    await expect(worker.getByRole('link', { name: 'Скачать Excel', exact: true })).toHaveCount(0);
    await expect(worker.locator('.rating-table tbody tr')).toHaveCount(1);
    await worker.locator('nav').getByRole('button', { name: 'Моя смена', exact: true }).click();
    await worker.setViewportSize({ width: 390, height: 844 });
    await worker.getByRole('button', { name: 'Открыть меню' }).click();
    await expect(worker.locator('nav').getByRole('button', { name: 'Настройки', exact: true })).toHaveCount(0);
    await worker.getByRole('button', { name: 'Закрыть меню' }).click();
    expect(await worker.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
    await screenshot(worker, testInfo, 'mobile-worker-dashboard.png');
    await worker.setViewportSize({ width: 1440, height: 1000 });

    await worker.context().setOffline(true);
    await expect(worker.getByText('Вы без сети.', { exact: false })).toBeVisible();
    for (const [index, action] of ['Принять в работу', 'В очередь'].entries()) {
      await worker.locator('.worker-order').filter({ hasText: `Наряд №${orders[index].number}` }).getByRole('button').click();
      const detail = worker.getByRole('dialog', { name: `Наряд №${orders[index].number}`, exact: true });
      await detail.getByRole('button', { name: action, exact: true }).click();
      await expect.poll(async () => (await pending()).length).toBe(index + 1);
      await worker.keyboard.press('Escape');
    }
    await expect(worker.getByText('Ожидают отправки: 2.', { exact: true })).toBeVisible();
    expect((await getOrder(page, orders[0].id)).status).toBe('issued');
    expect((await getOrder(page, orders[1].id)).status).toBe('issued');
    await worker.context().setOffline(false);
    await expect.poll(async () => (await getOrder(page, orders[0].id)).status).toBe('accepted');
    await expect.poll(async () => (await getOrder(page, orders[1].id)).status).toBe('queued');
    await expect.poll(async () => (await pending()).length).toBe(0);

    await worker.context().setOffline(true);
    await expect(worker.getByText('Вы без сети.', { exact: false })).toBeVisible();
    await worker.locator('.worker-order').filter({ hasText: `Наряд №${orders[2].number}` }).getByRole('button').click();
    await worker.getByRole('dialog', { name: `Наряд №${orders[2].number}`, exact: true }).getByRole('button', { name: 'Принять в работу', exact: true }).click();
    await expect.poll(async () => (await pending()).length).toBe(1);
    await worker.keyboard.press('Escape');
    const changed = await page.request.patch(`/api/orders/${orders[2].id}`, { data: { priority: 'high', version: orders[2].version } });
    expect(changed.ok()).toBeTruthy();
    await worker.context().setOffline(false);
    await expect(worker.getByText('Сохранённые действия требуют сверки с текущими статусами.', { exact: true })).toBeVisible();
    expect((await getOrder(page, orders[2].id)).status).toBe('issued');
    expect(await pending()).toHaveLength(1);
    await screenshot(worker, testInfo, 'offline-conflict.png');
    await worker.getByRole('button', { name: 'Очистить локальную очередь', exact: true }).click();
    await expect.poll(async () => (await pending()).length).toBe(0);
    await expect(worker.getByText('Сохранённые действия требуют сверки с текущими статусами.', { exact: true })).not.toBeVisible();
  } finally { await worker.context().setOffline(false); await worker.close(); }
});

test('фильтры участка, оборудования, исполнителя и бригады одинаково ограничивают экран и Excel', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  const data: BootstrapResponse = await (await page.request.get('/api/bootstrap')).json();
  const equipment = data.catalogs.equipment.find(item => item.id === 'eq-k3')!;
  const worker = data.catalogs.users.find(item => item.id === 'usr-worker-1')!;
  await page.locator('nav').getByRole('button', { name: 'Аналитика и отчёты', exact: true }).click();
  await page.getByRole('combobox', { name: 'Участок отчёта', exact: true }).selectOption(equipment.siteId);
  await page.getByRole('combobox', { name: 'Оборудование отчёта', exact: true }).selectOption(equipment.id);
  await page.getByRole('combobox', { name: 'Исполнитель отчёта', exact: true }).selectOption(worker.id);
  await page.getByRole('combobox', { name: 'Бригада отчёта', exact: true }).selectOption(worker.brigadeId!);
  const exportPath = (await page.getByRole('link', { name: 'Скачать Excel', exact: true }).getAttribute('href'))!;
  const params = new URL(exportPath, 'http://localhost').searchParams;
  expect(params.get('siteId')).toBe(equipment.siteId);
  expect(params.get('equipmentId')).toBe(equipment.id);
  expect(params.get('assigneeId')).toBe(worker.id);
  expect(params.get('brigadeId')).toBe(worker.brigadeId);
  const expected = data.orders.filter(order => order.siteId === equipment.siteId && order.equipmentId === equipment.id
    && order.assigneeId === worker.id && order.brigadeId === worker.brigadeId
    && Date.parse(order.createdAt) >= Date.parse(params.get('from')!) && Date.parse(order.createdAt) < Date.parse(params.get('to')!));
  expect(expected.length).toBeGreaterThan(0);
  await expect(page.locator('.report-stat').filter({ hasText: 'Нарядов за период' }).locator('strong')).toHaveText(String(expected.length));
  const exported = await page.request.get(exportPath);
  expect(exported.ok()).toBeTruthy();
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exported.body());
  const sheet = workbook.getWorksheet('Наряды')!;
  expect(sheet.rowCount - 1).toBe(expected.length);
  const numbers: string[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    numbers.push(String(row.getCell(1).value));
    expect(row.getCell(4).value).toBe(equipment.name);
    expect(row.getCell(5).value).toBe(worker.name);
  });
  expect(numbers.sort()).toEqual(expected.map(order => order.number).sort());
  await screenshot(page, testInfo, 'analytics-filtered.png');
});

test('администратор редактирует справочник и смену сотрудника без полномочий мастера', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await login(page, 'admin');
  await expect(page.getByRole('button', { name: 'Выдать наряд', exact: true })).toHaveCount(0);
  await page.goto('/?order=live-001');
  const detail = page.getByRole('dialog', { name: /^Наряд №/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Переназначить / изменить', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Отменить наряд', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить запись', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Добавить: Участки', exact: true });
  await adding.getByRole('textbox', { name: 'Название / ФИО', exact: true }).fill('Учебный участок браузерной проверки');
  const created = page.waitForResponse(response => response.url().endsWith('/api/catalogs/sites') && response.request().method() === 'POST');
  await adding.getByRole('button', { name: 'Добавить запись', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const site = await response.json();
  await expect(adding).not.toBeVisible();
  const row = page.locator('.catalogs-panel tbody tr').filter({ hasText: site.id });
  await row.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Изменить: Участки', exact: true });
  await editing.getByRole('textbox', { name: 'Название / ФИО', exact: true }).fill('Учебный участок — обновлено');
  await editing.getByRole('button', { name: 'Сохранить запись', exact: true }).click();
  await expect(editing).not.toBeVisible();
  await expect(row).toContainText('Учебный участок — обновлено');
  await expect.poll(async () => {
    const data: BootstrapResponse = await (await page.request.get('/api/bootstrap')).json();
    return data.catalogs.sites.find(item => item.id === site.id)?.name;
  }).toBe('Учебный участок — обновлено');
  await page.locator('.catalog-tabs').getByRole('button', { name: /^Сотрудники/ }).click();
  const workerRow = page.locator('.catalogs-panel tbody tr').filter({ has: page.getByRole('cell', { name: 'usr-worker-1', exact: true }) });
  await workerRow.getByRole('button', { name: 'На смене', exact: true }).click();
  await expect(workerRow.getByRole('button', { name: 'Вне смены', exact: true })).toBeVisible();
  const changed: BootstrapResponse = await (await page.request.get('/api/bootstrap')).json();
  expect(changed.catalogs.users.find(item => item.id === 'usr-worker-1')?.onShift).toBe(false);
  await workerRow.getByRole('button', { name: 'Вне смены', exact: true }).click();
  await expect(workerRow.getByRole('button', { name: 'На смене', exact: true })).toBeVisible();
  await screenshot(page, testInfo, 'admin-catalogs.png');
});
