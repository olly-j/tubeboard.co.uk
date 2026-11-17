import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateOriginDiscovery, DISCOVERY_BINDINGS } from '../server/timetable-origin-discovery.js';
import { STATION_BOARD_STATIONS } from '../server/station-board-v2.js';

const sample = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/tb085-runtime-origin-discovery/${name}.json`, import.meta.url)));
const incomplete = () => sample('synthetic-incomplete');
const options = value => ({ publicationSHA256: value.publicationSHA256, at: Date.parse(value.assessedAt),
  bindings: Object.fromEntries(DISCOVERY_BINDINGS.map(name => [name, value.inputs[name]])) });

test('shared Python inventory fixtures preserve current gaps separately from future diagnostics', () => {
  const current = incomplete(), future = sample('synthetic-future-only-gap');
  assert.equal(validateOriginDiscovery(current, options(current)).discoveryStatus, 'incomplete');
  assert.equal(validateOriginDiscovery(future, options(future)).discoveryStatus, 'complete');
  assert.ok(future.unresolvedPublicSourceGaps.every(gap => !gap.affectsCurrentCoverage));
});
test('inventory identity, parser, producer, catalogue and original cache changes invalidate reuse', () => {
  for (const field of DISCOVERY_BINDINGS) {
    const value = incomplete(), expected = options(value);
    expected.bindings[field] = '0'.repeat(64);
    assert.throws(() => validateOriginDiscovery(value, expected), /Invalid timetable origin discovery/, field);
  }
  const value = incomplete();
  assert.throws(() => validateOriginDiscovery(value, { ...options(value), publicationSHA256: '0'.repeat(64) }));
});
test('carryover transition, holiday expiry, day rollover and backward time cannot extend inventory', () => {
  const value = incomplete(), expected = options(value);
  for (const at of [Date.parse(value.assessedAt) - 1, Date.parse(value.validUntil), Date.parse(value.validUntil) + 86400000])
    assert.throws(() => validateOriginDiscovery(value, { ...expected, at }));
  for (const mutate of [v => v.validUntil = '2026-11-18T01:00:00Z',
    v => v.inputs.holidayExpiresAt = v.assessedAt,
    v => v.inputs.officialObservation.expiresAt = v.assessedAt,
    v => v.serviceDay = '2026-11-18']) {
    const changed = incomplete(); mutate(changed); assert.throws(() => validateOriginDiscovery(changed));
  }
});
test('discovery cannot silently omit required scopes or turn unknown current gaps into healthy status', () => {
  for (const mutate of [v => v.discoveryStatus = 'complete',
    v => v.requiredScopes.push('central/940GZZLULYN'),
    v => v.requiredScopes = ['central/UNKNOWN'],
    v => v.counts.required++, v => v.eligibleScopes.reverse(),
    v => v.unresolvedPublicSourceGaps[0].affectsCurrentCoverage = null,
    v => v.inputs.extra = 'unreviewed', v => v.eligibleScopesComplete = 'true']) {
    const changed = incomplete(); mutate(changed); assert.throws(() => validateOriginDiscovery(changed));
  }
});
test('explicit required overflow retains denominator without admitting a truncated prefix', () => {
  const value = incomplete();
  value.eligibleScopes = [...STATION_BOARD_STATIONS.values()].flatMap(station =>
    station.lineIDs.map(line => `${line}/${station.stationID}`)).sort().slice(0, 257);
  value.counts.eligible = 257;
  value.requiredScopes = []; value.requiredScopesComplete = false; value.counts.required = 257;
  value.unresolvedPublicSourceGaps.push({ code: 'required-scope-overflow', lineID: null, stationID: null, affectsCurrentCoverage: true });
  assert.equal(validateOriginDiscovery(value).counts.required, 257);
  value.discoveryStatus = 'complete'; assert.throws(() => validateOriginDiscovery(value));
});
test('shared Python negative inventory cases reject false-complete and prefix authority', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/tb085-runtime-origin-discovery/negative/cases.json', import.meta.url)));
  for (const entry of cases) {
    const value = sample(entry.base.replace(/\.json$/, ''));
    for (const change of entry.changes) {
      let target = value;
      for (const key of change.path.slice(0, -1)) target = target[key];
      target[change.path.at(-1)] = change.value;
    }
    assert.throws(() => validateOriginDiscovery(value), /Invalid timetable origin discovery/, entry.name);
  }
});
test('truthful whole-archive parse unavailability needs no fabricated overflow', () => {
  const value = incomplete();
  Object.assign(value, { eligibleScopesComplete: false, requiredScopesComplete: false,
    eligibleScopes: [], requiredScopes: [], counts: { eligible: 0, required: 0, uncatalogued: 0 },
    unresolvedPublicSourceGaps: [{ code: 'unqualified-xml-member', lineID: null, stationID: null, affectsCurrentCoverage: true }] });
  assert.equal(validateOriginDiscovery(value).discoveryStatus, 'incomplete');
});
