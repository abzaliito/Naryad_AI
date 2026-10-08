import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { photoSignature, comparePhotoSignatures } from '../server/photo-evidence.mjs';
import { rulesAssessment } from '../server/ai.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function imagePattern(variant = 0) {
  const width = 384, height = 256, pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3;
    const wave = 120 + 50 * Math.sin(x / (23 + variant * 9) + variant * 2) + 45 * Math.cos(y / (31 + variant * 13)) + 25 * Math.sin((x + y) / 44);
    const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
    pixels[index] = clamp(wave + 15 * Math.cos(y / 19));
    pixels[index + 1] = clamp(wave);
    pixels[index + 2] = clamp(wave + 20 * Math.sin(x / 37));
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

test('perceptual signature recognizes resized/recompressed images with different exact hashes', async () => {
  const original = await imagePattern();
  const resized = await sharp(original).resize({ width: 180 }).jpeg({ quality: 45 }).toBuffer();
  const normalizedAgain = await sharp(resized).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  assert.notEqual(sha(original), sha(normalizedAgain));
  const left = await photoSignature(original), right = await photoSignature(normalizedAgain);
  assert.equal(left.usable, true);
  assert.equal(right.usable, true);
  const comparison = comparePhotoSignatures(left, right);
  assert.equal(comparison.similar, true, `Distance: ${comparison.distance}`);
  assert.ok(comparison.distance <= 8);
});

test('different structural scenes and low-detail images do not generate near-match warnings', async () => {
  const original = await photoSignature(await imagePattern());
  const different = await photoSignature(await imagePattern(3));
  assert.equal(different.usable, true);
  assert.equal(comparePhotoSignatures(original, different).similar, false);
  for (const background of ['#fff', '#000', '#2d6651']) {
    const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background } }).jpeg().toBuffer();
    const flat = await photoSignature(bytes);
    assert.equal(flat.usable, false);
    assert.equal(comparePhotoSignatures(flat, flat).similar, false, 'Equal zero/flat hashes must not claim image similarity');
    assert.equal(comparePhotoSignatures(original, flat).similar, false);
  }
  assert.equal(comparePhotoSignatures(undefined, original).similar, false, 'Legacy uploads without a signature remain valid');
  assert.equal(comparePhotoSignatures({ ...original, hash: 'invalid' }, original).similar, false);
});

test('near matching before/history/other-order photos warns with low confidence and leaves decision to master', async () => {
  const at = new Date('2026-10-08T07:00:00Z');
  const original = await imagePattern();
  const recompressed = await sharp(original).resize({ width: 180 }).jpeg({ quality: 48 }).toBuffer();
  const previous = { id: 'before', kind: 'before', orderId: 'order', hash: sha(original), signature: await photoSignature(original), capturedAt: at.toISOString() };
  const after = { id: 'after', kind: 'after', orderId: 'order', hash: sha(recompressed), signature: await photoSignature(recompressed), capturedAt: at.toISOString() };
  const makeOrder = extra => ({
    id: 'order', type: 'unplanned', createdAt: '2026-10-08T05:00:00Z', startedAt: '2026-10-08T06:00:00Z', completedAt: at.toISOString(), dueAt: '2026-10-08T08:00:00Z', normHours: 1,
    photos: [after], completion: { works: 'Заменена прокладка и проверена герметичность после контрольного запуска.', faultId: 'fault', materials: [], materialsConfirmed: true }, ...extra,
  });
  const store = records => ({ list: kind => kind === 'photos' ? records : [], get: (kind, id) => kind === 'faults' && id === 'fault' ? { id } : null });
  for (const [order, saved] of [
    [makeOrder({ photos: [previous, after] }), [previous, after]],
    [makeOrder({ completionHistory: [{ photos: [{ ...previous, kind: 'after' }] }] }), [after]],
    [makeOrder({}), [{ ...previous, orderId: 'earlier-order', kind: 'after' }, after]],
  ]) {
    const assessment = rulesAssessment(order, store(saved), at);
    assert.equal(assessment.verdict, 'remarks');
    assert.ok(assessment.confidence < 0.6);
    assert.ok(assessment.checks.some(check => check.label === 'Сходство изображений' && check.status === 'warn'));
    assert.equal(assessment.checks.some(check => check.status === 'fail'), false);
    assert.match(assessment.summary, /проверка мастером/);
    assert.match(assessment.summary, /не доказывает/);
  }
  const exact = rulesAssessment(makeOrder({ photos: [previous, { ...after, hash: previous.hash }] }), store([]), at);
  assert.equal(exact.verdict, 'rework');
  assert.ok(exact.checks.some(check => check.label === 'Повторное использование снимков' && check.status === 'fail'));
});
