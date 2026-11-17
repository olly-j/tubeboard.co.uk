import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimetableRecovery } from '../server/timetable-recovery.js';
import { STATION_BOARD_STATIONS, validBoard, londonLocal } from '../server/station-board-v2.js';
import { DISCOVERY_BINDINGS } from '../server/timetable-origin-discovery.js';

const EDITION = 'a'.repeat(64), NEXT = 'b'.repeat(64);
const scopes = [...STATION_BOARD_STATIONS.values()].flatMap(station =>
  station.lineIDs.map(line => `${line}/${station.stationID}`)).sort();
const sample = JSON.parse(await fs.readFile(new URL('./fixtures/tb085-runtime-origin-discovery/synthetic-incomplete.json', import.meta.url)));
const identity = edition => ({ publicationSHA256: edition, proofRevision: 1,
  proofBodySHA256: 'c'.repeat(64), resourceSHA256: 'd'.repeat(64) });
const validScope = value => validBoard(value.split('/')[1], value.split('/')[0]);
async function setup(t, required = scopes.slice(0, 35)) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-origin-seeding-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { now: Date.parse('2026-11-17T12:00:00Z'), edition: EDITION, required, gaps: [],
    parser: 'd'.repeat(64), discovers: 0, calls: [], covered: new Set(), timers: new Map(), alerts: [], failed: false };
  const inventory = () => {
    const value = structuredClone(sample);
    Object.assign(value, { publicationSHA256: state.edition, assessedAt: new Date(state.now).toISOString(),
      parsedAt: new Date(state.now).toISOString(), structuralValidUntil: new Date(state.now + 60000).toISOString(),
      serviceDay: londonLocal(state.now).slice(0, 10), validUntil: new Date(state.now + 60000).toISOString(),
      eligibleScopes: [...state.required].sort(), requiredScopes: [...state.required].sort(),
      unresolvedPublicSourceGaps: structuredClone(state.gaps),
      discoveryStatus: state.gaps.some(gap => gap.affectsCurrentCoverage) ? 'incomplete' : 'complete',
      counts: { eligible: state.required.length, required: state.required.length, uncatalogued: state.gaps.length } });
    Object.assign(value.inputs, { archiveSHA256: state.edition, parserSHA256: state.parser,
      holidayReceivedAt: new Date(state.now - 1000).toISOString(), holidayExpiresAt: new Date(state.now + 3600000).toISOString(),
      officialObservation: { publicationSHA256: state.edition,
        observedAt: new Date(state.now - 1).toISOString(), expiresAt: new Date(state.now + 600000).toISOString() } });
    return value;
  };
  const options = { filePath: path.join(directory, 'recovery.json'), now: () => state.now,
    observation: { current: () => ({ publicationSHA256: state.edition,
      observedAt: new Date(state.now - 1).toISOString(), expiresAt: new Date(state.now + 600000).toISOString() }) },
    latestIdentity: async () => identity(state.edition), validScope,
    discoveryBindings: async () => Object.fromEntries(DISCOVERY_BINDINGS.map(name => [name, inventory().inputs[name]])),
    discoverOrigins: async () => { state.discovers++; if (state.failed) throw Error('private upstream details'); return inventory(); },
    assessCoverage: async ({ identity: current, requestedScopes, mandatoryScopes = [], at }) => ({ valid: true, ...current,
      assessedAt: at, serviceDay: londonLocal(at).slice(0, 10), publicationRequiredScopes: [], requiredScopes: mandatoryScopes,
      assessedScopes: [...new Set([...requestedScopes, ...mandatoryScopes])],
      coveredScopes: [...new Set([...requestedScopes, ...mandatoryScopes])].filter(scope => state.covered.has(scope)),
      unresolvedScopes: [...new Set([...requestedScopes, ...mandatoryScopes])].filter(scope => !state.covered.has(scope)) }),
    recover: async request => { state.calls.push([...request.scopes]); request.scopes.forEach(scope => state.covered.add(scope)); return { unresolvedScopes: [] }; },
    alert: async event => state.alerts.push(event),
    schedule: (callback, delay) => { const key = {}; state.timers.set(key, { callback, delay }); return key; },
    cancel: key => state.timers.delete(key) };
  const worker = new TimetableRecovery(options); t.after(() => worker.stop());
  return { worker, state, options, inventory };
}

test('no-activity startup seeds XML requirements before healthy shortcut; batches make independent progress', async t => {
  const { worker, state } = await setup(t);
  await worker.tick(); assert.equal(state.calls[0].length, 32);
  assert.equal(worker.store.state.requiredScopes.length, 35);
  assert.equal((await worker.status()).coverageCurrent, false);
  await worker.tick(); assert.equal(state.calls[1].length, 3);
  assert.equal((await worker.status()).coverageCurrent, true);
  await worker.tick(); assert.equal(state.discovers, 1); assert.equal(state.calls.length, 2);
});
test('restart revalidates persisted inventory bindings without cold discovery or trusting old healthy state', async t => {
  const { worker, state, options } = await setup(t, scopes.slice(0, 1));
  await worker.tick(); await worker.stop();
  const resumed = new TimetableRecovery(options); t.after(() => resumed.stop());
  assert.equal((await resumed.status()).coverageCurrent, false);
  await resumed.tick(); assert.equal(state.discovers, 1); assert.equal((await resumed.status()).coverageCurrent, true);
  state.parser = '0'.repeat(64); await resumed.tick(); assert.equal(state.discovers, 2);
});
test('expired carryover inventory and changed edition/day remove unadmitted old origin authority', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1));
  worker.recover = async () => ({ unresolvedScopes: [scopes[0]] });
  await worker.tick(); assert.deepEqual(worker.store.state.requiredScopes, [scopes[0]]);
  state.now += 60000; state.required = [scopes[1]];
  worker.recover = async request => { state.calls.push(request.scopes); request.scopes.forEach(scope => state.covered.add(scope)); return { unresolvedScopes: [] }; };
  await worker.tick(); assert.deepEqual(worker.store.state.requiredScopes, [scopes[1]]);
  state.edition = NEXT; state.required = [scopes[2]]; await worker.tick();
  assert.deepEqual(worker.store.state.requiredScopes, [scopes[2]]);
  state.now += 86400000; state.required = [scopes[3]]; await worker.tick();
  assert.deepEqual(worker.store.state.requiredScopes, [scopes[3]]); assert.equal(state.discovers, 4);
});
test('unavailable inventory never claims healthy and cannot strand independently accepted demand', async t => {
  const { worker, state } = await setup(t, []); state.failed = true;
  await worker.request(scopes[0]); await worker.tick();
  assert.deepEqual(state.calls, [[scopes[0]]]); assert.equal((await worker.status()).coverageCurrent, false);
  assert.equal(worker.store.state.discoveryError, 'unavailable');
  assert.ok(!JSON.stringify(worker.store.state).includes('private upstream'));
});
test('all 256 demands coexist with automatic required origins in the separate reserve', async t => {
  const { worker, state } = await setup(t, scopes.slice(256, 321));
  for (const scope of scopes.slice(0, 256)) assert.equal(await worker.request(scope), true);
  await worker.tick();
  assert.equal(worker.store.state.requiredScopes.length, 65);
  assert.equal(worker.store.state.demandScopes.length, 256);
  assert.equal(worker.store.state.pending.length + worker.store.state.completed.length, 321);
  assert.equal(state.calls[0].length, 32);
});
test('31 new successes and one failed scope cannot stall untouched later origins or spin forever', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 65)), bad = scopes[0];
  worker.recover = async request => { state.calls.push(request.scopes);
    request.scopes.filter(scope => scope !== bad).forEach(scope => state.covered.add(scope));
    return { unresolvedScopes: request.scopes.includes(bad) ? [bad] : [] }; };
  await worker.tick(); await worker.tick();
  assert.equal(state.calls[1].includes(bad), false); assert.equal(state.calls[1].length, 32);
  await worker.tick(); await worker.tick();
  const attempts = state.calls.length; await worker.tick(); assert.equal(state.calls.length, attempts);
  assert.deepEqual(worker.store.state.pending, [bad]); assert.ok(worker.store.state.nextAttemptAt > state.now);
});
test('current-impact discovery gaps alert after bounded retries while eligible origins still qualify', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1));
  state.gaps = [{ code: 'uncatalogued-passenger-origin', lineID: 'circle', stationID: 'original-public-id', affectsCurrentCoverage: true }];
  await worker.tick(); assert.deepEqual(state.calls, [[scopes[0]]]);
  for (const delay of [0, 60000, 300000]) { state.now += delay; await worker.tick(); }
  assert.equal((await worker.status()).coverageCurrent, false); assert.equal(state.alerts.length, 1);
  assert.equal(worker.store.state.discovery.unresolvedPublicSourceGaps[0].stationID, 'original-public-id');
});
test('known future-only discovery diagnostics do not cause a false current incident', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1));
  state.gaps = [{ code: 'unqualified-xml-member', lineID: 'circle', stationID: null, affectsCurrentCoverage: false }];
  await worker.tick(); assert.equal((await worker.status()).coverageCurrent, true); assert.equal(state.alerts.length, 0);
});
test('explicit inventory overflow retains prior required custody and the full unadmitted denominator', async t => {
  const { worker, state, inventory } = await setup(t, scopes.slice(0, 1));
  worker.recover = async () => ({ unresolvedScopes: [scopes[0]] });
  await worker.tick(); state.now += 60000;
  worker.discoverOrigins = async () => {
    const value = inventory(); value.requiredScopes = []; value.requiredScopesComplete = false;
    value.eligibleScopes = scopes.slice(0, 257); value.counts.eligible = 257;
    value.counts.required = 257; value.discoveryStatus = 'incomplete';
    value.unresolvedPublicSourceGaps = [{ code: 'required-scope-overflow', lineID: null, stationID: null, affectsCurrentCoverage: true }];
    return value;
  };
  await worker.tick(); assert.deepEqual(worker.store.state.requiredScopes, [scopes[0]]);
  assert.equal(worker.store.state.discovery.counts.required, 257);
  assert.equal((await worker.status()).coverageCurrent, false);
});
test('same-edition incomplete discovery cannot erase prior unadmitted origin custody', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1));
  worker.recover = async request => ({ unresolvedScopes: request.scopes });
  await worker.tick(); state.now += 60000;
  state.required = [scopes[1]];
  state.gaps = [{ code: 'missing-xml-line', lineID: scopes[0].split('/')[0], stationID: null, affectsCurrentCoverage: true }];
  await worker.tick();
  assert.deepEqual(new Set(worker.store.state.requiredScopes), new Set(scopes.slice(0, 2)));
  assert.deepEqual(new Set(worker.store.state.pending), new Set(scopes.slice(0, 2)));
  assert.equal((await worker.status()).coverageCurrent, false);
  state.now += 300000; state.gaps = []; await worker.tick();
  assert.deepEqual(worker.store.state.requiredScopes, [scopes[1]], 'Only complete authority may prune the old origin');
});
test('inventory expiry after the healthy store write rolls back new resolution authority', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1));
  state.covered.add(scopes[0]); const authority = [];
  worker.authorizeAlertEdition = async value => authority.push(structuredClone(value));
  const transaction = worker.store.transaction.bind(worker.store);
  let delayed = false;
  worker.store.transaction = async update => {
    let becameHealthy = false;
    const result = await transaction(value => {
      const before = value.phase, changed = update(value);
      becameHealthy = before !== 'healthy' && value.phase === 'healthy'; return changed;
    });
    if (becameHealthy && !delayed) { delayed = true; state.now = Date.parse(worker.store.state.discovery.validUntil); }
    return result;
  };
  await worker.tick();
  assert.equal(delayed, true); assert.equal(authority.some(value => value.resolved), false);
  assert.equal(worker.store.state.phase, 'unresolved'); assert.equal(worker.store.state.resolutionHandoff, null);
  assert.deepEqual(worker.store.state.requiredScopes, [scopes[0]]);
  assert.equal((await worker.status()).coverageCurrent, false);
});
test('confirmed historical handoff keeps its original epoch across restart and a later current gap', async t => {
  const { worker, state, options } = await setup(t, scopes.slice(0, 1));
  worker.authorizeAlertEdition = async () => { throw Error('transport unavailable'); };
  await worker.tick(); const original = structuredClone(worker.store.state.resolutionHandoff);
  assert.ok(Number.isSafeInteger(original.discoveryFence.confirmedAt)); await worker.stop();
  state.now += 60000;
  state.gaps = [{ code: 'unqualified-xml-member', lineID: null, stationID: null, affectsCurrentCoverage: true }];
  const authority = [], resumed = new TimetableRecovery({ ...options,
    authorizeAlertEdition: async value => authority.push(structuredClone(value)) }); t.after(() => resumed.stop());
  await resumed.tick();
  const repaired = authority.find(value => value.resolved && value.assessment);
  assert.deepEqual(repaired, original);
  assert.equal(authority.some(value => value.resolved && !value.assessment), false);
  assert.equal((await resumed.status()).coverageCurrent, false);
});
test('restart cannot authorize an unconfirmed discovery handoff before a new healthy assessment', async t => {
  const { worker, state, options } = await setup(t, scopes.slice(0, 1));
  await worker.tick();
  await worker.store.transaction(value => { value.resolutionHandoff.discoveryFence.confirmedAt = null; });
  await worker.stop(); state.now += 60000; state.failed = true;
  const authority = [], resumed = new TimetableRecovery({ ...options,
    authorizeAlertEdition: async value => authority.push(structuredClone(value)) }); t.after(() => resumed.stop());
  await resumed.tick();
  assert.equal(authority.some(value => value.resolved), false);
  assert.equal(resumed.store.state.resolutionHandoff.discoveryFence.confirmedAt, null);
  state.failed = false; state.now += 60000; await resumed.tick();
  assert.equal((await resumed.status()).coverageCurrent, true);
  assert.ok(authority.some(value => value.resolved && value.discoveryFence?.confirmedAt !== null));
});
test('awaited historical handoff repair does not send current resolved after inventory expires', async t => {
  const { worker, state } = await setup(t, scopes.slice(0, 1)), authority = [];
  worker.authorizeAlertEdition = async value => {
    authority.push(structuredClone(value));
    if (value.resolved && value.assessment) state.now = Date.parse(worker.store.state.discovery.validUntil);
  };
  await worker.tick();
  assert.ok(authority.some(value => value.resolved && value.assessment));
  assert.equal(authority.some(value => value.resolved && !value.assessment), false);
  assert.equal((await worker.status()).coverageCurrent, false);
});
test('unconfirmed restart custody cannot strand current gap alerts or invent a healthy episode', async t => {
  const { worker, state, options } = await setup(t, scopes.slice(0, 1));
  await worker.tick();
  await worker.store.transaction(value => { value.resolutionHandoff.discoveryFence.confirmedAt = null; });
  const original = structuredClone(worker.store.state.resolutionHandoff); await worker.stop();
  state.now += 60000;
  state.gaps = [{ code: 'unqualified-xml-member', lineID: null, stationID: null, affectsCurrentCoverage: true }];
  const authority = [], resumed = new TimetableRecovery({ ...options, authorizeAlertEdition: async value => {
    authority.push(structuredClone(value));
    assert.equal(value.resolved, false); assert.equal(value.episode, original.episode);
  } }); t.after(() => resumed.stop());
  for (const delay of [0, 60000, 300000]) { state.now += delay; await resumed.tick(); }
  assert.equal(state.alerts.length, 1); assert.ok(authority.length > 0);
  assert.equal(authority.some(value => value.resolved), false);
  assert.deepEqual(resumed.store.state.resolutionHandoff, original);
});
test('discovery cancellation stops without consuming failure budget or persisting a synthetic inventory', async t => {
  const { worker } = await setup(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  worker.discoverOrigins = ({ signal }) => { entered(); return new Promise((resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const cycle = worker.tick();
  await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('discovery did not enter')), 1000); timer.unref(); })]);
  await worker.stop(); await cycle;
  assert.equal(worker.store.state.failures, 0); assert.equal(worker.store.state.discovery, null);
});

test('legacy persisted inventory retains pending custody and forces v2 before health', async t => {
  const { worker, state, options, inventory } = await setup(t, scopes.slice(0, 2));
  worker.recover = async () => ({ unresolvedScopes: state.required });
  await worker.request(scopes[2]); await worker.tick();
  const legacy = inventory(); legacy.schemaVersion = 1; legacy.kind = 'tubeboard-runtime-origin-discovery-v1';
  delete legacy.parsedAt; delete legacy.structuralValidUntil;
  await worker.store.transaction(value => { value.discovery = legacy; value.nextAttemptAt = 0; });
  const pending = [...worker.store.state.pending]; await worker.stop();
  let received;
  const resumed = new TimetableRecovery({ ...options, discoverOrigins: async request => {
    received = request.retainedInventory; throw Error('offline refresh unavailable');
  }}); t.after(() => resumed.stop());
  assert.equal((await resumed.status()).coverageCurrent, false);
  await resumed.tick();
  assert.deepEqual(received, legacy);
  assert.deepEqual(new Set([...resumed.store.state.pending, ...resumed.store.state.completed]), new Set(pending));
  assert.deepEqual(resumed.store.state.demandScopes, [scopes[2]]);
  assert.equal((await resumed.status()).coverageCurrent, false);
  resumed.discoverOrigins = async () => inventory();
  await resumed.store.transaction(value => { value.nextAttemptAt = 0; }); await resumed.tick();
  assert.equal(resumed.store.state.discovery.schemaVersion, 2);
});
