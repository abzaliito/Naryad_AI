import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { assessOrder } from '../server/ai.mjs';

test('Vision requests explicitly label before/after evidence and send no images without opt-in', async t => {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'naryad-vision-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const previous = Object.fromEntries(['AI_BASE_URL', 'AI_MODEL', 'AI_SEND_PHOTOS'].map(key => [key, process.env[key]]));
  const now = new Date();
  const photos = [];
  for (const kind of ['before', 'after']) {
    const id = randomUUID(); const filename = `${id}.jpg`;
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: kind === 'before' ? '#333333' : '#999999' } }).jpeg().toBuffer();
    await writeFile(path.join(uploadDir, filename), bytes);
    photos.push({ id, filename, kind, hash: kind, capturedAt: now.toISOString() });
  }
  const order = { id: 'order', description: 'Устранить видимую течь насоса.', type: 'unplanned', createdAt: new Date(now.getTime() - 3600000).toISOString(), startedAt: new Date(now.getTime() - 1800000).toISOString(), completedAt: now.toISOString(), dueAt: new Date(now.getTime() + 3600000).toISOString(), normHours: 0.5, photos, completion: { works: 'Заменена манжета, проведён пробный запуск и проверена герметичность.', faultId: 'fault', materials: [], materialsConfirmed: true } };
  const store = { list: () => [], get: kind => kind === 'faults' ? { name: 'Течь' } : kind === 'equipment' ? { type: 'Насос' } : null };
  let outbound;
  globalThis.fetch = async (_url, options) => {
    outbound = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: 'accepted', score: 5, confidence: 0.9, summary: 'Заключение требует приёмки мастером.', checks: [], strengths: [], improvements: [] }) } }] });
  };
  process.env.AI_BASE_URL = 'https://vision.invalid/v1'; process.env.AI_MODEL = 'vision-fixture';
  try {
    delete process.env.AI_SEND_PHOTOS;
    const textOnly = await assessOrder(order, store, uploadDir);
    assert.equal(outbound.messages[1].content.length, 1);
    assert.deepEqual(JSON.parse(outbound.messages[1].content[0].text).visualEvidence, { transferAllowed: false, sentBefore: 0, sentAfter: 0, captureTimeVerified: false });
    assert.match(textOnly.summary, /визуальная проверка не выполнена/);
    assert.ok(textOnly.checks.some(check => check.label === 'Визуальная оценка' && check.status === 'warn'));
    process.env.AI_SEND_PHOTOS = 'true';
    const withPhotos = await assessOrder(order, store, uploadDir);
    assert.equal(withPhotos.provider, 'configured-model');
    const content = outbound.messages[1].content;
    assert.deepEqual(JSON.parse(content[0].text).visualEvidence, { transferAllowed: true, sentBefore: 1, sentAfter: 1, captureTimeVerified: false });
    assert.match(content[1].text, /Фото до №1.*kind=before/); assert.equal(content[2].type, 'image_url');
    assert.match(content[3].text, /Фото после №1.*kind=after/); assert.equal(content[4].type, 'image_url');
    assert.ok(content.filter(item => item.type === 'image_url').every(item => item.image_url.url.startsWith('data:image/jpeg;base64,')));
    assert.match(outbound.messages[0].content, /Не считать невидимый элемент отсутствующим/);
    assert.match(outbound.messages[0].content, /не выдавай допуск к эксплуатации/);
    const missing = await assessOrder({ ...order, photos: [] }, store, uploadDir);
    assert.equal(outbound.messages[1].content.length, 1); assert.match(missing.summary, /визуальная проверка не выполнена/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
