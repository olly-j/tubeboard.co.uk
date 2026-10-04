import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeContexts, selectEvents, nextBoundary, buildStationBoardState, refreshStationBoard, compactPlanningSource, londonClock, STATION_BOARD_LINES } from '../server/station-board-v2.js';
import { retainAvailability, activeClosure, expiredBarrier, blocksScheduled, qualifyAvailability, knownNonClosure } from '../server/station-board-availability.js';
import { admitPlannedSeed } from '../server/station-board-seed.js';
import { LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, buildApnsPayload } from '../server/live-activity.js';
const now = Date.parse('2026-10-01T13:00:00Z'), at = (s) => now + s * 1000;
const record = { activityID: 'synthetic-future', installID: 'synthetic-install', stationID: '940GZZLUEGW', lineID: 'northern', selectionMode: 'allPlatforms', pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1', buildNumber: '1', environment: 'sandbox', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2 };
const proof = (obs = 0, exp = 30, start = 60, end = 180, extra = {}) => ({ stationID: record.stationID, lineID: record.lineID, sourceScope: 'stationDisruptions', observedAt: at(obs), expiresAt: at(exp), closed: true, closureWindows: [{ validFrom: at(start), validUntil: at(end) }], ...extra });
const event = (id, time = 100, obs = 0, exp = 600, extra = {}) => ({ id, stationID: record.stationID, lineID: record.lineID, sourceID: 'timetable', kind: 'outgoingDeparture', destination: 'Morden', destinationStationID: '940GZZLUMDN', time: at(time), timeEvidence: 'scheduledDeparture', receivedAt: at(obs), expiresAt: at(exp), ...extra });
const context = (...events) => ({ sources: Object.fromEntries([...new Set(events.map((e) => e.sourceID))].map((source) => [source, { observedAt: Math.max(...events.filter((e) => e.sourceID === source).map((e) => e.receivedAt)), events: events.filter((e) => e.sourceID === source) }])) });
const cache = (events, proofs) => ({ ...context(...events), availabilityProofs: proofs });
const live = (id = 'live') => event(id, 400, 20, 620, { sourceID: 'rail-departures', timeEvidence: 'predictedDeparture' });
function wireSeed(proofs) { return { schemaVersion: 1, stationID: record.stationID, lineID: record.lineID, contexts: [], closureEvidence: proofs.map((p) => ({ ...p, observedAt: new Date(p.observedAt).toISOString(), expiresAt: new Date(p.expiresAt).toISOString(), ...(p.closureWindows ? { closureWindows: p.closureWindows.map((w) => ({ validFrom: new Date(w.validFrom).toISOString(), validUntil: new Date(w.validUntil).toISOString() })) } : {}) })) }; }
function rawClosure(start, end, extra = {}) { return { stationAtcoCode: record.stationID, type: 'Closure', fromDate: new Date(at(start)).toISOString(), toDate: new Date(at(end)).toISOString(), ...extra }; }
function renderedIDs(state, clock) {
  const apple = 978307200000;
  const proofs = state.plannedAvailability?.proofs.map((p) => ({ ...p, observedAt: p.observedAt * 1000 + apple, expiresAt: p.expiresAt * 1000 + apple, closureWindows: p.closureWindows?.map((w) => ({ validFrom: w.validFrom * 1000 + apple, validUntil: w.validUntil * 1000 + apple })) })) || [];
  let rows = state.arrivals.filter((e) => e.expiresAt * 1000 + apple > clock && (e.expectedArrival === null || e.expectedArrival * 1000 + apple >= clock) && (e.timeEvidence !== 'scheduledDeparture' || !retainAvailability({ availabilityProofs: proofs }, {}, record, clock).some((p) => blocksScheduled(p, e.expectedArrival * 1000 + apple, clock))));
  const selected = compactPlanningSource(rows.map((r) => ({ kind: 'outgoingDeparture', timeEvidence: r.timeEvidence, sourceID: r.plannedSourceID, time: r.expectedArrival * 1000 + apple })));
  rows = rows.filter((r) => r.timeEvidence !== 'scheduledDeparture' || !['timetable', 'journey-planner', 'rail-departures'].includes(r.plannedSourceID) || r.plannedSourceID === selected);
  return rows.slice(0, 3).map((r) => r.id);
}

test('exact future announcement outside HTTP authority preserves preclosure clocks and own target mask', () => {
  const p = proof(), events = [event('early', 20), event('next', 40), event('inside', 100), event('later', 200), event('predicted', 100, 0, 600, { sourceID: 'rail-departures', timeEvidence: 'predictedDeparture' })];
  const original = cache(events, [p]), state = buildStationBoardState(record, original, at(1));
  for (const offset of [1, 29, 31, 59, 60, 70]) { assert.equal(activeClosure(p, at(offset)), false); const rows = selectEvents(original, record, at(offset)); assert.equal(rows.some((e) => e.id === 'inside'), false); assert.equal(rows.some((e) => e.id === 'later'), offset < 60); assert.equal(rows.some((e) => e.id === 'predicted'), true); assert.equal(renderedIDs(state, at(offset)).includes('inside'), false); }
  assert.equal(selectEvents(original, record, at(1)).filter((e) => e.sourceID === 'timetable').length, 3);
  assert.equal(nextBoundary(original, record, at(41)), at(60));
  assert.equal(expiredBarrier(p, at(181)), true);
  assert.equal(p.expiresAt, at(30));
});

test('own-clock masked prefixes cannot crowd useful fourth schedule or later known gap from Activity', () => {
  const state = buildStationBoardState(record, cache([event('A', 100), event('B', 110), event('C', 120), event('useful', 250)], [proof()]), at(1));
  assert.equal(state.arrivals.length, 3); assert.deepEqual(renderedIDs(state, at(1)), ['useful']);
  const p = proof(0, 20, 10, 20), original = event('gap', 35), during = buildStationBoardState(record, cache([original], [p]), at(15));
  assert.deepEqual(renderedIDs(during, at(15)), []); assert.deepEqual(renderedIDs(during, at(20)), ['gap']); assert.equal(during.arrivals[0].expiresAt * 1000 + 978307200000, original.expiresAt);
});

test('dormant future proof survives age600 through its unchanged original cutoff and cache-only activation', () => {
  const p = proof(0, 120, 710, 900), plan = event('late', 1020, 119, 719), original = cache([plan], [p]);
  const state = buildStationBoardState(record, original, at(600)); assert.equal(state.staleAt * 1000 + 978307200000, at(710)); assert.equal(nextBoundary(original, record, at(709.5)), at(710));
  for (const [offset, visible] of [[600, true], [709, true], [710, false], [719, false], [720, false]]) { const c = mergeContexts(original, {}, record, at(offset)); assert.equal(selectEvents(c, record, at(offset)).length > 0, visible); assert.equal(renderedIDs(state, at(offset)).length > 0, visible); assert.equal(c.availabilityProofs.length > 0, offset < 720); }
  const admitted = admitPlannedSeed(wireSeed([p]), record, at(600)); assert.deepEqual(admitted.errors, []); assert.deepEqual(admitted.availabilityProofs[0].closureWindows, p.closureWindows);
  const distant = qualifyAvailability([rawClosure(720, 900)], record, 'stationDisruptions', { observedAt: now, expiresAt: at(120) }, now, londonClock); assert.deepEqual(distant, []);
});

for (const reverse of [false, true]) test(`independent original active and pending proofs protect later plans in both orders=${reverse}`, () => {
  const old = proof(), pending = proof(40, 70, 100, 180), plan = event('later-context', 780, 65, 665), proofs = reverse ? [pending, old] : [old, pending];
  for (const [offset, count] of [[80, 2], [100, 1], [630, 1], [664.999, 1], [665, 1]]) { const c = mergeContexts(cache([plan, event('predicted', 780, 65, 665, { sourceID: 'rail-departures', timeEvidence: 'predictedDeparture' })], proofs), {}, record, at(offset)); assert.equal(c.availabilityProofs.length, count); assert.ok(c.availabilityProofs.some((p) => p.observedAt === pending.observedAt)); assert.equal(c.sources.timetable !== undefined, offset < 665); assert.equal(selectEvents(c, record, at(offset)).some((e) => e.id === plan.id), false); assert.equal(renderedIDs(buildStationBoardState(record, c, at(offset)), at(offset)).includes(plan.id), false); }
  const expiredOpen = proof(75, 79, 100, 180, { closed: false, closureWindows: undefined }); assert.equal(retainAvailability({ availabilityProofs: proofs }, { availabilityProofs: [expiredOpen] }, record, at(80)).length, 2);
  const open = proof(81, 120, 100, 180, { closed: false, closureWindows: undefined }); const recovered = mergeContexts(cache([plan], proofs), { availabilityProofs: [open] }, record, at(81)); assert.deepEqual(selectEvents(recovered, record, at(81)), [plan]);
});

test('expired newer closed or open evidence cannot clear protected historical eligibility', () => {
  const old = proof(0, 30, 20, 60), expired = proof(40, 70, 50, 70), plan = event('old', 200, 0, 600);
  for (const incoming of [expired, { ...expired, closed: false, closureWindows: undefined }]) { const c = mergeContexts(cache([plan], [old]), { availabilityProofs: [incoming] }, record, at(80)); assert.ok(c.availabilityProofs.some((p) => p.observedAt === now)); assert.deepEqual(selectEvents(c, record, at(80)), []); }
});

test('eight original proofs and overflow disposition preserve scoped clocks and useful live rows', () => {
  const p = Array.from({ length: 9 }, (_, i) => proof(i, i + 30, i + 100, 300)), plan = event('plan', 400, 20, 620), raw = cache([plan, live()], p);
  const c = mergeContexts(raw, {}, record, at(50)); assert.equal(c.availabilityProofs.length, 1); assert.equal(c.availabilityProofs[0].plannedUnavailable, true); assert.equal(c.availabilityProofs[0].closed, false); assert.equal(c.availabilityProofs[0].observedAt, at(8)); assert.equal(c.availabilityProofs[0].expiresAt, at(38)); assert.equal(c.sources.timetable, undefined); assert.deepEqual(selectEvents(c, record, at(50)).map((e) => e.id), ['live']);
  const open = proof(51, 100, 120, 180, { closed: false, closureWindows: undefined }); assert.equal(retainAvailability(c, { availabilityProofs: [open] }, record, at(101))[0].plannedUnavailable, true); assert.equal(retainAvailability(c, { availabilityProofs: [open] }, record, at(51))[0].closed, false);
  assert.deepEqual(admitPlannedSeed(wireSeed(p.slice(0, 8)), record, at(50)).errors, []); assert.ok(admitPlannedSeed(wireSeed(p), record, at(50)).errors.length);
});

test('maximum original proof payload fallback preserves three live rows and full APNs stays bounded', () => {
  const p = Array.from({ length: 8 }, (_, i) => ({ ...proof(i, i + 30), closureWindows: Array.from({ length: 32 }, (_, j) => ({ validFrom: at(100 + j * 3), validUntil: at(101 + j * 3) })) }));
  const rows = [event('A', 400, 20, 620), event('B', 401, 20, 620), event('C', 402, 20, 620), live('live-A'), live('live-B'), live('live-C')];
  const state = buildStationBoardState(record, cache(rows, p), at(50)); assert.equal(state.plannedAvailability, undefined); assert.deepEqual(state.arrivals.map((e) => e.id), ['live-A', 'live-B', 'live-C']);
  const payload = buildApnsPayload(state, new Date(at(50))); assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 4096); assert.ok(state.arrivals.every((r) => r.expiresAt * 1000 + 978307200000 === at(620)));
  const huge = buildStationBoardState(record, { ...cache([live()], []), status: { label: 'Minor Delays', reason: 'x'.repeat(6000), expiresAt: at(120) } }, at(50)); assert.equal(huge.statusReason, null); assert.equal(huge.arrivals.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(huge, new Date(at(50))))) <= 4096);
});

test('all19 availability scopes reject restricted/unknown status without renewing original authority', () => {
  for (const [id, line] of STATION_BOARD_LINES) { const r = { stationID: line.boundedOriginID, lineID: id }, observation = { observedAt: now, expiresAt: at(30) }; for (const [severity, label] of [[10, 'Good Service'], [9, 'Minor Delays'], [6, 'Severe Delays'], [7, 'Reduced Service']]) { const value = [{ id, lineStatuses: [{ statusSeverity: severity, statusSeverityDescription: label }] }]; const p = qualifyAvailability(value, r, 'lineStatus', observation, now, londonClock)[0]; assert.equal(p.closed, false); assert.equal(p.expiresAt, at(30)); } }
  assert.equal(knownNonClosure({ statusSeverity: 5, statusSeverityDescription: 'Part Closure' }), false); assert.equal(knownNonClosure({ statusSeverity: 8, statusSeverityDescription: 'Bus Service' }), false);
  const restricted = [{ id: record.lineID, lineStatuses: [{ statusSeverity: 2, statusSeverityDescription: 'Suspended', validityPeriods: [rawClosure(60, 180)], disruption: { affectedRoutes: [{ direction: 'Inbound', isEntireRouteSection: false }] } }] }]; assert.deepEqual(qualifyAvailability(restricted, record, 'lineStatus', { observedAt: now, expiresAt: at(30) }, now, londonClock), []);
  assert.deepEqual(qualifyAvailability([rawClosure(60, 180, { concernedLines: [{ id: 'central' }] })], record, 'stationDisruptions', { observedAt: now, expiresAt: at(30) }, now, londonClock), []);
});

test('temporary closure refresh and transactional restart restore original plans in gap with zero extra HTTP', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-future-mirror-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'records.json'), store = new LiveActivityStore(file); await store.upsertToken(record, new Date(now));
  const original = event('gap', 35), p = proof(0, 20, 10, 20);
  // Synthetic previously client-qualified context: original publication/HEAD
  // evidence is required by authority admission, separate from closure clocks.
  const originalCache = cache([original, event('predicted', 40, 0, 600, { sourceID: 'rail-departures', timeEvidence: 'predictedDeparture' })], []);
  originalCache.sources.timetable.evidence = { publication: { url: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip', sha256: 'a'.repeat(64) }, independentPublicationObservedAt: now };
  originalCache.sources.timetable.qualificationOrigin = 'client';
  await store.retainStationBoard(record.activityID, record.environment, originalCache, new Date(now));
  let reads = 0; const headRequests = [];
  const feedPaths = [`/StopPoint/${record.stationID}/Arrivals`, `/Line/${record.lineID}/Status`, `/StopPoint/${record.stationID}/Disruption`, `/Line/${record.lineID}/Arrivals`], requestedFeedPaths = [];
  const publicationURL = originalCache.sources.timetable.evidence.publication.url;
  const fetchImpl = async (url, options) => {
    const headers = { date: new Date(now).toUTCString(), age: '0', 'cache-control': 'public,max-age=30' };
    if (options.method === 'HEAD') {
      const requested = new URL(url); const nonce = requested.searchParams.get('tb085'); assert.equal(requested.searchParams.getAll('tb085').length, 1); assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i); requested.searchParams.delete('tb085'); assert.equal(requested.href, publicationURL); headRequests.push({ url: requested.href, method: options.method });
      return new Response(null, { headers: { ...headers, 'x-amz-meta-sha256': originalCache.sources.timetable.evidence.publication.sha256 } });
    }
    reads++; assert.equal(options.method || 'GET', 'GET'); const pathname = new URL(url).pathname;
    assert.ok(feedPaths.includes(pathname)); requestedFeedPaths.push(pathname);
    const values = pathname.endsWith('/Disruption') ? [rawClosure(10, 20)] : [];
    return new Response(JSON.stringify(values), { headers });
  };
  const read = await refreshStationBoard(record, store.state.records[0].stationBoardCache, loadConfig({}), fetchImpl, at(15), null); assert.equal(read.rejections.length, 0); assert.equal(read.sources.timetable.events[0].time, original.time); assert.equal(read.availabilityProofs[0].expiresAt, p.expiresAt); await store.retainStationBoard(record.activityID, record.environment, read, new Date(at(15)));
  assert.deepEqual(headRequests, [{ url: publicationURL, method: 'HEAD' }]); assert.equal(read.publicationIdentity.sha256, originalCache.sources.timetable.evidence.publication.sha256); assert.deepEqual(requestedFeedPaths.sort(), feedPaths.sort());
  const restarted = new LiveActivityStore(file), pushes = []; await runLiveActivityWorkerCycle({ store: restarted, config: loadConfig({}), cacheOnly: true, now: new Date(at(20)), clock: () => at(20), fetchImpl: async () => { reads++; throw Error('No reads at boundary'); }, pushImpl: async (_, payload) => pushes.push(payload), logger: { info() {}, warn() {} } }); assert.equal(reads, 4); assert.ok(pushes[0].aps['content-state'].arrivals.some((r) => r.id === original.id)); assert.equal(restarted.state.records[0].stationBoardCache.sources.timetable.events[0].expiresAt, original.expiresAt);
  const changed = mergeContexts(read, { rejections: [{ stationID: record.stationID, lineID: record.lineID, observedAt: at(16), reason: 'publicationChanged' }] }, record, at(20)); assert.equal(changed.sources.timetable, undefined); assert.ok(changed.sources['rail-departures']);
});

test('seed explicit malformed and foreign availability cannot establish a new scoped clear', () => {
  const original = wireSeed([proof()]);
  for (const mutate of [(p) => { p.stationID = '940GZZLUMDN'; }, (p) => { p.sourceScope = 'unknown'; }, (p) => { p.closureWindows[0].validFrom = 'invalid'; }, (p) => { p.closed = false; p.closureWindows[0].validUntil = 'invalid'; }, (p) => { p.expiresAt = new Date(at(121)).toISOString(); }]) { const seed = structuredClone(original); mutate(seed.closureEvidence[0]); assert.ok(admitPlannedSeed(seed, record, at(1)).errors.length); }
  const legacy = wireSeed([proof()]); delete legacy.closureEvidence[0].closureWindows; legacy.closureEvidence[0].validFrom = new Date(at(60)).toISOString(); legacy.closureEvidence[0].validUntil = new Date(at(180)).toISOString(); assert.deepEqual(admitPlannedSeed(legacy, record, at(1)).errors, []);
  assert.deepEqual(admitPlannedSeed({ schemaVersion: 1, stationID: record.stationID, lineID: record.lineID, contexts: [] }, record, now).errors, []);
});

test('identical original scoped evidence reduces independent of object key order and qualification origin', () => {
  const original = Array.from({ length: 8 }, (_, i) => proof(i, i + 30, i + 100, 300));
  const copies = original.map((p) => ({ qualificationOrigin: 'server', closureWindows: p.closureWindows, closed: p.closed, expiresAt: p.expiresAt, observedAt: p.observedAt, sourceScope: p.sourceScope, lineID: p.lineID, stationID: p.stationID }));
  const retained = retainAvailability({ availabilityProofs: original }, { availabilityProofs: copies }, record, at(50));
  assert.equal(retained.length, 8); assert.ok(retained.every((p) => p.plannedUnavailable !== true)); assert.deepEqual(retained.map((p) => p.expiresAt), original.map((p) => p.expiresAt));
});

test('masked original timetable context cannot suppress useful planner companion in Activity', () => {
  const tt = [100, 110, 120].map((t, i) => event(`TT-${i}`, t, 20, 620)), jp = event('JP', 250, 20, 140, { sourceID: 'journey-planner' });
  for (const originals of [[...tt, jp], [jp, ...tt].reverse()]) {
    const original = cache(originals, [proof()]), state = buildStationBoardState(record, original, at(50));
    assert.deepEqual(selectEvents(original, record, at(50)).map((e) => e.id), ['JP']);
    assert.equal(state.arrivals.length, 4); assert.deepEqual(renderedIDs(JSON.parse(JSON.stringify(state)), at(50)), ['JP']);
    assert.deepEqual(state.arrivals.filter((r) => r.plannedSourceID === 'timetable').map((r) => r.id), tt.map((e) => e.id));
    assert.equal(state.arrivals.find((r) => r.id === 'JP').expiresAt * 1000 + 978307200000, jp.expiresAt);
    assert.deepEqual(renderedIDs(state, at(60)), []); // historical whole-board restriction
    const partial = buildStationBoardState(record, cache([...tt, event('TT-useful', 240, 20, 620), jp], [proof()]), at(50));
    assert.deepEqual(renderedIDs(partial, at(50)), ['TT-useful']);
    const empty = buildStationBoardState(record, cache([...tt, { ...jp, time: at(130) }], [proof()]), at(50));
    assert.equal(empty.arrivals.length, 4); assert.deepEqual(renderedIDs(empty, at(50)), []);
  }
});

test('eligible timetable is one selected context while original planner survives timetable expiry without overlay', () => {
  const tt = [200, 210, 220].map((t, i) => event(`TT-${i}`, t, 0, 60)), jp = event('JP', 250, 20, 140, { sourceID: 'journey-planner' });
  const state = buildStationBoardState(record, context(...tt, jp), at(50));
  assert.equal(state.plannedAvailability, undefined); assert.equal(state.arrivals.length, 4);
  assert.deepEqual(renderedIDs(state, at(50)), ['TT-0', 'TT-1', 'TT-2']);
  assert.deepEqual(renderedIDs(state, at(60)), ['JP']); assert.deepEqual(renderedIDs(state, at(139.999)), ['JP']); assert.deepEqual(renderedIDs(state, at(140)), []);
  assert.deepEqual(state.arrivals.map((r) => r.expiresAt * 1000 + 978307200000), [at(60), at(60), at(60), at(140)]);
  const expired = buildStationBoardState(record, context(...tt, { ...jp, expiresAt: at(49) }), at(50));
  assert.equal(expired.arrivals.length, 3); assert.deepEqual(renderedIDs(expired, at(60)), []);
});

test('known gap and qualified fresh recovery choose one original context without concatenation', () => {
  const tt = event('TT-gap', 35), jp = event('JP-gap', 40, 0, 120, { sourceID: 'journey-planner' }), p = proof(0, 20, 10, 20);
  const original = cache([tt, jp], [p]), state = buildStationBoardState(record, original, at(15));
  assert.deepEqual(renderedIDs(state, at(15)), []); assert.deepEqual(renderedIDs(state, at(20)), ['TT-gap']);
  const protectedCache = cache([event('TT', 250, 20, 620), event('JP', 260, 20, 140, { sourceID: 'journey-planner' })], [proof()]);
  const recovered = mergeContexts(protectedCache, { availabilityProofs: [proof(81, 120, 60, 180, { closed: false, closureWindows: undefined })] }, record, at(81));
  assert.deepEqual(renderedIDs(buildStationBoardState(record, recovered, at(81)), at(81)), ['TT']);
  assert.equal(recovered.sources.timetable.events[0].receivedAt, at(20)); assert.equal(recovered.sources['journey-planner'].events[0].expiresAt, at(140));
});

test('actual selection eligibility precedes planned source preference and source input order is stable', () => {
  const tt = event('TT', 250), jp = event('JP', 260, 20, 140, { sourceID: 'journey-planner', providerDirection: 'Outbound' });
  const chosen = { ...record, selectionMode: 'platform', platformDirection: 'Outbound', platformHeading: 'Outbound' };
  for (const originals of [[tt, jp], [jp, tt]]) {
    const c = context(...originals), state = buildStationBoardState(chosen, c, at(50));
    assert.deepEqual(state.arrivals.map((r) => r.id), ['JP']); assert.deepEqual(renderedIDs(state, at(50)), ['JP']);
    assert.deepEqual(buildStationBoardState({ ...chosen, platformLabel: 'Platform 2' }, c, at(50)).arrivals, []);
  }
});

test('nine original source rows keep useful alternatives and optional provenance survives JSON while legacy and rail stay independent', () => {
  const tt = [200, 210, 220].map((t, i) => event(`TT-${i}`, t, 0, 60)), jp = [230, 240, 250].map((t, i) => event(`JP-${i}`, t, 20, 140, { sourceID: 'journey-planner' })), others = [live('live-A'), live('live-B'), live('live-C')];
  const state = JSON.parse(JSON.stringify(buildStationBoardState(record, context(...tt, ...jp, ...others), at(50))));
  assert.equal(state.arrivals.length, 9); assert.deepEqual(renderedIDs(state, at(50)), ['TT-0', 'TT-1', 'TT-2']); assert.deepEqual(renderedIDs(state, at(60)), ['JP-0', 'JP-1', 'JP-2']);
  assert.ok(state.arrivals.filter((r) => r.timeEvidence === 'estimatedDeparture').every((r) => !Object.hasOwn(r, 'plannedSourceID')));
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 3500); assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(state, new Date(at(50))))) <= 4096);
  const legacy = { arrivals: state.arrivals.slice(0, 4).map(({ plannedSourceID, ...r }) => r) };
  assert.deepEqual(renderedIDs(legacy, at(50)), ['TT-0', 'TT-1', 'TT-2']); assert.deepEqual(renderedIDs(legacy, at(60)), ['JP-0']);
  const rail = event('rail-plan', 230, 20, 140, { sourceID: 'rail-departures' });
  const independent = buildStationBoardState(record, cache([event('TT', 250), rail, live()], [proof(0, 30, 10, 20)]), at(21));
  assert.equal(independent.arrivals.find((r) => r.id === rail.id).plannedSourceID, 'rail-departures'); assert.deepEqual(renderedIDs(independent, at(21)), ['rail-plan', 'live']);
});

test('independent raw group prioritizes useful live rows before masked rail schedules and overflow preserves original live context', () => {
  const rail = [100, 110, 120].map((t, i) => event(`rail-${i}`, t, 20, 620, { sourceID: 'rail-departures' }));
  const original = cache([...rail, live('live-A'), live('live-B'), live('live-C')], [proof()]);
  const state = buildStationBoardState(record, original, at(50)); assert.deepEqual(state.arrivals.map((r) => r.id), ['rail-0', 'rail-1', 'rail-2', 'live-A', 'live-B', 'live-C']); assert.deepEqual(renderedIDs(state, at(50)), ['live-A', 'live-B', 'live-C']);
  const long = context(event('TT', 250, 0, 600, { destination: 'x'.repeat(3000) }), event('JP', 260, 20, 140, { sourceID: 'journey-planner' }), ...rail, live('live-A'), live('live-B'), live('live-C'));
  const fallback = buildStationBoardState(record, long, at(50)); assert.deepEqual(fallback.arrivals.map((r) => r.id), ['live-A', 'live-B', 'live-C']); assert.ok(fallback.arrivals.every((r) => r.timeEvidence === 'estimatedDeparture')); assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(fallback, new Date(at(50))))) <= 4096);
});
