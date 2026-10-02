import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { admitPlannedSeed } from '../server/station-board-seed.js';
import { LiveActivityStore, validateTokenPayload } from '../server/live-activity.js';
import { londonClock, mergeContexts, selectEvents } from '../server/station-board-v2.js';

// Byte-identical actual Swift encodings from reviewed APP published-member-date-r1.
// Retained original qualification clocks are replayed here; no current-source claim.
async function retainedSeed(mode = 'metropolitan') {
  return JSON.parse(await fs.readFile(new URL(`./fixtures/actual-swift-date-range-seed-${mode}.json`, import.meta.url), 'utf8'));
}
const board = (seed) => ({ stationID: seed.stationID, lineID: seed.lineID, selectionMode: 'allPlatforms' });
const observation = (seed) => Date.parse(seed.contexts[0].observedAt);
const token = (seed, at = observation(seed)) => ({ ...board(seed), contentStateContract: 'station-board-v2', activityID: 'synthetic-range-activity', installID: 'synthetic-range-install', pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(at).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.0', buildNumber: '1', environment: 'sandbox', plannedContextSeed: seed });
const invalid = (seed, mutate, at = observation(seed)) => { const copy = structuredClone(seed); mutate(copy); const read = admitPlannedSeed(copy, board(copy), at); assert.ok(read.errors.length, JSON.stringify(copy)); assert.equal(validateTokenPayload(token(copy, at), new Date(at)).ok, false); };
const range = (startDate = '2026-09-27', endDate = '2026-12-23') => ({ startDate, endDate });
function overnightSeed(seed, serviceDay, minute, at) {
  const copy = structuredClone(seed), row = copy.contexts[0].rows[0];
  copy.contexts[0].rows = [row];
  copy.contexts[0].observedAt = new Date(at).toISOString(); copy.contexts[0].expiresAt = new Date(at + 600000).toISOString();
  row.serviceDay = serviceDay; row.serviceMinute = minute; row.weekdays = [new Date(`${serviceDay}T12:00:00Z`).getUTCDay() + 1];
  row.id = `schedule:${copy.lineID}:${copy.stationID}:${serviceDay}:0:0:0`;
  const day = new Date(`${serviceDay}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + Math.floor(minute / 1440));
  const within = minute % 1440;
  row.departure = new Date(londonClock(`${day.toISOString().slice(0, 10)}T${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}:00`)).toISOString();
  row.originatingServiceDateRanges = [range()];
  return copy;
}

test('both exact Swift-encoded seeds pass full token and consumer admission without renewed dates or profile evidence', async () => {
  const expected = { metropolitan: '44688efa544e03d65f2ff9b75bdbbe9f0477dff21e2aa55c52e2abd704c3d1b0', victoria: '32f3c279a2e6808538fa7874c5abba6b4b441f6a3048fd75b84ff55884f80c96' };
  for (const mode of Object.keys(expected)) {
    const bytes = await fs.readFile(new URL(`./fixtures/actual-swift-date-range-seed-${mode}.json`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected[mode]);
    const seed = JSON.parse(bytes), at = observation(seed), read = admitPlannedSeed(seed, board(seed), at);
    assert.deepEqual(read.errors, []); assert.equal(validateTokenPayload(token(seed), new Date(at)).ok, true);
    assert.equal(read.sources.timetable.events.length, 32); assert.equal(read.sources.timetable.observedAt, at);
    assert.equal(read.sources.timetable.qualificationOrigin, 'client');
    for (const [index, row] of seed.contexts[0].rows.entries()) {
      const event = read.sources.timetable.events[index], evidence = read.sources.timetable.evidence.rows[index];
      assert.equal(event.time, Date.parse(row.departure)); assert.equal(event.expiresAt, Date.parse(seed.contexts[0].expiresAt)); assert.equal(event.platform, null);
      assert.equal(evidence.serviceDay, row.serviceDay); assert.equal(evidence.profileSHA256, row.profileSHA256); assert.deepEqual(evidence.originatingServiceDateRanges, row.originatingServiceDateRanges);
    }
  }
});

test('optional schema field is bounded and legacy absent ranges keep prior admission', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../contracts/live-activity-registration-v2.schema.json', import.meta.url)));
  const rows = schema.properties.plannedContextSeed.properties.contexts.items.properties.rows.items;
  const field = rows.properties.originatingServiceDateRanges;
  assert.equal(field.minItems, 1); assert.equal(field.maxItems, 32); assert.equal(field.items.additionalProperties, false); assert.deepEqual(field.items.required, ['startDate', 'endDate']); assert.equal(field.items.properties.startDate.format, 'date');
  const seed = await retainedSeed(); for (const row of seed.contexts[0].rows) delete row.originatingServiceDateRanges;
  const read = admitPlannedSeed(seed, board(seed), observation(seed)); assert.deepEqual(read.errors, []); assert.equal(read.sources.timetable.events.length, 32); assert.equal(Object.hasOwn(read.sources.timetable.evidence.rows[0], 'originatingServiceDateRanges'), false);
});

test('present-null empty malformed real dates unordered overlapping and unbounded ranges fail closed', async () => {
  const seed = await retainedSeed();
  for (const ranges of [null, [], {}, [range('2026-02-30')], [range('2026-9-27')], [range('2026-12-23', '2026-09-27')], [range('2026-09-26')], [range('2026-09-27', '2026-12-24')], [{ ...range(), unknown: true }], [{ startDate: '2026-09-27' }], [range(), range()], [range('2026-10-02', '2026-12-23'), range('2026-09-27', '2026-10-01')], Array.from({ length: 33 }, () => range())]) {
    invalid(seed, (s) => { s.contexts[0].rows[0].originatingServiceDateRanges = ranges; });
  }
});

test('explicit originating-date holes reject rather than qualify an empty missing day or borrow another profile', async () => {
  const seed = await retainedSeed();
  invalid(seed, (s) => { s.contexts[0].rows[0].originatingServiceDateRanges = [range('2026-09-27', '2026-10-01'), range('2026-10-03', '2026-12-23')]; });
  const tuesday = overnightSeed(seed, '2026-10-06', 1442, londonClock('2026-10-07T00:00:30'));
  invalid(tuesday, (s) => { s.contexts[0].rows[0].originatingServiceDateRanges = [range('2026-09-27', '2026-10-05'), range('2026-10-07', '2026-12-23')]; });
  const complete = admitPlannedSeed(tuesday, board(tuesday), observation(tuesday)); assert.deepEqual(complete.errors, []); assert.equal(complete.sources.timetable.evidence.rows[0].serviceDay, '2026-10-06');
});

test('24+ departure uses original weekday and range through London midnight; shifted service day and holiday claims fail', async () => {
  const seed = overnightSeed(await retainedSeed(), '2026-10-01', 1442, londonClock('2026-10-02T00:00:30'));
  seed.contexts[0].rows[0].originatingServiceDateRanges = [range('2026-10-01', '2026-10-01')];
  const valid = admitPlannedSeed(seed, board(seed), observation(seed)); assert.deepEqual(valid.errors, []); assert.equal(valid.sources.timetable.events[0].time, londonClock('2026-10-02T00:02:00')); assert.equal(valid.sources.timetable.evidence.rows[0].serviceMinute, 1442);
  invalid(seed, (s) => { s.contexts[0].rows[0].originatingServiceDateRanges = [range('2026-10-02', '2026-10-02')]; });
  for (const mutate of [(row) => { row.serviceDay = '2026-10-02'; }, (row) => { row.serviceMinute = 2; }, (row) => { row.weekdays = [6]; }, (row) => { row.isBankHoliday = true; }]) invalid(seed, (s) => mutate(s.contexts[0].rows[0]));
  invalid(seed, (s) => { s.contexts[0].publication.holidayCoverageStart = '2026-10-02'; });
});

test('profile identity includes ranges and rejects overlapping variants regardless of row order', async () => {
  const original = await retainedSeed();
  for (const reverse of [false, true]) {
    const seed = structuredClone(original); seed.contexts[0].rows = seed.contexts[0].rows.slice(0, 2);
    seed.contexts[0].rows[1].originatingServiceDateRanges = [range('2026-10-02', '2026-10-02')];
    if (reverse) seed.contexts[0].rows.reverse();
    assert.ok(admitPlannedSeed(seed, board(seed), observation(seed)).errors.some((error) => error.includes('ambiguous')));
  }
});

test('identical profile ranges admit either JSON object-key order in both row orders without changing stored evidence', async () => {
  for (const reversed of [false, true]) {
    const seed = await retainedSeed();
    for (const [index, row] of seed.contexts[0].rows.entries()) {
      if (index % 2) row.originatingServiceDateRanges = row.originatingServiceDateRanges.map(({ startDate, endDate }) => ({ endDate, startDate }));
    }
    if (reversed) seed.contexts[0].rows.reverse();
    const read = admitPlannedSeed(seed, board(seed), observation(seed));
    assert.deepEqual(read.errors, []); assert.equal(read.sources.timetable.events.length, 32);
    assert.equal(validateTokenPayload(token(seed), new Date(observation(seed))).ok, true);
    for (const [index, row] of seed.contexts[0].rows.entries()) {
      const evidence = read.sources.timetable.evidence.rows[index];
      assert.equal(evidence.id, row.id); assert.deepEqual(evidence.originatingServiceDateRanges, row.originatingServiceDateRanges);
      assert.deepEqual(Object.keys(evidence.originatingServiceDateRanges[0]), Object.keys(row.originatingServiceDateRanges[0]));
      assert.equal(read.sources.timetable.events[index].receivedAt, observation(seed));
      assert.equal(read.sources.timetable.events[index].expiresAt, Date.parse(seed.contexts[0].expiresAt));
    }
  }
});

test('disjoint same-name date variants retain exact identity across originating days', async () => {
  const at = londonClock('2026-10-02T00:00:30'), seed = overnightSeed(await retainedSeed(), '2026-10-01', 1442, at);
  const prior = seed.contexts[0].rows[0], current = structuredClone(prior);
  prior.weekdays = [5, 6]; prior.originatingServiceDateRanges = [range('2026-09-27', '2026-10-01')];
  current.id = `schedule:${seed.lineID}:${seed.stationID}:2026-10-02:0:0:1`; current.serviceDay = '2026-10-02'; current.serviceMinute = 3; current.departure = new Date(londonClock('2026-10-02T00:03:00')).toISOString(); current.weekdays = [5, 6]; current.originatingServiceDateRanges = [range('2026-10-02', '2026-12-23')];
  seed.contexts[0].rows.push(current);
  for (const rows of [[prior, current], [current, prior]]) { seed.contexts[0].rows = rows; const read = admitPlannedSeed(seed, board(seed), at); assert.deepEqual(read.errors, []); assert.equal(read.sources.timetable.events.length, 2); }
});

test('DST ambiguous or nonexistent own service clocks and altered TTL cannot acquire range qualification', async () => {
  const base = await retainedSeed();
  // Autumn London01:30 is ambiguous, so an offset string cannot prove this civil timetable slot.
  const seed = overnightSeed(base, '2026-10-25', 180, londonClock('2026-10-25T00:00:30'));
  invalid(seed, (s) => { const row = s.contexts[0].rows[0]; row.serviceMinute = 90; row.departure = '2026-10-25T01:30:00+01:00'; });
  const spring = overnightSeed(base, '2026-03-29', 180, londonClock('2026-03-29T00:00:30'));
  spring.contexts[0].publication.operatingStartDate = '2026-03-01'; spring.contexts[0].publication.operatingEndDate = '2026-03-31';
  spring.contexts[0].rows[0].originatingServiceDateRanges = [range('2026-03-01', '2026-03-31')];
  assert.deepEqual(admitPlannedSeed(spring, board(spring), observation(spring)).errors, []);
  invalid(spring, (s) => { const row = s.contexts[0].rows[0]; row.serviceMinute = 90; row.departure = '2026-03-29T01:30:00Z'; });
  invalid(base, (s) => { s.contexts[0].expiresAt = new Date(observation(s) + 600001).toISOString(); });
  invalid(base, (s) => { s.contexts[0].observedAt = new Date(observation(s) + 1000).toISOString(); });
  const expired = admitPlannedSeed(base, board(base), Date.parse(base.contexts[0].expiresAt)); assert.deepEqual(expired.errors, []); assert.deepEqual(expired.sources, {});
});

test('persisted ranged contexts keep original evidence on restart and older writers cannot resurrect changed publication', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-date-ranges-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const seed = await retainedSeed(), at = observation(seed), request = token(seed);
  const store = new LiveActivityStore(path.join(directory, 'records.json')); await store.load(); await store.upsertToken(request, new Date(at));
  const original = structuredClone(store.state.records[0].stationBoardCache), record = board(seed);
  const restarted = new LiveActivityStore(path.join(directory, 'records.json')); await restarted.load(); assert.deepEqual(restarted.state.records[0].stationBoardCache.sources.timetable.evidence, original.sources.timetable.evidence);
  const rejected = mergeContexts(original, { rejections: [{ ...record, reason: 'publicationChanged', observedAt: at + 1000 }] }, record, at + 1000); assert.equal(rejected.sources.timetable, undefined);
  for (const [first, second] of [[rejected, original], [original, rejected]]) assert.equal(mergeContexts(first, second, record, at + 2000).sources.timetable, undefined);
  const newerSeed = structuredClone(seed); newerSeed.contexts[0].observedAt = new Date(at + 3000).toISOString(); // Synthetic independent recovery, explicitly new evidence; original expiry is retained.
  const recovery = admitPlannedSeed(newerSeed, record, at + 3000); assert.deepEqual(recovery.errors, []); const recovered = mergeContexts(rejected, { sources: recovery.sources }, record, at + 3000); assert.equal(selectEvents(recovered, record, at + 3000).length, 32); assert.equal(recovered.sources.timetable.events[0].expiresAt, Date.parse(seed.contexts[0].expiresAt));
  const changed = mergeContexts(original, { publicationIdentity: { sha256: 'f'.repeat(64), observedAt: at + 1000, expiresAt: at + 600000 } }, record, at + 1000); assert.equal(changed.sources.timetable, undefined);
});
