import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, account = 'master') {
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(account);
  await page.getByLabel('ПИН-код', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'Войти в систему' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

test('общий журнал: реальные изменения, фильтр и переход к наряду', async ({ page }) => {
  await login(page);
  const bootstrap = await (await page.request.get('/api/bootstrap')).json();
  const equipment = bootstrap.catalogs.equipment[0];
  const response = await page.request.post('/api/orders', { data: { description: 'Проверить подшипник оборудования для проверки журнала', type: 'planned', priority: 'normal', siteId: equipment.siteId, equipmentId: equipment.id, assigneeId: 'usr-worker-12', normHours: 2, dueAt: new Date(Date.now() + 3_600_000).toISOString() } });
  expect(response.status()).toBe(201);
  const order = await response.json();
  expect((await page.request.patch(`/api/orders/${order.id}`, { data: { priority: 'high', version: order.version } })).ok()).toBeTruthy();
  await page.locator('#primary-navigation').getByRole('button', { name: 'Журнал действий' }).click();
  await expect(page.getByRole('heading', { name: 'Журнал действий', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск по журналу' }).fill(order.number);
  await expect(page.locator('.activity-log')).toContainText('Обычный → Высокий');
  await expect(page.locator('.activity-log')).toContainText(bootstrap.user.name);
  await page.locator('.activity-order-link:visible').first().click();
  const dialog = page.getByRole('dialog', { name: `Наряд №${order.number}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Журнал наряда/ }).click();
  await expect(dialog.locator('.timeline')).toContainText('Обычный → Высокий');
});

test('QR-карточка открывается по ссылке и подставляет оборудование в выдачу', async ({ page }) => {
  await login(page);
  const bootstrap = await (await page.request.get('/api/bootstrap')).json();
  const equipment = bootstrap.catalogs.equipment.find((item: { siteId: string }) => item.siteId !== bootstrap.catalogs.sites[0].id);
  await page.goto(`/?equipment=${encodeURIComponent(equipment.id)}`);
  const dialog = page.getByRole('dialog', { name: equipment.name, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.equipment-qr img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(dialog.locator('.qr-target')).toContainText(`?equipment=${equipment.id}`);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Скачать QR-код' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(equipment.inventory);
  expect(await download.failure()).toBeNull();
  await dialog.getByRole('button', { name: 'Выдать наряд на оборудование' }).click();
  const form = page.getByRole('dialog', { name: 'Выдать новый наряд' });
  await expect(form.getByRole('combobox', { name: 'Оборудование', exact: true })).toHaveValue(equipment.id);
  await expect(form.getByRole('combobox', { name: 'Участок', exact: true })).toHaveValue(equipment.siteId);
  await form.getByRole('textbox', { name: /Описание проблемы/ }).fill('Заменить изношенный подшипник, проверить нагрев при пробном пуске');
  await expect(form.locator('.fault-suggestion')).toContainText('М-01');
  await form.getByRole('button', { name: 'Применить норматив' }).click();
  await expect(form.getByRole('spinbutton', { name: 'Норматив, часов' })).toHaveValue('2');
});

test('казахский язык сохраняется, мобильный журнал не выходит за экран', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  await page.getByRole('button', { name: 'Қазақша', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await expect(page.locator('#primary-navigation')).toContainText('Әрекеттер журналы');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await expect(page.locator('.app-shell')).toBeVisible();
  // Select by stable navigation icon label after a language round trip.
  await page.locator('.mobile-menu-toggle').click();
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await page.locator('#primary-navigation').getByRole('button', { name: 'Журнал действий' }).click();
  await expect(page.locator('.activity-log')).toBeVisible();
  await expect(page.locator('.activity-card').first()).toBeVisible();
  const widths = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.width + 1);
  await page.evaluate(() => window.scrollTo(0, 800));
  const header = await page.locator('.topbar').boundingBox();
  expect(header!.y).toBeGreaterThanOrEqual(0);
  expect(header!.y).toBeLessThanOrEqual(15);
});
