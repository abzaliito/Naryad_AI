/**
 * Record the actual demo UI against a fresh temporary database.
 * Prerequisites: npm run build; local Microsoft Edge; Playwright FFmpeg runtime.
 * PowerShell runtime installation:
 *   $env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/node_modules/.cache/playwright"
 *   node node_modules/playwright/cli.js install ffmpeg
 * Run: node scripts/record-demo.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.join(root, 'artifacts');
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(root, 'node_modules', '.cache', 'playwright');
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
const { chromium } = await import('playwright');
const edge = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = Number(process.env.DEMO_PORT ?? 3102);
const baseURL = `http://127.0.0.1:${port}`;
const dimensions = { width: 1440, height: 1000 };

assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
assert.ok(existsSync(edge), 'Microsoft Edge was not found; set PLAYWRIGHT_EXECUTABLE_PATH.');
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid DEMO_PORT.');
await mkdir(artifactDir, { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), 'naryad-demo-'));
const recordingDir = await mkdtemp(path.join(artifactDir, '.recording-'));
let server, browser, context, page;
let childFailure;
let recordedAt;
const chapters = [];
const browserErrors = [];

function log(message) { console.log(`[demo] ${message}`); }
async function hold(milliseconds) { await delay(milliseconds); }
function chapter(title) {
  chapters.push({ atSeconds: Number(((Date.now() - recordedAt) / 1000).toFixed(2)), title });
  log(title);
}

async function portAvailable() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function startServer() {
  await portAvailable();
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'production', COOKIE_SECURE: 'false', AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '', AI_SEND_PHOTOS: 'false' },
  });
  server.on('error', error => { childFailure = error; });
  server.stdout.on('data', chunk => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));
  for (let attempt = 0; attempt < 90; attempt++) {
    if (childFailure) throw childFailure;
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${server.exitCode}`);
    try { const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Server is still opening SQLite. */ }
    await delay(400);
  }
  throw new Error('Isolated server did not become ready.');
}

async function login(account) {
  await page.getByLabel('Логин', { exact: true }).fill(account);
  await page.getByLabel('ПИН-код', { exact: true }).fill('1234');
  await hold(700);
  await page.getByRole('button', { name: 'Войти в систему', exact: true }).click();
  await page.locator('.app-shell').waitFor();
}

async function logout() {
  const dialogs = page.getByRole('dialog');
  while (await dialogs.count()) await dialogs.last().getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  await page.getByTitle('Выйти из аккаунта', { exact: true }).click();
  await page.getByRole('button', { name: 'Войти в систему', exact: true }).waitFor();
  await hold(450);
}

async function waitForOrder(id, predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await page.request.get('/api/bootstrap');
    assert.equal(response.status(), 200);
    const data = await response.json();
    const order = data.orders.find(item => item.id === id);
    if (order && predicate(order)) return order;
    await delay(200);
  }
  throw new Error(`Expected order state was not reached: ${id}`);
}

async function makePresentation() {
  const slides = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  try {
    await slides.goto(pathToFileURL(path.join(root, 'docs', 'presentation.html')).href);
    await slides.evaluate(() => document.fonts.ready);
    assert.equal(await slides.locator('.slide').count(), 10, 'The presentation must contain 10 slides.');
    await slides.emulateMedia({ media: 'print' });
    const file = path.join(artifactDir, 'presentation.pdf');
    await slides.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
    const bytes = await readFile(file);
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    const pageCount = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
    assert.equal(pageCount, 10, 'PDF pagination must remain 10 pages.');
    log(`Презентация: ${pageCount} слайдов, ${bytes.length} байт.`);
    return { file: 'presentation.pdf', pages: pageCount, bytes: bytes.length };
  } finally { await slides.close(); }
}

async function videoDuration(videoPath) {
  const folders = await readdir(browserCache);
  for (const folder of folders.filter(item => item.startsWith('ffmpeg-'))) {
    const executable = path.join(browserCache, folder, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
    if (!existsSync(executable)) continue;
    const result = spawnSync(executable, ['-hide_banner', '-i', videoPath], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.error) throw result.error;
    const match = `${result.stdout}\n${result.stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  throw new Error('Unable to measure WebM duration using the Playwright FFmpeg runtime.');
}

async function removeOwnedDirectory(directory, parent, prefix) {
  const target = path.resolve(directory);
  assert.equal(path.dirname(target).toLowerCase(), path.resolve(parent).toLowerCase());
  assert.ok(path.basename(target).startsWith(prefix));
  await rm(target, { recursive: true, force: true });
}

try {
  await startServer();
  browser = await chromium.launch({ executablePath: edge, headless: true, slowMo: 60 });
  context = await browser.newContext({ baseURL, viewport: dimensions, locale: 'ru-RU', timezoneId: 'Asia/Qyzylorda', reducedMotion: 'reduce', recordVideo: { dir: recordingDir, size: dimensions } });
  context.setDefaultTimeout(15_000);
  page = await context.newPage();
  const video = page.video();
  page.on('pageerror', error => browserErrors.push(error.message));
  recordedAt = Date.now();

  chapter('Мастер: панель смены и текущие задачи');
  await page.goto('/'); await hold(1200); await login('master'); await hold(5000);

  chapter('Выдача планового наряда свободному исполнителю');
  await page.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Выдать новый наряд', exact: true });
  await form.getByRole('button', { name: 'Плановое ТО', exact: true }).click();
  await form.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption('usr-worker-9');
  await hold(3500);
  const issuedResponse = page.waitForResponse(response => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Выдать наряд', exact: true }).click();
  const response = await issuedResponse;
  assert.equal(response.status(), 201, await response.text());
  const order = await response.json();
  assert.equal(order.assigneeId, 'usr-worker-9'); assert.equal(order.type, 'planned');
  await form.waitFor({ state: 'hidden' }); await hold(1500);

  chapter('Исполнитель: уведомление и принятие задания');
  await logout(); await login('worker9'); await hold(2200);
  await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
  const notification = page.locator('.notification-item').filter({ hasText: `№${order.number}` }).first();
  await notification.waitFor(); await hold(2000); await notification.click();
  const detail = page.getByRole('dialog', { name: /^Наряд №/ });
  await detail.waitFor();
  await detail.getByRole('button', { name: 'Принять в работу', exact: true }).click(); await hold(1500);
  await detail.getByRole('button', { name: 'Начать исполнение', exact: true }).click();
  await waitForOrder(order.id, item => item.status === 'in_progress'); await hold(1700);

  chapter('Отчёт: работы, шифр и подтверждение отсутствия расхода ТМЦ');
  await detail.getByRole('button', { name: 'Исполнено — отправить отчёт', exact: true }).click();
  const report = page.getByRole('dialog', { name: /^Отчёт об исполнении/ });
  await report.getByLabel(/^Выполненные работы/).pressSequentially('Проведены осмотр, очистка и проверка соединений. При контрольном включении отклонений не обнаружено. Учебная демонстрация.', { delay: 12 });
  await report.getByRole('combobox', { name: 'Шифр неисправности', exact: true }).selectOption('fault-inspection');
  await report.getByLabel('Материалы не использовались', { exact: true }).check();
  await hold(3000);
  await report.getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
  await report.waitFor({ state: 'hidden' });
  const reviewed = await waitForOrder(order.id, item => Boolean(item.assessment));
  assert.ok(['accepted', 'remarks'].includes(reviewed.assessment.verdict));

  chapter('Обязательная проверка и объяснение оценки');
  await detail.getByRole('button', { name: 'Проверка и отчёт', exact: false }).click();
  await detail.locator('.assessment-hero').waitFor(); await hold(4500);
  await detail.locator('.assessment-checks').getByText('Учёт ТМЦ', { exact: true }).scrollIntoViewIfNeeded(); await hold(2500);

  chapter('Мастер проверяет результат и подтверждает закрытие');
  await logout(); await login('master'); await page.goto(`/?order=${order.id}`);
  await detail.waitFor(); await hold(1200);
  const masterComment = detail.getByLabel('Комментарий мастера', { exact: true });
  await masterComment.fill('Учебная демонстрация: полнота отчёта проверена, результат принят мастером.');
  await hold(1700);
  await detail.getByRole('button', { name: 'Принять и закрыть', exact: true }).click();
  await waitForOrder(order.id, item => item.status === 'closed');
  await detail.getByRole('button', { name: /^История/ }).click(); await hold(3500);
  await detail.getByRole('button', { name: 'Проверка и отчёт', exact: false }).click(); await hold(3500);
  await detail.getByRole('button', { name: 'Закрыть окно', exact: true }).click();

  chapter('Аналитика за три месяца и найденные закономерности');
  await page.locator('nav').getByRole('button', { name: 'Аналитика и отчёты', exact: true }).click();
  await page.getByRole('heading', { name: 'Плановые и внеплановые работы', exact: true }).waitFor();
  await hold(4500);
  await page.getByRole('button', { name: /^Аномалии/ }).click();
  await page.getByRole('heading', { name: /К-3: повторяется/ }).waitFor(); await hold(5500);

  chapter('Рейтинг исполнителей с прозрачными весами');
  await page.getByRole('button', { name: 'Рейтинг исполнителей', exact: true }).click();
  await page.locator('.rating-table tbody tr').first().waitFor(); await hold(5000);
  await page.locator('.brigade-ratings').scrollIntoViewIfNeeded(); await hold(2500);

  assert.deepEqual(browserErrors, [], 'The recording must not contain browser JavaScript errors.');
  await context.close(); context = undefined;
  const pendingVideo = path.join(artifactDir, 'demo.pending.webm');
  await video.saveAs(pendingVideo);
  const durationSeconds = await videoDuration(pendingVideo);
  assert.ok(durationSeconds >= 45 && durationSeconds <= 180, `Expected a readable demo no longer than 3 minutes, got ${durationSeconds} s.`);
  await rename(pendingVideo, path.join(artifactDir, 'demo.webm'));
  const videoBytes = (await stat(path.join(artifactDir, 'demo.webm'))).size;
  log(`Видео: ${durationSeconds.toFixed(2)} с, ${videoBytes} байт.`);
  const presentation = await makePresentation();
  const metadata = { generatedAt: new Date().toISOString(), video: { file: 'demo.webm', durationSeconds, bytes: videoBytes, ...dimensions, audio: false, chapters }, presentation, scenario: 'Сквозной плановый наряд: мастер → worker9 → проверка → приёмка → аналитика и рейтинг.', aiMode: 'demo-rules', data: 'Изолированная временная SQLite с учебными данными; обычная база приложения не изменялась.', validation: { browserErrors, issuedOrder: order.number, finalStatus: 'closed' } };
  await writeFile(path.join(artifactDir, 'demo-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  log('Готово: artifacts/demo.webm, artifacts/presentation.pdf, artifacts/demo-metadata.json');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifactDir, 'demo-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await Promise.race([stopped, delay(5000)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await Promise.race([stopped, delay(3000)]); }
  }
  await removeOwnedDirectory(recordingDir, artifactDir, '.recording-');
  await removeOwnedDirectory(dataDir, tmpdir(), 'naryad-demo-');
}
