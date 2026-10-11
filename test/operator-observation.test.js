import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { startOperatorObservation, selectedPresence } from '../server/operator-observation.js';
import { LiveActivityStore } from '../server/live-activity.js';

const OWNED = '00000000-0000-4000-8000-000000000001';
async function fixture(t, lease = 20000) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tb-operator-')));
  await fs.chmod(directory, 0o700);
  const configPath = path.join(directory, 'observation.json');
  await fs.writeFile(configPath, JSON.stringify({ ownedInstallID: OWNED, expiresAt: new Date(Date.now() + lease).toISOString() }), { mode: 0o600 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, configPath, socketPath: path.join(directory, 'operator-observation.sock') };
}
function connect(socketPath) {
  const client = net.createConnection(socketPath); const frames = []; let raw = '';
  client.on('error', () => {}); client.on('data', (chunk) => { raw += chunk; let end;
    while ((end = raw.indexOf('\n')) >= 0) { frames.push(JSON.parse(raw.slice(0, end))); raw = raw.slice(end + 1); } });
  return { client, frames };
}
async function until(predicate, milliseconds = 2000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start >= milliseconds) assert.fail('Bounded local observation unavailable'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test('default-off observation performs no directory, selection or channel work', async () => {
  assert.equal(await startOperatorObservation({ selection: () => assert.fail('disabled selection') }), null);
});

test('initializer filesystem and JSON failures expose only the fixed safe reason', async (t) => {
  const f = await fixture(t); const safe = (error) => error.message === 'Private operator observation unavailable'
    && !error.message.includes(f.directory) && !error.message.includes(OWNED) && error.cause === undefined;
  await assert.rejects(startOperatorObservation({ configPath: path.join(f.directory, 'missing-private-canary') }), safe);
  await fs.writeFile(f.configPath, '{"ownedInstallID":"'+OWNED+'", private-canary');
  await assert.rejects(startOperatorObservation({ configPath: f.configPath }), safe);
});

test('private config rejects permission, alias, served-root, lifetime, extra-field and collision failures', async (t) => {
  const f = await fixture(t); const start = (extra = {}) => startOperatorObservation({ configPath: f.configPath, ...extra });
  await fs.chmod(f.configPath, 0o644); await assert.rejects(start()); await fs.chmod(f.configPath, 0o600);
  await fs.chmod(f.directory, 0o755); await assert.rejects(start()); await fs.chmod(f.directory, 0o700);
  const alias = path.join(f.directory, 'alias.json'); await fs.symlink(f.configPath, alias);
  await assert.rejects(startOperatorObservation({ configPath: alias }));
  const parentAlias = path.join(f.directory, 'parent-alias'); await fs.symlink(f.directory, parentAlias);
  await assert.rejects(startOperatorObservation({ configPath: path.join(parentAlias, 'observation.json') }));
  await assert.rejects(start({ servedRoots: [f.directory] }));
  await assert.rejects(start({ servedRoots: [parentAlias] }));
  await fs.writeFile(f.configPath, JSON.stringify({ ownedInstallID: OWNED, expiresAt: new Date(Date.now() + 91000).toISOString() }));
  await assert.rejects(start());
  await fs.writeFile(f.configPath, JSON.stringify({ ownedInstallID: OWNED, expiresAt: new Date(Date.now() - 1).toISOString() }));
  await assert.rejects(start());
  await fs.writeFile(f.configPath, JSON.stringify({ ownedInstallID: OWNED, expiresAt: new Date(Date.now() + 20000).toISOString(), command: 'not permitted' }));
  await assert.rejects(start());
  await fs.writeFile(f.configPath, JSON.stringify({ ownedInstallID: OWNED, expiresAt: new Date(Date.now() + 20000).toISOString() }));
  await fs.writeFile(f.socketPath, 'collision retained'); await assert.rejects(start());
  assert.equal(await fs.readFile(f.socketPath, 'utf8'), 'collision retained');
});

test('snapshot projection remains unknown unloaded and never clones or mutates customer records', () => {
  let reads = 0; const known = new Set();
  const digest = createHash('sha256').update(OWNED).digest('hex');
  const store = (state) => ({ snapshot(select) { reads += 1; const result = select(state); assert.ok(!JSON.stringify(result).includes('sensitive-canary')); return structuredClone(result); },
    load() { assert.fail('observer load'); }, activeRecords() { assert.fail('observer purge/read'); }, transaction() { assert.fail('observer mutation'); } });
  const activities = store({ records: [{ installID: OWNED, secret: 'sensitive-canary' }] });
  const alerts = store({ records: [{ installDigest: digest, token: 'sensitive-canary' }], queue: [{ installDigest: digest }] });
  assert.deepEqual(selectedPresence({ activities, alerts, ownedInstallID: OWNED, known }), { activitiesPresent: null, alertsPresent: null, alertsQueued: null });
  assert.equal(reads, 0); known.add('activities'); known.add('alerts');
  assert.deepEqual(selectedPresence({ activities, alerts, ownedInstallID: OWNED, known }), { activitiesPresent: true, alertsPresent: true, alertsQueued: true });
  const large = store({ records: Array.from({ length: 2049 }, () => ({ secret: 'sensitive-canary' })) });
  assert.equal(selectedPresence({ activities: large, alerts, ownedInstallID: OWNED, known }).activitiesPresent, null);
  const mixedCase = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  assert.deepEqual(selectedPresence({ activities: store({ records: [{ installID: mixedCase }] }),
    alerts: store({ records: [{ installDigest: createHash('sha256').update(mixedCase.toLowerCase()).digest('hex') }], queue: [] }),
    ownedInstallID: mixedCase, known }), { activitiesPresent: true, alertsPresent: true, alertsQueued: false });
});

test('extra clients and paused readers cannot own or stall business observation calls', async (t) => {
  const f = await fixture(t); const observer = await startOperatorObservation({ configPath: f.configPath });
  t.after(() => observer.close()); const first = connect(f.socketPath); t.after(() => first.client.destroy());
  await until(() => first.frames.length);
  const extra = net.createConnection(f.socketPath); extra.on('error', () => {}); await once(extra, 'close');
  first.client.pause();
  for (let i = 0; i < 140; i += 1) observer.http('accepted');
  assert.doesNotThrow(() => observer.http('finished')); first.client.destroy();
});

test('default-off actual service keeps private routes and health unchanged', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: {
    PATH: process.env.PATH, PORT: '0', LIVE_ACTIVITY_WORKER_ENABLED: 'false', DISRUPTION_ALERT_WORKER_ENABLED: 'false',
    TUBEBOARD_STATUS_MONITOR_ENABLED: 'false', LIVE_ACTIVITY_DATA_FILE: path.join(f.directory, 'activities.json'),
    DISRUPTION_ALERT_DATA_FILE: path.join(f.directory, 'alerts.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const origin = await new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', (data) => {
    output += data; const match = /http:\/\/localhost:(\d+)/.exec(output); if (match) resolve(match[0]); }); child.once('error', reject); });
  const health = await (await fetch(origin+'/healthz')).json();
  assert.equal(health.ok, true); assert.ok(!JSON.stringify(health).toLowerCase().includes('observation'));
  assert.equal((await fetch(origin+'/api/operator-observation')).status, 404);
  await assert.rejects(fs.stat(f.socketPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.directory, 'activities.json')), { code: 'ENOENT' });
  child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
});

test('real private stream censors fields and never treats unknown absence as positive owned evidence', async (t) => {
  const f = await fixture(t); let present = false;
  const observer = await startOperatorObservation({ configPath: f.configPath,
    selection: () => ({ activitiesPresent: present, alertsPresent: false, alertsQueued: false, token: 'sensitive-canary' }) });
  t.after(() => observer.close()); const { client, frames } = connect(f.socketPath); t.after(() => client.destroy());
  await until(() => frames.length); assert.equal((await fs.stat(f.socketPath)).mode & 0o777, 0o600);
  assert.equal(frames[0].selected.activitiesPositiveObserved, false);
  assert.equal(frames[0].selected.alertsPositiveObserved, false);
  assert.equal(frames[0].selected.activitiesPresent, null);
  observer.worker('activities', 'cycle-start', { running: 1, maximum: 1, cyclesStarted: 1, cyclesCompleted: 0, aborted: 0, timers: 2, active: true, pending: true, started: true, stopped: false, error: 'sensitive-canary' });
  present = true; observer.loaded('activities'); await until(() => frames.some((x) => x.selected.activitiesPositiveObserved));
  assert.ok(frames.every((x) => x.selected.alertsPositiveObserved === false));
  const output = JSON.stringify(frames); assert.ok(!output.includes(OWNED)); assert.ok(!output.includes('sensitive-canary'));
  assert.ok(!output.includes('token')); assert.equal(frames.at(-1).selected.activitiesKnown, true);
  const closed = once(client, 'close'); client.write('no commands'); await closed;
});

test('absolute lease and frame limits close observation without touching business operations', async (t) => {
  const f = await fixture(t, 200); const observer = await startOperatorObservation({ configPath: f.configPath });
  const { client, frames } = connect(f.socketPath); t.after(() => client.destroy()); t.after(() => observer.close());
  await until(() => frames.length); await once(client, 'close');
  const other = await fixture(t); const bounded = await startOperatorObservation({ configPath: other.configPath });
  t.after(() => bounded.close()); const second = connect(other.socketPath); t.after(() => second.client.destroy());
  await until(() => second.frames.length); const closed = once(second.client, 'close');
  for (let i = 0; i < 140; i += 1) bounded.http('accepted');
  await closed; assert.ok(second.frames.length <= 128);
});

test('real accepted HTTP persistence drains with a connected private observer and workers disabled', { timeout: 10000 }, async (t) => {
  const f = await fixture(t); const dataFile = path.join(f.directory, 'activities.json');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, PORT: '0', LIVE_ACTIVITY_WORKER_ENABLED: 'false', DISRUPTION_ALERT_WORKER_ENABLED: 'false', TUBEBOARD_STATUS_MONITOR_ENABLED: 'false',
      LIVE_ACTIVITY_DATA_FILE: dataFile, DISRUPTION_ALERT_DATA_FILE: path.join(f.directory, 'alerts.json'), TUBEBOARD_OPERATOR_OBSERVATION_CONFIG: f.configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const port = await new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', (data) => { output += data; const match = /localhost:(\d+)/.exec(output); if (match) resolve(Number(match[1])); }); child.once('error', reject); });
  await until(async () => { try { return (await fs.stat(f.socketPath)).isSocket(); } catch { return false; } });
  // Socket creation/readiness is observed without retrying any business request.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stream = connect(f.socketPath); t.after(() => stream.client.destroy()); await until(() => stream.frames.length);
  const fixtureBody = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url)));
  const body = JSON.stringify({ ...fixtureBody, installID: OWNED, tokenUpdatedAt: new Date().toISOString() });
  const response = new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/live-activities/tokens', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    request.on('error', reject); request.write(body.slice(0, 10));
    void until(() => stream.frames.some((x) => x.http.inFlight === 1)).then(() => { child.kill('SIGTERM'); setTimeout(() => request.end(body.slice(10)), 50); }).catch(reject);
  });
  const result = await response; assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).ok, true);
  const [code] = await exited; assert.equal(code, 0);
  const store = new LiveActivityStore(dataFile); await store.load(); assert.equal(store.state.records[0].installID, OWNED);
  assert.ok(stream.frames.some((x) => x.http.shutdown && x.http.inFlight === 1));
  assert.ok(stream.frames.some((x) => x.selected.activitiesPositiveObserved));
  assert.ok(stream.frames.every((x) => !x.http.deadline));
});
