import assert from 'node:assert/strict';
import test from 'node:test';
import { STATION_BOARD_LINES, STATION_BOARD_STATIONS, parseDestinationFacts, selectEvents, countdown, nextBoundary, buildStationBoardState } from '../server/station-board-v2.js';
import { buildApnsPayload } from '../server/live-activity.js';

const now = Date.parse('2026-10-01T13:00:00Z');
const headers = (date = now, age = 0, maxAge = 30) => ({ date: new Date(date).toUTCString(), age: String(age), 'cache-control': `public,max-age=${maxAge}` });
const cacheOf = (...events) => ({ sources: Object.fromEntries([...new Set(events.map(e => e.sourceID))].map(source => [source, { observedAt: Math.max(...events.filter(e => e.sourceID === source).map(e => e.receivedAt)), events: events.filter(e => e.sourceID === source) }])), rejections: [] });
function board(lineID) {
  const line = STATION_BOARD_LINES.get(lineID), stationID = line.boundedOriginID;
  const destination = [...STATION_BOARD_STATIONS.values()].find(s => s.lineIDs.includes(lineID) && s.stationID !== stationID);
  return { record: { stationID, lineID, selectionMode: 'allPlatforms', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2 }, destination };
}
function row(record, destination, overrides = {}) {
  return { id: 'scheduled', stationID: record.stationID, lineID: record.lineID, sourceID: 'journey-planner', kind: 'outgoingDeparture', destination: destination.stationName, destinationStationID: destination.stationID, time: now + 120000, timeEvidence: 'scheduledDeparture', platform: null, receivedAt: now, expiresAt: now + 120000, ...overrides };
}
function rawFact(record, destination, overrides = {}) {
  return { id: 'downstream', lineId: record.lineID, naptanId: destination.stationID, stationName: destination.stationName, destinationName: destination.stationName, destinationNaptanId: destination.stationID, currentLocation: `At ${STATION_BOARD_STATIONS.get(record.stationID).stationName} Platform 2`, platformName: 'Platform 9', expectedArrival: new Date(now + 300000).toISOString(), timestamp: new Date(now).toISOString(), timing: { read: new Date(now).toISOString() }, vehicleId: 'synthetic-source', direction: 'Outbound', ...overrides };
}

test('all19 current reported at-platform facts precede compact limits without borrowing clocks', () => {
  assert.equal(STATION_BOARD_LINES.size, 19);
  for (const lineID of STATION_BOARD_LINES.keys()) {
    const { record, destination } = board(lineID);
    const facts = parseDestinationFacts([rawFact(record, destination)], record, headers(), now);
    assert.equal(facts.length, 1, lineID);
    const fact = facts[0], plans = [70, 85, 300].map((v, i) => row(record, destination, { id: `plan-${i}`, time: now + v * 1000 }));
    const incoming = row(record, STATION_BOARD_STATIONS.get(record.stationID), { id: 'incoming', sourceID: 'station-arrivals', kind: 'incomingArrival', timeEvidence: 'arrivalPrediction', time: now + 1000, platform: 'Platform 6' });
    for (const input of [[...plans, incoming, fact], [fact, incoming, ...plans].reverse()]) {
      const cache = cacheOf(...input), before = JSON.stringify(cache);
      assert.equal(selectEvents(cache, record, now)[0].id, fact.id, lineID);
      assert.equal(selectEvents(cache, record, now).at(-1).id, 'incoming');
      for (const capability of [undefined, 2]) {
        const state = buildStationBoardState({ ...record, plannedPresentationVersion: capability }, cache, now);
        assert.deepEqual(state.arrivals.map(e => e.id), [fact.id, 'plan-0', 'plan-1']);
        assert.equal(state.arrivals[0].expectedArrival, null);
        assert.equal(state.arrivals[0].countdownText, 'TBC');
        assert.equal(state.arrivals[0].timeEvidence, 'destinationOnly');
        assert.equal(state.arrivals[0].reportedPlatform, 'Platform 2');
        assert.equal(state.arrivals[0].expiresAt, (now + 30000 - 978307200000) / 1000);
        assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 3500);
        assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(state, new Date(now)))) <= 4096);
      }
      assert.equal(nextBoundary(cache, record, now), now + 1000); // Original scheduled minute boundary; the fact adds only source expiry.
      assert.equal(JSON.stringify(cache), before);
      assert.equal(selectEvents(cache, record, now + 30000).some(e => e.id === fact.id), false);
      assert.equal(countdown(fact, now + 30000), '--');
      assert.equal(buildStationBoardState(record, cache, now + 30000).arrivals[0].id, 'plan-0');
    }
    const platform2 = { ...record, selectionMode: 'platform', platformLabel: '2', platformID: '2' };
    assert.deepEqual(selectEvents(cacheOf(fact, incoming, ...plans), platform2, now).map(e => e.id), [fact.id]);
    assert.equal(selectEvents(cacheOf(fact), { ...platform2, platformLabel: '3', platformID: '3' }, now).length, 0);
    assert.equal(selectEvents(cacheOf(fact), { ...record, lineID: 'unsupported' }, now).length, 0);
  }
});

test('unknown or alternative platforms never gain at-platform priority; unsupported or expired rows do not claim TBC', () => {
  const { record, destination } = board('northern');
  const early = row(record, destination, { id: 'early', time: now + 20000 });
  const fact = row(record, destination, { id: 'fact', sourceID: 'at-station-destination', kind: 'outgoingDestinationOnly', time: null, timeEvidence: null, platform: 'Platform 2', expiresAt: now + 30000 });
  for (const platform of ['2', 'Platform 2', '4a', 'Platform A']) assert.equal(selectEvents(cacheOf(early, { ...fact, platform }), record, now)[0].id, 'fact');
  for (const platform of [null, 'Unknown', 'Platform 2 or 5', 'Platform 2/5', 'Platform 2 - Platform 5', 'Platform 2-5', 'Outbound']) {
    assert.equal(selectEvents(cacheOf(early, { ...fact, platform }), record, now)[0].id, 'early');
  }
  assert.equal(countdown(fact, now), 'TBC');
  assert.equal(countdown({ ...fact, expiresAt: now }, now), '--');
  assert.equal(countdown({ ...fact, receivedAt: now + 1 }, now), '--');
  assert.equal(countdown({ ...fact, sourceID: 'unknown' }, now), '--');
  assert.equal(countdown({ ...fact, time: now + 20000 }, now), '--');
  assert.equal(countdown({ ...fact, timeEvidence: 'scheduledDeparture' }, now), '--');
  assert.equal(countdown(early, now), 'Due');
  assert.equal(countdown(early, early.time), 'Due');
  assert.equal(countdown(early, early.time + 1), '--');
  assert.deepEqual(buildStationBoardState(record, cacheOf(), now).arrivals, []);
});

test('destination facts retain original Date Age provider expiry and clear source authority strictly', () => {
  const { record, destination } = board('northern'), raw = rawFact(record, destination);
  const fact = parseDestinationFacts([raw], record, headers(now - 10000, 0), now)[0];
  assert.equal(fact.receivedAt, now);
  assert.equal(fact.expiresAt, now + 20000);
  const original = JSON.stringify(fact);
  assert.equal(countdown(fact, now + 19999), 'TBC');
  assert.equal(countdown(fact, now + 20000), '--');
  assert.equal(JSON.stringify(fact), original);
  assert.equal(parseDestinationFacts([raw], record, headers(now, 30), now).length, 0);
  assert.equal(parseDestinationFacts([raw], record, headers(now - 30000, 0), now).length, 0);
  assert.equal(parseDestinationFacts([{ ...raw, timing: undefined }], record, headers(), now).length, 0);
  assert.equal(parseDestinationFacts([raw], record, { ...headers(), age: 'invalid' }, now).length, 0);
  assert.equal(parseDestinationFacts([raw, { ...raw, destinationNaptanId: record.stationID, destinationName: STATION_BOARD_STATIONS.get(record.stationID).stationName }], record, headers(), now).length, 0);
});
