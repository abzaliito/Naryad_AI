import test from 'node:test';
import assert from 'node:assert/strict';
import { answerAssistant } from '../server/ai.mjs';

const people = [{ id: 'employee-secret-id', name: 'Ерлан Ахметов', login: 'akhmetov', role: 'worker', onShift: true, specialty: 'Электромонтёр', pin: 'private-pin' }, { id: 'other-secret-id', name: 'Алексей Ким', login: 'kim-login', role: 'worker', onShift: true, specialty: 'Слесарь' }];
const records = {
  users: people,
  orders: [{ id: 'private-order-id', assigneeId: people[0].id, status: 'issued', type: 'unplanned', equipmentId: 'machine', dueAt: '2026-10-07T10:00:00Z', comment: 'private-order-comment', photos: [{ filename: 'private-photo.jpg' }] }, { id: 'other-order', assigneeId: people[1].id, status: 'in_progress', type: 'unplanned', equipmentId: 'machine', dueAt: '2026-10-09T10:00:00Z' }],
  equipment: [{ id: 'machine', name: 'Насос Ерлан Ахметов', type: 'Насос', siteId: 'site' }], sites: [{ id: 'site', name: 'Дробление' }],
};
const store = { list: kind => structuredClone(records[kind] ?? []), get: (kind, id) => structuredClone(records[kind]?.find(item => item.id === id)) };
const now = new Date('2026-10-08T10:00:00Z');
const manager = { id: 'manager', role: 'manager' };

async function modelTest(work) {
  const originalFetch = globalThis.fetch;
  const previous = Object.fromEntries(['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY'].map(key => [key, process.env[key]]));
  process.env.AI_BASE_URL = 'https://assistant.invalid/v1/'; process.env.AI_MODEL = 'assistant-fixture'; process.env.AI_API_KEY = 'private-api-key';
  try { await work(); }
  finally { globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test('Configured assistant uses an anonymized aggregate context and preserves calculated facts', async () => modelTest(async () => {
  let outbound;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://assistant.invalid/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-api-key');
    assert.ok(options.signal instanceof AbortSignal);
    outbound = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: 'Уточните причину просрочки и согласуйте очередность задач.', confidence: 0.9, provider: 'forged', orders: [{ status: 'closed' }] }) } }] });
  };
  const facts = 'Свободен Ерлан Ахметов. Просрочен 1 наряд.';
  const result = await answerAssistant('Что делать Ерлан Ахметов, akhmetov, employee-secret-id? +7 700 123 45 67 test@example.com private-api-key', store, manager, facts, now);
  assert.equal(result.provider, 'configured-model'); assert.ok(result.answer.includes(facts)); assert.match(result.answer, /Пояснение ИИ-модели/);
  assert.deepEqual(Object.keys(result).sort(), ['answer', 'provider']);
  const payload = outbound.messages[1].content;
  for (const privateValue of ['Ерлан', 'Ахметов', 'akhmetov', 'employee-secret-id', 'Алексей', 'Ким', 'other-secret-id', 'private-pin', 'private-order-id', 'private-order-comment', 'private-photo.jpg', 'private-api-key', '700 123', 'test@example.com']) assert.ok(!payload.includes(privateValue), `Outbound data leaked ${privateValue}`);
  const evidence = JSON.parse(payload).evidence;
  assert.equal(evidence.totalOrders, 2); assert.equal(evidence.overdue, 1);
  assert.deepEqual(evidence.statuses, { issued: 1, in_progress: 1 });
  assert.ok(evidence.workforceBySpecialty.some(row => row.specialty === 'Электромонтёр' && row.free === 1));
  assert.equal(records.orders[0].status, 'issued');
}));

test('Assistant rejects malformed, uncertain and failed model output with a labelled factual fallback', async () => modelTest(async () => {
  const failures = [
    () => { throw new DOMException('Timed out', 'TimeoutError'); },
    () => new Response('rate limit', { status: 429 }),
    () => Response.json({ choices: [{ message: { content: 'not json' } }] }),
    () => Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: 'Недостаточно данных.', confidence: 0.4 }) } }] }),
    () => Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: 'Слишком длинно'.repeat(200), confidence: 0.8 }) } }] }),
    () => Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: '', confidence: 1 }) } }] }),
  ];
  for (const fail of failures) {
    globalThis.fetch = fail;
    const result = await answerAssistant('Сроки?', store, manager, 'Просрочен 1 наряд.', now);
    assert.equal(result.provider, 'demo-rules (fallback)'); assert.match(result.answer, /Модель недоступна/); assert.match(result.answer, /Просрочен 1 наряд/);
  }
}));

test('Assistant without model configuration never calls the network', async () => modelTest(async () => {
  delete process.env.AI_MODEL;
  globalThis.fetch = () => { throw new Error('Unexpected network request'); };
  const result = await answerAssistant('Сколько нарядов?', store, manager, undefined, now);
  assert.equal(result.provider, 'demo-rules'); assert.match(result.answer, /Статистический режим/); assert.match(result.answer, /2 нарядов/);
}));

test('Assistant helper scopes aggregate evidence to the worker when called internally', async () => modelTest(async () => {
  let evidence;
  globalThis.fetch = async (_url, options) => {
    evidence = JSON.parse(JSON.parse(options.body).messages[1].content).evidence;
    return Response.json({ choices: [{ message: { content: '{"explanation":"Проверьте срок своего наряда.","confidence":0.9}' } }] });
  };
  const result = await answerAssistant('Моя загрузка?', store, people[0], undefined, now);
  assert.equal(result.provider, 'configured-model'); assert.equal(evidence.scope, 'own_orders'); assert.equal(evidence.totalOrders, 1);
  assert.equal(evidence.equipment[0].unplannedOrders, 1); assert.equal(evidence.workforceBySpecialty.length, 1);
}));

test('Scoped assistant requests send only selected order aggregates, including empty scope and worker restrictions', async () => modelTest(async () => {
  let evidence;
  globalThis.fetch = async (_url, options) => {
    evidence = JSON.parse(JSON.parse(options.body).messages[1].content).evidence;
    return Response.json({ choices: [{ message: { content: '{"explanation":"Проверьте причины выбранных заявок.","confidence":0.9}' } }] });
  };
  await answerAssistant('Проблемы выбранного участка за месяц', store, manager, 'Выбран 1 наряд.', { at: now, scopeOrders: [records.orders[0]] });
  assert.equal(evidence.scope, 'selected_period_and_scope'); assert.equal(evidence.totalOrders, 1); assert.deepEqual(evidence.statuses, { issued: 1 });
  assert.equal(evidence.overdue, 1); assert.equal(evidence.equipment[0].unplannedOrders, 1); assert.deepEqual(evidence.workforceBySpecialty, []);
  await answerAssistant('Пустой период', store, manager, 'Выбрано 0 нарядов.', { at: now, scopeOrders: [] });
  assert.equal(evidence.totalOrders, 0); assert.deepEqual(evidence.statuses, {}); assert.deepEqual(evidence.equipment, []); assert.equal(evidence.overdue, 0);
  await answerAssistant('Мой период', store, people[0], undefined, { at: now, scopeOrders: records.orders });
  assert.equal(evidence.totalOrders, 1); assert.deepEqual(evidence.statuses, { issued: 1 });
}));
