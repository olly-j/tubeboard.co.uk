import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { replacementFrequencyWithdrawal } from '../server/station-board-availability.js';
import { buildStationBoardState, londonClock, refreshStationBoard, validBoard, STATION_BOARD_STATIONS } from '../server/station-board-v2.js';

import { loadConfig } from '../server/live-activity.js';

const status = JSON.parse(fs.readFileSync(new URL('./fixtures/hammersmith-city-strike-status-20261126.json', import.meta.url)));
const now = Date.parse('2026-11-26T21:47:15Z');
const observation = { observedAt: now, expiresAt: now + 30000 };
const record = { stationID: '940GZZLUHSC', lineID: 'hammersmith-city' };
const authority = { mode: 'tube', stationName: id => validBoard(id, record.lineID) && STATION_BOARD_STATIONS.get(id)?.stationName };
const withdrawal = (body, board = record, at = now) => replacementFrequencyWithdrawal(body, board, observation, at, londonClock, authority);

test('the current strike frequency withdraws only the regular source within its original observation', () => {
  assert.deepEqual(withdrawal(status), { ...observation, regularWithdrawalUntil: observation.expiresAt });
  assert.equal(withdrawal(status, { ...record, lineID: 'circle' }), null);
  assert.equal(withdrawal(status, record, observation.expiresAt), null);
  const endingSoon = structuredClone(status);
  endingSoon[0].lineStatuses[0].validityPeriods[0].toDate = new Date(now + 5000).toISOString();
  assert.equal(withdrawal(endingSoon).regularWithdrawalUntil, now + 5000);
});

test('an ordinary delay, partial branch, unrelated or malformed notice leaves the regular source eligible', () => {
  for (const edit of [
    s => { s.reason = s.disruption.description = 'Severe delays due to an earlier signal failure.'; },
    s => s.disruption.affectedRoutes.pop(),
    s => { s.disruption.affectedRoutes[0].isEntireRouteSection = false; },
    s => { s.disruption.affectedStops = ['another stop']; },
    s => { s.disruption.description = 'Unrelated disruption'; },
    s => { s.reason = {}; },
    s => { s.disruption.description = 1; },
    s => { s.statusSeverity = 10; s.statusSeverityDescription = 'Good Service'; }
  ]) {
    const copy = structuredClone(status);
    edit(copy[0].lineStatuses[0]);
    assert.equal(withdrawal(copy), null);
  }
});

test('an active board drops an earlier ordinary countdown while keeping the independent dated departure', async () => {
  const board = { ...record, selectionMode: 'allPlatforms', plannedPresentationVersion: 2, supportsRegularTimetable: true };
  const initial = (sourceID, offset) => {
    const timing = { observedAt: now - 15000, expiresAt: now + 75000 };
    const event = { ...record, sourceID, ...timing, id: sourceID + '-working', receivedAt: timing.observedAt,
      time: now + offset, destinationStationID: '940GZZLUBKG', destination: 'Barking',
      kind: 'outgoingDeparture', timeEvidence: 'scheduledDeparture', platform: null, direction: null, via: null };
    return { ...timing, events: [event] };
  };
  const previous = { sources: {
    'regular-timetable': initial('regular-timetable', 120000),
    'journey-planner': initial('journey-planner', 420000)
  } };
  const requests = [];
  const fetch = async url => {
    const endpoint = new URL(url).pathname;
    requests.push(endpoint);
    if (endpoint.endsWith('/Status')) return new Response(JSON.stringify(status), { headers: {
      Date: new Date(now).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=30' } });
    return new Response(null, { status: 503 });
  };
  const cache = await refreshStationBoard(board, previous, loadConfig({}), fetch, now, null);
  const offered = buildStationBoardState(board, cache, now).arrivals;
  assert.deepEqual(offered.map(row => row.plannedSourceID), ['journey-planner']);
  assert.equal(cache.rejections.find(r => r.reason === 'regularSourceWithdrawn')?.regularWithdrawalUntil, now + 30000);
  assert.equal(requests.filter(p => p.includes('/Timetable/')).length, 0);
});
