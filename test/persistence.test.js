import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DisruptionAlertStore } from '../server/disruption-alerts.js';
import { LiveActivityStore } from '../server/live-activity.js';

// All registration values are synthetic contract fixtures. No network is used.
const liveFixture = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url), 'utf8'));
const alertFixture = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/disruption-alert-registration-v2.json', import.meta.url), 'utf8'));
const now = new Date('2026-09-04T12:00:00.000Z');
const encryptionKey = Buffer.alloc(32, 7);
const entitlement = {
  productID: 'uk.net.jeffers.tubeboard.premium.yearly',
  expiresAt: '2027-09-04T12:00:00.000Z',
  verifiedAt: now.toISOString()
};
const transition = {
  before: { lineID: 'central', severity: 10, isDisrupted: false },
  after: { lineID: 'central', lineName: 'Central', severity: 6, status: 'Severe Delays', isDisrupted: true },
  fingerprint: 'synthetic-transition'
};

for (const kind of ['live', 'alerts']) {
  for (const method of ['writeFile', 'rename']) {
    test(`${kind}: ${method} failure preserves committed data and the next write recovers`, async (t) => {
      const fixture = await temporaryStore(t, kind);
      const { store, filePath, directory } = fixture;
      await register(store, kind, 1);
      const before = store.state;
      const beforeText = await fs.readFile(filePath, 'utf8');
      const injected = failOnce(t, method, filePath);

      await assert.rejects(register(store, kind, 2), (error) => error === injected);
      assert.deepEqual(store.state, before);
      assert.equal(await fs.readFile(filePath, 'utf8'), beforeText);
      assert.deepEqual(await fs.readdir(directory), ['records.json']);

      await register(store, kind, 3);
      assert.deepEqual(store.state.records.map((record) => record.appVersion), ['test-1', 'test-3']);
      assert.deepEqual(await restart(fixture), JSON.parse(await fs.readFile(filePath, 'utf8')));
      assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    });
  }

  test(`${kind}: a queued operation still runs after its predecessor fails`, async (t) => {
    const fixture = await temporaryStore(t, kind);
    const { store, filePath } = fixture;
    await register(store, kind, 1);
    const injected = failOnce(t, 'rename', filePath);
    const results = await Promise.allSettled([
      register(store, kind, 2),
      register(store, kind, 3)
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason, injected);
    assert.equal(results[1].status, 'fulfilled');
    const persisted = await restart(fixture);
    assert.deepEqual(persisted.records.map((record) => record.appVersion), ['test-1', 'test-3']);
  });

  test(`${kind}: concurrent initial loading and writes preserve every registration`, async (t) => {
    const fixture = await temporaryStore(t, kind);
    await register(fixture.store, kind, 1);
    const store = createStore(kind, fixture.filePath);
    const gate = pauseOnce(t, 'readFile', fixture.filePath);
    const loaded = store.load();
    const second = register(store, kind, 2);
    const third = register(store, kind, 3);
    await gate.entered;
    gate.release();
    await Promise.all([loaded, second, third]);
    assert.equal(gate.calls(), 1, 'only one initial read');
    const persisted = await restart(fixture);
    assert.deepEqual(persisted.records.map((record) => record.appVersion), ['test-1', 'test-2', 'test-3']);
  });

  test(`${kind}: a failed initial read is reported and retried without replacing the file`, async (t) => {
    const fixture = await temporaryStore(t, kind);
    await register(fixture.store, kind, 1);
    const store = createStore(kind, fixture.filePath);
    const injected = failOnce(t, 'readFile', fixture.filePath);
    await assert.rejects(register(store, kind, 2), (error) => error === injected);
    assert.equal(store.state.records.length, 0);
    await register(store, kind, 3);
    assert.deepEqual((await restart(fixture)).records.map((record) => record.appVersion), ['test-1', 'test-3']);
  });

  test(`${kind}: readers see committed state while writes are pending`, async (t) => {
    const fixture = await temporaryStore(t, kind);
    const { store, filePath } = fixture;
    await register(store, kind, 1);
    const before = store.state;
    const gate = pauseOnce(t, 'rename', filePath);
    const second = register(store, kind, 2);
    const third = register(store, kind, 3);
    await gate.entered;
    assert.deepEqual(store.state, before);
    assert.equal((await restart(fixture)).records.length, 1);
    gate.release();
    await Promise.all([second, third]);
    assert.deepEqual((await restart(fixture)).records.map((record) => record.appVersion), ['test-1', 'test-2', 'test-3']);
  });
}

for (const deletion of ['deleteByInstallID', 'deleteByInstallDigest']) {
  for (const method of ['writeFile', 'rename']) {
    test(`alerts: ${deletion} retries ${method} failure and stays deleted after restart`, async (t) => {
      const fixture = await temporaryStore(t, 'alerts');
      const { store, filePath, directory } = fixture;
      const payload = await register(store, 'alerts', 1);
      await store.enqueue([transition], store.state.records, now);
      assert.equal(store.state.queue.length, 1);
      const before = store.state;
      const key = deletion === 'deleteByInstallID' ? payload.installID : before.records[0].installDigest;
      const injected = failOnce(t, method, filePath);

      await assert.rejects(store[deletion](key), (error) => error === injected);
      assert.deepEqual(store.state, before);
      assert.equal((await restart(fixture)).queue.length, 1);
      assert.deepEqual(await fs.readdir(directory), ['records.json']);
      await store[deletion](key);
      await store[deletion](key);
      const persisted = await restart(fixture);
      assert.equal(persisted.records.length, 0);
      assert.equal(persisted.queue.length, 0);
    });
  }

  test(`alerts: ${deletion} durably removes an orphaned queue item`, async (t) => {
    const fixture = await temporaryStore(t, 'alerts');
    const payload = await register(fixture.store, 'alerts', 1);
    await fixture.store.enqueue([transition], fixture.store.state.records, now);
    const persisted = fixture.store.state;
    const key = deletion === 'deleteByInstallID' ? payload.installID : persisted.records[0].installDigest;
    // Seed the existing storage format as it may be found on startup.
    persisted.records = [];
    await fs.writeFile(fixture.filePath, JSON.stringify(persisted));
    const store = createStore('alerts', fixture.filePath);
    await store[deletion](key);
    assert.equal((await restart(fixture)).queue.length, 0);
  });
}

test('alerts: a worker snapshot cannot restore queued alerts after opt-out', async (t) => {
  const fixture = await temporaryStore(t, 'alerts');
  const { store } = fixture;
  const payload = await register(store, 'alerts', 1);
  const records = await store.activeRecords(now);
  await Promise.all([
    store.deleteByInstallID(payload.installID),
    store.enqueue([transition], records, now)
  ]);
  const persisted = await restart(fixture);
  assert.equal(persisted.records.length, 0);
  assert.equal(persisted.queue.length, 0);
});

test('alerts: caller arrays and read snapshots cannot mutate committed preferences', async (t) => {
  const fixture = await temporaryStore(t, 'alerts');
  const { store, filePath } = fixture;
  const payload = payloadFor('alerts', 1);
  const gate = pauseOnce(t, 'rename', filePath);
  const registration = store.upsert(payload, entitlement, now);
  await gate.entered;
  payload.selectedLineIDs.push('victoria');
  gate.release();
  await registration;
  const snapshot = await store.activeRecords(now);
  snapshot[0].selectedLineIDs.push('district');
  assert.deepEqual(store.state.records[0].selectedLineIDs, ['central']);
  assert.deepEqual((await restart(fixture)).records[0].selectedLineIDs, ['central']);
});

test('live: a failed end remains active until a successful retry commits', async (t) => {
  const fixture = await temporaryStore(t, 'live');
  const { store, filePath } = fixture;
  const payload = await register(store, 'live', 1);
  const injected = failOnce(t, 'rename', filePath);
  await assert.rejects(store.endActivity(payload, now), (error) => error === injected);
  assert.equal((await store.listActive(now)).length, 1);
  assert.equal(await store.endActivity(payload, now), true);
  assert.equal(await store.endActivity(payload, now), false);
  assert.equal((await restart(fixture)).records[0].active, false);
});

function createStore(kind, filePath) {
  return kind === 'live' ? new LiveActivityStore(filePath) : new DisruptionAlertStore(filePath, encryptionKey);
}

async function temporaryStore(t, kind) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubeboard-persistence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'records.json');
  return { directory, filePath, kind, store: createStore(kind, filePath) };
}

function payloadFor(kind, index) {
  const installID = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const common = { installID, appVersion: `test-${index}`, tokenUpdatedAt: now.toISOString() };
  return kind === 'live' ? {
    ...structuredClone(liveFixture), ...common,
    activityID: installID,
    activityStartedAt: now.toISOString(),
    activityEndsAt: new Date(now.getTime() + 30 * 60_000).toISOString()
  } : {
    ...structuredClone(alertFixture), ...common,
    deviceTokenHex: index.toString(16).padStart(2, '0').repeat(32),
    selectedLineIDs: ['central'],
    quietHoursEnabled: false
  };
}

async function register(store, kind, index) {
  const payload = payloadFor(kind, index);
  if (kind === 'live') await store.upsertToken(payload, now);
  else await store.upsert(payload, entitlement, now);
  return payload;
}

async function restart({ kind, filePath }) {
  const restarted = createStore(kind, filePath);
  await restarted.load();
  return restarted.state;
}

function matches(method, candidate, filePath) {
  return method === 'readFile' ? candidate === filePath : String(candidate).startsWith(`${filePath}.`);
}

function failOnce(t, method, filePath) {
  const original = fs[method];
  const injected = Object.assign(new Error(`synthetic ${method} failure`), { code: 'EIO' });
  let failed = false;
  t.mock.method(fs, method, async (candidate, ...args) => {
    if (!failed && matches(method, candidate, filePath)) {
      failed = true;
      if (method === 'writeFile') {
        await original(candidate, String(args[0]).slice(0, 12), args[1]);
      }
      throw injected;
    }
    return original(candidate, ...args);
  });
  return injected;
}

function pauseOnce(t, method, filePath) {
  const original = fs[method];
  let enter;
  let release;
  let calls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  // Always unblock in teardown, including a failed assertion.
  t.after(() => release());
  t.mock.method(fs, method, async (candidate, ...args) => {
    if (matches(method, candidate, filePath)) {
      calls += 1;
      if (calls === 1) {
        enter();
        await released;
      }
    }
    return original(candidate, ...args);
  });
  return { entered, release, calls: () => calls };
}
