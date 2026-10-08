import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendWorkers, suggestFault } from '../src/recommendations.ts';

const workers = ['wrong', 'busy', 'bestPump', 'bestBelt', 'off'].map(id => ({ id, name: id, role: 'worker', onShift: id !== 'off', specialty: id === 'wrong' ? 'Электрик' : 'Слесарь-ремонтник' }));
const catalogs = { users: workers, equipment: [{ id: 'pump', type: 'Насос' }, { id: 'belt', type: 'Конвейер' }] };
function repair(id, assigneeId, equipmentId, score) { return { id, equipmentId, assigneeId, type: 'unplanned', status: 'closed', priority: 'normal', normHours: 1, createdAt: '2026-08-01T03:00:00Z', startedAt: '2026-08-01T03:00:00Z', completedAt: '2026-08-01T04:00:00Z', closedAt: '2026-08-01T04:00:00Z', dueAt: '2026-08-01T05:00:00Z', assessment: { score }, events: [] }; }

test('candidate respects specialty, current load and rating of selected equipment type', () => {
  const orders = [repair('1','bestPump','pump',5), repair('2','bestBelt','pump',2), repair('3','bestBelt','belt',5), repair('4','bestPump','belt',1), repair('5','busy','pump',5), { ...repair('6','busy','pump',5), status: 'in_progress' }];
  const pump = recommendWorkers(orders,catalogs,'pump','Слесарь-ремонтник');
  assert.equal(pump[0].user.id,'bestPump');
  assert.equal(recommendWorkers(orders,catalogs,'belt','Слесарь-ремонтник')[0].user.id,'bestBelt');
  assert.equal(pump.at(-1).user.id,'wrong');
  assert.ok(!pump.some(candidate=>candidate.user.id==='off'));
  assert.equal(recommendWorkers([],catalogs,'pump','Слесарь-ремонтник')[0].rating.evaluated,false);
});

test('fault suggestion only chooses existing catalogue entries, with Russian and Kazakh triggers', () => {
  const faults=[{id:'bearing',name:'Износ подшипникового узла',normHours:2},{id:'leak',name:'Утечка масла',normHours:1}];
  assert.equal(suggestFault('Заменить подшипник привода',faults).id,'bearing');
  assert.equal(suggestFault('Мойынтіректі ауыстыру',faults).id,'bearing');
  assert.equal(suggestFault('Устранить течь',faults).normHours,1);
  assert.equal(suggestFault('Неясный стук',faults),undefined);
  assert.equal(suggestFault('Подшипник',[]),undefined);
});
