import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadConfig } from '../server/live-activity.js';
import { buildStationBoardState, journeyURL, parseJourney, refreshStationBoard, validBoard } from '../server/station-board-v2.js';

// Reduced originals retain the HTTP qualification fields, ordered calling
// stops, route and disruption evidence. Each capture records its raw-body hash.
const captures = JSON.parse(fs.readFileSync(new URL('./fixtures/edgware-nearby-journey-20261121.json', import.meta.url)));
const { lines } = JSON.parse(fs.readFileSync(new URL('../contracts/station-board-regular-origins-v1.json', import.meta.url)));
const board = { stationID: '940GZZLUEGW', lineID: 'northern', selectionMode: 'allPlatforms',
  contentStateContract: 'station-board-v2', plannedPresentationVersion: 2, supportsRegularTimetable: true };
const config = loadConfig({});
const at = Date.parse(captures.original2348.requestedAt);
const near = '/Journey/JourneyResults/940GZZLUEGW/to/940GZZLUBTK';
const far = '/Journey/JourneyResults/940GZZLUEGW/to/940GZZLUMDN';
const ordinary = '/Line/northern/Timetable/940GZZLUEGW';
const reply = (body, headers) => new Response(JSON.stringify(body), { headers });

test('only certified common enquiries change the existing explicit and ambiguous route rules', () => {
  for (const [lineID, line] of Object.entries(lines)) {
    for (const [stationID, target] of Object.entries(line.commonJourneyTargets)) {
      assert.ok(line.physicalEnds.includes(stationID));
      assert.ok(validBoard(stationID, lineID) && validBoard(target, lineID));
      assert.notEqual(stationID, target);
    }
  }
  for (const [lineID, stationID, target, via] of [
    ['northern', '940GZZLUEGW', '940GZZLUBTK'], // Edgware – Burnt Oak
    ['central', '940GZZLUEPG', '940GZZLUTHB'], // Epping – Theydon Bois
    ['jubilee', '940GZZLUSTD', '940GZZLUWHM'], // Stratford – West Ham
    ['district', '940GZZLUERC', '940GZZLUWIM', null], // Edgware Road keeps its Wimbledon narrow rule
    ['circle', '940GZZLUERC', '940GZZLUHSC'], // Two directions at the mixed station are not a common stop
    ['circle', '940GZZLUVIC', '940GZZLUHSC', '940GZZLUNHG'],
    ['hammersmith-city', '940GZZLUHSC', '940GZZLUBKG', '940GZZLUSBM'],
    ['metropolitan', '940GZZLUAMS', '940GZZLUALD'], // Partial atlas hint cannot certify a common stop
  ]) {
    const url = journeyURL({ ...board, lineID, stationID }, at);
    assert.equal(url.pathname, `/Journey/JourneyResults/${stationID}/to/${target}`);
    assert.equal(url.searchParams.get('includeAlternativeRoutes'), via === undefined ? 'true' : 'false');
    assert.equal(url.searchParams.get('journeyPreference'), via === undefined ? null : 'leastinterchange');
    assert.equal(url.searchParams.get('via'), via ?? null);
    assert.equal(url.searchParams.get('maxWalkingMinutes'), via ? '0' : null);
  }
  assert.equal(journeyURL({ ...board, selectionMode: 'platform', platformID: 'inbound' }, at).pathname, far);
  assert.equal(journeyURL(board, at + 120000, at).pathname, far);
  assert.equal(journeyURL({ ...board, stationID: 'unknown' }, at), null);
  assert.equal(journeyURL({ ...board, lineID: 'unknown' }, at), null);
});

test('real Edgware boarding legs recover the first Morden without inferring destinations from the query', () => {
  assert.equal(journeyURL(board, at).href, captures.original2348.source);
  const original = parseJourney(captures.original2348.body, board, captures.original2348.originalHeaders,
    at, Date.parse(captures.original2348.receivedAt));
  assert.deepEqual(original.map(e => [e.time, e.destination, e.via, e.nextScheduledStopID]), [
    [Date.parse('2026-11-21T23:51:00Z'), 'Morden', 'Charing Cross', '940GZZLUBTK'],
    [Date.parse('2026-11-21T23:56:00Z'), 'Morden', 'Bank', '940GZZLUBTK'],
    [Date.parse('2026-11-22T00:01:00Z'), 'Morden', 'Charing Cross', '940GZZLUBTK'],
  ]);
  assert.ok(original.every(e => e.expiresAt === Date.parse('2026-11-21T23:49:07Z')));

  const requested = Date.parse(captures.near2358.requestedAt);
  assert.equal(journeyURL(board, requested).href, captures.near2358.source);
  for (const offset of [1000, 10000]) { // The paired capture records dispatch but no completion timestamp.
    const parse = (capture) => parseJourney(capture.body, board, capture.originalHeaders, requested, requested + offset);
    assert.deepEqual(parse(captures.near2358).map(e => [e.time, e.destination, e.via]), [
      [Date.parse('2026-11-22T00:01:00Z'), 'Morden', 'Charing Cross'],
      [Date.parse('2026-11-22T00:06:00Z'), 'Golders Green', null],
      [Date.parse('2026-11-22T00:15:00Z'), 'Morden', 'Charing Cross'],
    ]);
    assert.deepEqual(parse(captures.far2358).map(e => [e.time, e.destination]), [
      [Date.parse('2026-11-22T00:06:00Z'), 'Golders Green'],
    ]);
  }
});

test('the closer enquiry still rejects a blocked segment, wrong origin or missing headsign', () => {
  const original = captures.original2348;
  for (const change of [
    leg => { leg.isDisrupted = true; leg.disruptions = [{ category: 'PlannedWork' }]; },
    leg => { leg.plannedWorks = [{}]; },
    leg => { leg.departurePoint.naptanId = '940GZZLUBTK'; },
    leg => { leg.path.stopPoints = [{ id: 'unknown' }]; },
    leg => { leg.routeOptions[0].lineIdentifier.id = 'central'; },
    leg => { delete leg.routeOptions[0].directions; },
    leg => { leg.serviceStatus = 'Withdrawn'; },
  ]) {
    const body = structuredClone(original.body);
    change(body.journeys[0].legs[0]);
    const result = parseJourney(body, board, original.originalHeaders, at, Date.parse(original.receivedAt));
    assert.deepEqual(result.map(e => e.time), [Date.parse('2026-11-21T23:56:00Z'), Date.parse('2026-11-22T00:01:00Z')]);
  }
});

test('compatible Activity registrations share one nearby read and separate platform queries stay single', async () => {
  const received = Date.parse(captures.original2348.receivedAt);
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === near) return reply(captures.original2348.body, captures.original2348.originalHeaders);
    return new Response(null, { status: 503 });
  };
  const shared = new Map();
  const run = registration => refreshStationBoard(registration, {}, config, fetchImpl, at, undefined, () => received, shared);
  const modern = await run(board);
  const legacy = await run({ ...board, supportsRegularTimetable: undefined });
  await run({ ...board, selectionMode: 'platform', platformID: 'inbound' });
  await run({ ...board, selectionMode: 'platform', platformID: 'outbound' });
  assert.deepEqual(paths.filter(p => p.startsWith('/Journey/')), [near, far]);
  assert.equal(paths.filter(p => p === ordinary).length, 1, 'existing short-lived Journey fallback is shared and bounded');
  for (const [registration, cache] of [[board, modern], [{ ...board, supportsRegularTimetable: undefined }, legacy]]) {
    const state = buildStationBoardState(registration, cache, received);
    assert.deepEqual(state.arrivals.map(r => [r.destination, r.via]), [
      ['Morden', 'Charing Cross'], ['Morden', 'Bank'], ['Morden', 'Charing Cross'],
    ]);
  }
});

test('the worker sends the first qualified departure from the paired capture', async () => {
  const requested = Date.parse(captures.near2358.requestedAt);
  const received = requested + 1000;
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === near) return reply(captures.near2358.body, captures.near2358.originalHeaders);
    return new Response(null, { status: 503 });
  };
  const cache = await refreshStationBoard(board, {}, config, fetchImpl, requested, undefined, () => received);
  assert.deepEqual(paths.filter(p => p.startsWith('/Journey/')), [near]);
  assert.equal(paths.filter(p => p === ordinary).length, 1);
  const state = buildStationBoardState(board, cache, received);
  assert.deepEqual(state.arrivals.map(r => r.destination), ['Morden', 'Golders Green', 'Morden']);
  assert.equal(state.arrivals[0].expectedArrival * 1000 + 978307200000, Date.parse('2026-11-22T00:01:00Z'));
});

test('scope closures suppress any Journey request and a proved near-leg withdrawal still blocks ordinary fallback', async () => {
  const headers = captures.original2348.originalHeaders;
  const received = Date.parse(captures.original2348.receivedAt);
  const window = { fromDate: new Date(at - 60000).toISOString(), toDate: new Date(at + 120000).toISOString() };
  for (const kind of ['station', 'line', 'withdrawal']) {
    const paths = [];
    const fetchImpl = async (url) => {
      paths.push(url.pathname);
      if (kind === 'station' && url.pathname.endsWith('/Disruption')) {
        return reply([{ stationAtcoCode: board.stationID, type: 'Closure', ...window }], headers);
      }
      if (kind === 'line' && url.pathname.endsWith('/Status')) {
        return reply([{ id: board.lineID, lineStatuses: [{ statusSeverity: 16, statusSeverityDescription: 'Suspended',
          validityPeriods: [window] }] }], headers);
      }
      if (kind === 'withdrawal' && url.pathname === near) {
        const body = structuredClone(captures.original2348.body);
        body.journeys[0].legs[0].isCancelled = true;
        return reply(body, headers);
      }
      return new Response(null, { status: 503 });
    };
    const cache = await refreshStationBoard(board, {}, config, fetchImpl, at, undefined, () => received);
    assert.deepEqual(paths.filter(p => p.startsWith('/Journey/')), kind === 'withdrawal' ? [near] : []);
    assert.ok(!paths.includes(ordinary));
    if (kind === 'withdrawal') {
      assert.ok(cache.rejections.some(r => r.reason === 'regularSourceWithdrawn'
        && r.regularWithdrawalUntil === Date.parse('2026-11-21T23:51:00Z')));
      assert.equal(cache.sources['journey-planner'].events[0].time, Date.parse('2026-11-21T23:56:00Z'));
    } else {
      assert.equal(cache.sources['journey-planner'], undefined);
    }
  }
});
