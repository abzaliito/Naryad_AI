import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardTrend } from '../src/dashboardTrend.ts';

test('dashboard trend uses local calendar boundaries, independent closure dates and the correct year', () => {
  const now=Date.parse('2026-10-08T10:00:00Z');
  const orders=[
    {createdAt:'2026-10-01T05:00:00Z',closedAt:'2026-10-08T04:00:00Z'},
    {createdAt:'2026-10-07T19:30:00Z'}, // Midnight has passed in Kostanay.
    {createdAt:'2025-10-08T05:00:00Z',closedAt:'2025-10-08T06:00:00Z'},
    {createdAt:'2026-10-08T11:00:00Z'}, // Future records do not enter actuals.
    {createdAt:'invalid',closedAt:'invalid'},
  ];
  const trend=dashboardTrend(orders,now);
  assert.equal(trend.length,7);
  assert.equal(trend.at(-1).issued,1);
  assert.equal(trend.at(-1).done,1);
  assert.equal(trend.reduce((sum,item)=>sum+item.issued,0),1);
  const kk=dashboardTrend(orders,now,'kk');
  assert.deepEqual(kk.map(({name,...row})=>row),trend.map(({name,...row})=>row));
});
