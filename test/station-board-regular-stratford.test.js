import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildStationBoardState, mergeContexts, refreshStationBoard, selectEvents } from '../server/station-board-v2.js';
import { loadConfig, validateTokenPayload } from '../server/live-activity.js';

// Window of the exact TfL Saturday response from 2026-11-21 18:31:58 UTC.
// Full response SHA256 c023fd0c18abdea7b26b7e2742667aba532050c90687aa6425d6614ab35bc514.
const timetable = JSON.parse(fs.readFileSync(new URL('./fixtures/stratford-jubilee-20261121-window.json', import.meta.url)));
const now = Date.parse('2026-11-21T18:31:58Z');
const record = { stationID: '940GZZLUSTD', lineID: 'jubilee', selectionMode: 'allPlatforms', plannedPresentationVersion: 2, supportsRegularTimetable: true };
const config = loadConfig({});
const direct = '/Line/jubilee/Timetable/940GZZLUSTD';
const headers = { Date: new Date(now).toUTCString(), Age: '10625', 'Cache-Control': 'public, max-age=43200' };
const reply = (body, h = headers) => new Response(JSON.stringify(body), { headers: h });
function fixture({ limited = false, closed = false } = {}) {
  const requests = [];
  const fetch = async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === direct) return limited ? new Response(null, { status: 429, headers: { 'Retry-After': '480' } }) : reply(timetable);
    if (closed && path.includes('/Status')) return reply([{ id: 'jubilee', lineStatuses: [{ statusSeverity: 20, reason: 'No service' }] }]);
    return new Response(null, { status: 503 });
  };
  return { requests, fetch };
}

test('a real ordinary Stratford Saturday provides only exact-origin scheduled rows through dated and control outages', async () => {
  const { fetch, requests } = fixture();
  const cache = await refreshStationBoard(record, {}, config, fetch, now, null);
  const rows = selectEvents(cache, record, now);
  assert.deepEqual(rows.map(row => row.destinationStationID), ['940GZZLUWYP', '940GZZLUSTM', '940GZZLUSTM', '940GZZLUSTM']);
  assert.equal(rows[0].time, Date.parse('2026-11-21T18:33:00Z'));
  assert.equal(rows[0].receivedAt, now - 10625000);
  assert.equal(rows[0].expiresAt, now + 600000);
  assert.equal(requests.filter(path => path === direct).length, 1);
  assert.equal(buildStationBoardState(record, cache, now).arrivals[0].plannedSourceID, 'regular-timetable');
  assert.deepEqual(selectEvents(cache, { ...record, supportsRegularTimetable: undefined }, now), []);
  assert.deepEqual(selectEvents(cache, { ...record, selectionMode: 'platform', platformID: '2' }, now), []);
  assert.deepEqual(selectEvents(cache, record, now + 600000), []);
  const live = { ...rows[1], id: 'live', sourceID: 'station-arrivals', timeEvidence: 'predictedDeparture', receivedAt: now };
  const mixed = mergeContexts(cache, { sources: { 'station-arrivals': { observedAt: now, events: [live] } } }, record, now);
  assert.deepEqual(selectEvents(mixed, record, now).map(row => row.destinationStationID), ['940GZZLUWYP', '940GZZLUSTM']);
});

test('Stratford ordinary timetable withholds on closure and honors a shared 429 floor', async () => {
  const first = fixture();
  const cache = await refreshStationBoard(record, {}, config, first.fetch, now, null);
  const closed = fixture({ closed: true });
  const afterClosure = await refreshStationBoard(record, cache, config, closed.fetch, now + 90000, null);
  assert.equal(afterClosure.sources['regular-timetable'], undefined);
  assert.equal(closed.requests.includes(direct), false);
  const limited = fixture({ limited: true });
  const afterLimit = await refreshStationBoard(record, {}, config, limited.fetch, now, null);
  assert.equal(afterLimit.ordinaryNotBefore, now + 480000);
  await refreshStationBoard(record, afterLimit, config, limited.fetch, now + 90000, null);
  assert.equal(limited.requests.filter(path => path === direct).length, 1);
});

test('an equal or older cached observation cannot replace a still-valid ordinary source', async () => {
  const { fetch } = fixture();
  const cache = await refreshStationBoard(record, {}, config, fetch, now, null);
  const source = cache.sources['regular-timetable'];
  for (const delta of [0, -1000]) {
    const earlier = { ...source, observedAt: source.observedAt + delta, events: [source.events[1]] };
    const merged = mergeContexts(cache, { sources: { 'regular-timetable': earlier } }, record, now);
    assert.deepEqual(merged.sources['regular-timetable'], source);
  }
});

test('the regular capability is true-only on a qualified typed registration', () => {
  const registration = { ...record, activityID: 'synthetic-stratford', installID: 'synthetic-device',
    pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(),
    appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.2.6', buildNumber: '1',
    environment: 'sandbox', contentStateContract: 'station-board-v2' };
  assert.equal(validateTokenPayload(registration, new Date(now)).value.supportsRegularTimetable, true);
  for (const rejected of [false, 'true', 1, null]) {
    assert.equal(validateTokenPayload({ ...registration, supportsRegularTimetable: rejected }, new Date(now)).ok, false);
  }
  assert.equal(validateTokenPayload({ ...registration, plannedPresentationVersion: undefined }, new Date(now)).ok, false);
  assert.equal(validateTokenPayload({ ...registration, supportsRegularTimetable: undefined }, new Date(now)).value.supportsRegularTimetable, undefined);
});

test('the generated origin map replays Epping, Edgware and the proved Edgware Road starting path', async () => {
  const captures = JSON.parse(fs.readFileSync(new URL('./fixtures/regular-timetable-additional-origins.json', import.meta.url)));
  const at = Date.parse('2026-11-21T19:47:00Z');
  const expected = new Map([
    ['central', { station: '940GZZLUEPG', count: 3, first: '940GZZLUWRP', minutes: 8 }],
    ['circle', { station: '940GZZLUERC', count: 2, first: '940GZZLUHSC', minutes: 8 }],
    ['northern', { station: '940GZZLUEGW', count: 8, first: '940GZZLUMDN', minutes: 1 }],
  ]);
  for (const { body } of captures) {
    const answer = expected.get(body.lineId);
    const selected = { ...record, lineID: body.lineId, stationID: answer.station };
    const feed = async url => new URL(url).pathname === '/Line/' + selected.lineID + '/Timetable/' + selected.stationID
      ? reply(body, { ...headers, Date: new Date(at).toUTCString(), Age: '60' }) : new Response(null, { status: 503 });
    const cache = await refreshStationBoard(selected, {}, config, feed, at, null);
    const rows = selectEvents(cache, selected, at);
    assert.equal(rows.length, answer.count, body.lineId);
    assert.equal(rows[0]?.destinationStationID, answer.first);
    assert.equal(rows[0]?.time, at + answer.minutes * 60000);
    if (body.lineId === 'northern') assert.deepEqual([...new Set(rows.map(row => row.via))].sort(), ['Bank', 'Charing Cross']);
  }
});
