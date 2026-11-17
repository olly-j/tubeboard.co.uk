import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimetableRecoveryService, loadTimetableRecoveryConfig } from '../server/timetable-recovery-service.js';
import { TimetableRecovery } from '../server/timetable-recovery.js';
import { TimetableRecoveryProducer } from '../server/timetable-recovery-producer.js';
import { TimetablePublicationAdmissionStore } from '../server/timetable-publication-admission-store.js';
import { loadSourceBodyArchiveIndex } from '../server/timetable-source-body-resource.js';
import { PUBLICATION_ASSET_DIRECTORY } from '../server/timetable-publication-resource.js';
import { STATION_BOARD_STATIONS } from '../server/station-board-v2.js';
const baseline = '0169fa960dee3ad1ca47ae70c639143375287a99ce18018a05703927593bc017';
const record = { contentStateContract: 'station-board-v2', stationID: '940GZZLUEGW', lineID: 'northern' };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async service => { await service.ready; while (service.syncing) await service.syncing; };
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-recovery-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { TUBEBOARD_TIMETABLE_RECOVERY_ENABLED: 'true', TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY: path.join(root, 'recovery'),
    TUBEBOARD_TIMETABLE_EDITION_MONITOR_ENABLED: 'true', TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY: path.join(root, 'admission'),
    TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_BASELINE_SHA256: baseline };
  const observation = { current: () => null };
  const archives = path.join(root, 'empty'); await fs.mkdir(archives);
  const index = await loadSourceBodyArchiveIndex({ publicationDirectory: PUBLICATION_ASSET_DIRECTORY, archiveDirectory: archives });
  const store = await new TimetablePublicationAdmissionStore({ directory: env.TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY,
    baselineSHA256: baseline, observation, baseSourceIndex: index, publicationDirectory: PUBLICATION_ASSET_DIRECTORY, archiveDirectory: archives }).initialize();
  const config = loadTimetableRecoveryConfig(env, { servedDirectory: path.join(root, 'served') });
  const options = { config, admissionStore: Promise.resolve(store), observation, activityStore: { listActive: async () => [] }, activityConfig: {} };
  return { root, env, store, options, observation };
}

test('default/off constructs nothing and invalid enabled configuration fails closed', () => {
  assert.deepEqual(loadTimetableRecoveryConfig({}), { enabled: false });
  const service = new TimetableRecoveryService({ config: { enabled: false }, Producer: class { constructor() { assert.fail(); } } });
  assert.equal(service.accepted(record), false); assert.equal(service.tick(), undefined);
  return service.stop();
});
test('enabled config requires observer, baseline, canonical disjoint private paths and valid explicit author', async t => {
  const { env, root } = await setup(t);
  for (const delta of [ { TUBEBOARD_TIMETABLE_RECOVERY_ENABLED: 'yes' }, { TUBEBOARD_TIMETABLE_EDITION_MONITOR_ENABLED: 'false' },
    { TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_BASELINE_SHA256: 'bad' }, { TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY: '' },
    { TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY: 'relative' }, { TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY: root + '/a/../b' },
    { TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY: path.join(root, 'served', 'cache') },
    { TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY: env.TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY },
    { TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_AUTHOR_ID: '0' }, { TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_AUTHOR_ID: '1junk' },
    { TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_AUTHOR_ID: '9007199254740992' }, { TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_TOKEN: ' secret ' } ]) {
    assert.throws(() => loadTimetableRecoveryConfig({ ...env, ...delta }, { servedDirectory: path.join(root, 'served') }), /Invalid timetable recovery configuration/);
  }
});
test('actual initialized admission, producer and coordinator retain bound readback and scope-only restart custody', async t => {
  const { options, store } = await setup(t);
  options.activityStore = { listActive: async () => [{ ...record, activityID: 'never-copy-activity', token: 'never-copy-token' }, { ...record }] };
  const service = new TimetableRecoveryService(options); t.after(() => service.stop()); await settle(service);
  assert.ok(service.producer instanceof TimetableRecoveryProducer); assert.ok(service.recovery instanceof TimetableRecovery);
  assert.deepEqual(await service.producer.readCurrentResource(store.latestAdmittedIdentity), await store.readPublicPublicationBytes(baseline));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.producer.readCurrentResource(store.latestAdmittedIdentity, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(service.recovery.store.state.pending, ['northern/940GZZLUEGW']);
  assert.equal(service.accepted({ ...record, registrationAccepted: false }), false);
  assert.equal(service.accepted({ ...record, contentStateContract: undefined }), false);
  assert.equal(service.accepted({ ...record, stationID: 'not-on-line' }), false);
  assert.equal(service.accepted({ ...record, lineID: 'central', stationID: '940GZZLULYN' }), false, 'Unqualified through station is not a producer origin demand');
  assert.equal(service.accepted({ ...record, lineID: 'circle', stationID: '940GZZLUALD' }), false, 'Catalogue branch target alone is not a producer origin');
  assert.equal(service.accepted({ ...record, lineID: 'elizabeth', stationID: '910GSHENFLD' }), false, 'Direct rail registration does not demand XML preparation');
  assert.equal(service.accepted(record), true); await settle(service);
  assert.equal(service.recovery.store.state.pending.length, 1);
  assert.equal(service.recovery.alert, undefined, 'Absent alert credentials cannot acknowledge an incident');
  const bytes = await fs.readFile(options.config.stateFile, 'utf8'); assert.ok(!bytes.includes('never-copy'));
  await service.stop();
  const restarted = new TimetableRecoveryService({ ...options, activityStore: { listActive: async () => [] } }); t.after(() => restarted.stop());
  await settle(restarted); await restarted.recovery.store.load();
  assert.deepEqual(restarted.recovery.store.state.pending, ['northern/940GZZLUEGW']);
});
test('late admission initialization cannot construct or start recovery after stop', async t => {
  const { options } = await setup(t), gate = defer(); let constructed = 0;
  const service = new TimetableRecoveryService({ ...options, admissionStore: gate.promise, Producer: class { constructor() { constructed++; } } });
  assert.equal(service.accepted(record), false, 'No new demand is eligible before authoritative proof readback'); await service.stop(); gate.resolve(null); await settle(service);
  assert.equal(constructed, 0); assert.equal(service.recovery, undefined); assert.equal(service.accepted(record), false);
});
test('failed admission preserves existing history and never chooses a weaker writer', async t => {
  const { options } = await setup(t); await fs.mkdir(options.config.directory);
  await fs.writeFile(options.config.stateFile, 'retained existing custody'); let errors = 0;
  const service = new TimetableRecoveryService({ ...options, admissionStore: Promise.resolve(null), onError: () => errors++ });
  await settle(service); await service.stop(); assert.equal(errors, 1); assert.equal(service.producer, undefined);
  assert.equal(await fs.readFile(options.config.stateFile, 'utf8'), 'retained existing custody');
});
test('accepted-demand buffer is bounded and duplicates coalesce while initialization waits', async t => {
  const { options } = await setup(t), gate = defer();
  const service = new TimetableRecoveryService({ ...options, admissionStore: gate.promise });
  const scopes = [...STATION_BOARD_STATIONS].flatMap(([stationID, station]) => station.lineIDs.filter(lineID => !['elizabeth','liberty','lioness','mildmay','suffragette','weaver','windrush'].includes(lineID)).map(lineID => ({ ...record, stationID, lineID })));
  assert.ok(scopes.length > 256);
  // Exercise queue bounding independently of discovery: simulate future
  // admitted qualified scope authority without changing the fixed catalogue.
  for (const value of scopes) service.supportedScopes.add(`${value.lineID}/${value.stationID}`);
  for (const value of scopes.slice(0, 256)) assert.equal(service.accepted(value), true);
  const syncing = service.syncing;
  assert.equal(service.accepted(scopes[0]), true); assert.equal(service.syncing, syncing);
  assert.equal(service.accepted(scopes[256]), false); assert.equal(service.pending.size, 256);
  await service.stop(); gate.resolve(null); await settle(service);
});
test('registration and repeated observer ticks stay nonblocking while actual coordinator owns an abortable producer', async t => {
  const { options } = await setup(t), entered = defer(); let calls = 0, stopped = false;
  const edition = 'a'.repeat(64);
  const observation = { current: () => ({ publicationSHA256: edition, observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }) };
  class Producer {
    recover({ signal }) { calls++; entered.resolve(); return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
    }); }
    assessCurrentCoverage() { assert.fail('New edition must not assess old proof'); }
  }
  const service = new TimetableRecoveryService({ ...options, observation, Producer }); t.after(() => service.stop());
  await entered.promise;
  assert.equal(service.accepted(record), true);
  for (let i = 0; i < 20; i++) assert.equal(service.tick(), undefined);
  await settle(service); assert.equal(calls, 1, 'Busy coordinator coalesces observer and registration wakes');
  await service.stop(); assert.equal(stopped, true);
  assert.equal(service.recovery.worker.nextIntervalAt, null);
});
test('stop during active-record restoration prevents later request/tick work', async t => {
  const { options } = await setup(t), entered = defer(), gate = defer(); let requests = 0, ticks = 0, stops = 0;
  class Recovery { request() { requests++; } tick() { ticks++; return Promise.resolve(); } stop() { stops++; return Promise.resolve(); } }
  const service = new TimetableRecoveryService({ ...options, Recovery, activityStore: { listActive: () => { entered.resolve(); return gate.promise; } } });
  await entered.promise; const stop = service.stop(); gate.resolve([record]); await stop;
  assert.equal(requests, 0); assert.equal(ticks, 0); assert.equal(stops, 1);
});
test('alert transport is optional and configured methods retain their owner', async t => {
  const { options } = await setup(t); let alertOptions, callbacks, owner;
  class Alert {
    constructor(value) { alertOptions = value; owner = this; }
    authorizeEdition(value) { assert.equal(this, owner); return Promise.resolve(value); }
    deliver() { assert.equal(this, owner); return Promise.reject(new Error('pending alert')); }
  }
  class Recovery {
    constructor(value) { callbacks = value; }
    request() { return Promise.resolve(true); } tick() { return Promise.resolve(); } stop() { return Promise.resolve(); }
  }
  const service = new TimetableRecoveryService({ ...options, config: { ...options.config, alertToken: 'explicit-fixture-token', alertAuthorID: 123 }, Alert, Recovery });
  t.after(() => service.stop()); await settle(service);
  assert.equal(alertOptions.token, 'explicit-fixture-token'); assert.equal(alertOptions.actorID, 123);
  assert.equal(alertOptions.filePath, options.config.alertFile);
  assert.deepEqual(await callbacks.authorizeAlertEdition({ generation: 2 }), { generation: 2 });
  await assert.rejects(callbacks.alert({}), /pending alert/);
  await service.stop();
  const absent = new TimetableRecoveryService({ ...options, config: { ...options.config, alertToken: 'explicit-fixture-token', alertAuthorID: null },
    Alert: class { constructor() { assert.fail('Partial credentials cannot construct an alert transport'); } } });
  t.after(() => absent.stop()); await settle(absent); assert.equal(absent.recovery.alert, undefined);
});
test('changed admitted resource bytes fail closed for demand without suppressing coordinator ticks', async t => {
  const { options, store } = await setup(t); let errors = 0, ticks = 0;
  store.readPublicPublicationBytes = async () => Buffer.from('{}');
  class Recovery extends TimetableRecovery { tick() { ticks++; return super.tick(); } }
  const service = new TimetableRecoveryService({ ...options, Recovery, onError: () => errors++ });
  await settle(service); await service.stop();
  assert.equal(errors, 1); assert.ok(service.recovery); assert.equal(ticks, 1);
  assert.equal(service.supportedScopes.size, 0); assert.equal(service.accepted(record), false);
});

test('initialization retries only on a later external tick and preserves persistent demand', async t => {
  const { options } = await setup(t); let attempts = 0, errors = 0;
  class Recovery extends TimetableRecovery {
    constructor(value) { if (++attempts === 1) throw new Error('transient initialization failure'); super(value); }
  }
  const service = new TimetableRecoveryService({ ...options, Recovery, onError: () => errors++, activityStore: { listActive: async () => [record] } });
  t.after(() => service.stop()); await settle(service);
  assert.equal(attempts, 1); assert.equal(errors, 1); assert.equal(service.recovery, undefined);
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  assert.equal(attempts, 1, 'Failed initialization cannot schedule itself repeatedly');
  service.tick(); await settle(service);
  assert.equal(attempts, 2); assert.ok(service.recovery);
  assert.deepEqual(service.recovery.store.state.pending, ['northern/940GZZLUEGW']);
});

test('transient eligibility read and identity race retry on existing ticks without broadening scopes', async t => {
  for (const mode of ['read-failure', 'identity-race']) await t.test(mode, async t => {
    const { options, store } = await setup(t); let reads = 0, raced = false, ticks = 0, errors = 0;
    const original = store.readPublicPublicationBytes.bind(store), identity = store.latestAdmittedIdentity;
    const wrapper = { get latestAdmittedIdentity() { return raced ? { ...identity, proofRevision: identity.proofRevision + 1 } : identity; },
      admitTrustedPackage: value => store.admitTrustedPackage(value),
      readPublicPublicationBytes: async sha => {
        reads++;
        if (reads === 1 && mode === 'read-failure') throw new Error('temporary read failure');
        const bytes = await original(sha); if (reads === 1 && mode === 'identity-race') raced = true;
        return bytes;
      } };
    class Recovery extends TimetableRecovery { tick() { ticks++; return super.tick(); } }
    const service = new TimetableRecoveryService({ ...options, admissionStore: wrapper, Recovery, onError: () => errors++ });
    t.after(() => service.stop()); await settle(service);
    assert.equal(reads, 1); assert.equal(errors, 1); assert.equal(ticks, 1);
    assert.equal(service.supportedScopes.size, 0);
    for (let i = 0; i < 3; i++) await new Promise(setImmediate);
    assert.equal(reads, 1, 'Ancillary error cannot spin a retry loop');
    raced = false;
    assert.equal(service.accepted(record), false, 'A validated registration wakes retry without admitting unsupported demand');
    await settle(service);
    assert.equal(reads, 2); assert.equal(ticks, 2); assert.equal(service.accepted(record), true);
    await settle(service);
    assert.deepEqual(service.recovery.store.state.pending, ['northern/940GZZLUEGW']);
  });
});

test('ancillary proof or registration restoration failures cannot strand durable recovery work', async t => {
  for (const mode of ['proof-read', 'active-record-read']) await t.test(mode, async t => {
    const { options, store } = await setup(t);
    const seed = new TimetableRecoveryService({ ...options, activityStore: { listActive: async () => [record] } });
    await settle(seed); await seed.stop();
    if (mode === 'proof-read') store.readPublicPublicationBytes = async () => { throw new Error('ancillary unavailable'); };
    const entered = defer(); let recovered, stopped = false;
    class Producer {
      recover({ scopes, signal }) { recovered = scopes; entered.resolve(); return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
      }); }
      assessCurrentCoverage() { assert.fail('New edition must not assess previous publication'); }
    }
    const observation = { current: () => ({ publicationSHA256: 'a'.repeat(64), observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }) };
    const service = new TimetableRecoveryService({ ...options, Producer, observation,
      activityStore: { listActive: async () => { if (mode === 'active-record-read') throw new Error('registration store unavailable'); return []; } } });
    t.after(() => service.stop());
    let timer;
    try { await Promise.race([entered.promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Durable producer work was stranded')), 2000); })]); }
    finally { clearTimeout(timer); }
    assert.deepEqual(recovered, ['northern/940GZZLUEGW']);
    await service.stop(); assert.equal(stopped, true);
    await service.recovery.store.load(); assert.deepEqual(service.recovery.store.state.pending, ['northern/940GZZLUEGW']);
  });
});
