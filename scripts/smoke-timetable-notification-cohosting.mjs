// Explicit, network-disabled capacity experiment. Never imported by the server.
// node scripts/smoke-timetable-notification-cohosting.mjs /fixture /evidence
// fixture.json names original captured HTTP records, verified archive inputs,
// predecessor wrapper, observation and requested scopes. No executable fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { SerialWorker } from '../server/worker-lifecycle.js';
import { LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, getStationArrivalsRefreshDelayMs, getRolloverDelayMs } from '../server/live-activity.js';
import { DisruptionAlertStore, loadDisruptionAlertConfig, runDisruptionAlertWorkerCycle } from '../server/disruption-alerts.js';
import { WidgetPushStore, loadWidgetPushConfig, runWidgetPushWorkerCycle, WIDGET_KINDS } from '../server/widget-push.js';
import { sendApnsRequest } from '../server/notification-transport.js';
import { TimetableRecoveryProducer } from '../server/timetable-recovery-producer.js';
import { TimetablePublicationAdmissionStore } from '../server/timetable-publication-admission-store.js';
import { loadSourceBodyArchiveIndex } from '../server/timetable-source-body-resource.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const silent = { info() {}, warn() {}, error() {} };
const key = Buffer.alloc(32, 7); // Synthetic fixture encryption only.
const productID = 'uk.net.jeffers.tubeboard.premium.lifetime';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Exercise the actual timeout/cancellation/session-disposal implementation.
// There is deliberately no real HTTP/2 connector or APNs credential here.
export function mockApns({ stalled = false, entered = () => {} } = {}) {
  const sessions = [];
  const connect = () => {
    const session = new EventEmitter(), request = new EventEmitter();
    session.destroy = () => { session.destroyed = true; };
    request.destroy = () => { request.destroyed = true; };
    request.setEncoding = () => {};
    request.end = () => { entered(); if (!stalled) setImmediate(() => {
      request.emit('response', { ':status': 200 }); request.emit('end');
    }); };
    session.request = () => request; sessions.push({ session, request }); return session;
  };
  return { sessions, send: (signal, payload) => sendApnsRequest('synthetic.invalid', {}, payload, { signal, connect }) };
}

export async function notificationWorkload(directory, transport = mockApns(), { runActivityCycle = runLiveActivityWorkerCycle } = {}) {
  const activityConfig = loadConfig({}), alertConfig = loadDisruptionAlertConfig({});
  const widgetConfig = loadWidgetPushConfig({}, { encryptionKey: key });
  const activity = new LiveActivityStore(path.join(directory, 'activities.json'));
  const alerts = new DisruptionAlertStore(path.join(directory, 'alerts.json'), key);
  const widgets = new WidgetPushStore(path.join(directory, 'widgets.json'), key);
  const registration = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url)));
  const now = new Date();
  await alerts.upsert({ contractVersion: 1, installID: 'synthetic-cohosting', deviceTokenHex: '07'.repeat(32),
    selectedLineIDs: ['central'], severity: 'allDisruptions', quietHoursEnabled: false,
    quietHoursStartMinutes: 0, quietHoursEndMinutes: 0, timeZone: 'Europe/London', serviceResumedAlerts: true,
    appBundleID: 'OllyJ.My-Train-Times', apnsEnvironment: 'sandbox' },
  { productID, expiresAt: null, verifiedAt: now.toISOString() }, now);
  const widgetPayload = { schemaVersion: 1, token: '07'.repeat(32), environment: 'sandbox',
    kinds: [WIDGET_KINDS[0]], revision: 1 };
  await widgets.put(widgetPayload, { productID, expiresAt: null }, await widgets.prepare(widgetPayload, +now), +now);
  const events = [], errors = [], sends = [], workers = [];
  const sourceReads = [], activityRuns = [], activityReruns = []; let alertSequence = 0;
  await activity.upsertToken({ ...registration, installID: 'synthetic-board', activityID: 'synthetic-board',
    environment: 'sandbox', selectionMode: 'allPlatforms', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2,
    activityStartedAt: now.toISOString(), activityEndsAt: new Date(+now + 1200000).toISOString(), tokenUpdatedAt: now.toISOString() }, now);
  const send = async (name, signal, payload) => {
    const result = await transport.send(signal, payload);
    assert.equal(result.status, 200); sends.push({ name, at: performance.now() }); return result;
  };
  function add(name, intervalMs, initialDelayMs, run) {
    const worker = new SerialWorker({ intervalMs, initialDelayMs,
      onError: error => errors.push({ name, message: error.message }),
      onObserve: (event, state) => events.push({ name, event, at: performance.now(), state }),
      run: (signal, options) => run(signal, options, worker) });
    workers.push({ name, intervalMs, initialDelayMs, worker });
  }
  add('activities', activityConfig.workerIntervalMs, 2000, async (signal, options, worker) => {
    const at = new Date();
    activityRuns.push({ at: performance.now(), cacheOnly: options.cacheOnly === true, sourceOnly: options.sourceOnly === true });
    await runActivityCycle({ store: activity, config: activityConfig, now: at, signal, logger: silent,
      cacheOnly: options.cacheOnly, sourceOnly: options.sourceOnly,
      nextFullRefreshAt: worker.nextIntervalAt,
      scheduleSourceRefresh: (record, cache, now, workerIntervalMs) => {
        const key = `${record.environment}:${record.activityID}:station-arrivals`, delayMs = getStationArrivalsRefreshDelayMs(cache, now, workerIntervalMs);
        activityReruns.push({ at: performance.now(), key, delayMs, sourceOnly: true });
        worker.scheduleRerun(key, delayMs, { sourceOnly: true });
      },
      scheduleRolloverPush: (record, contentState, now, workerIntervalMs) => {
        const key = `${record.environment}:${record.activityID}`, delayMs = getRolloverDelayMs(contentState, now, workerIntervalMs);
        const cacheOnly = record.contentStateContract === 'station-board-v2';
        activityReruns.push({ at: performance.now(), key, delayMs, cacheOnly });
        worker.scheduleRerun(key, delayMs, { cacheOnly });
      },
      fetchImpl: async url => {
        const observed = new Date(), pathname = new URL(url).pathname;
        sourceReads.push({ pathname, at: +observed });
        let value;
        if (pathname.endsWith('/Arrivals')) value = [{ id: 'synthetic-live', lineId: registration.lineID,
          naptanId: registration.stationID, stationName: 'Leyton Underground Station',
          destinationName: 'Epping Underground Station', destinationNaptanId: '940GZZLUEPG',
          expectedArrival: new Date(+observed + 120000).toISOString(), timestamp: observed.toISOString(),
          timing: { read: observed.toISOString() }, direction: 'Outbound', platformName: 'Eastbound - Platform 2' }];
        else if (pathname.endsWith('/Status')) value = [{ id: registration.lineID,
          lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }];
        else if (pathname.endsWith('/Disruption')) value = [];
        else if (pathname.includes('/JourneyResults/')) value = { journeys: [] };
        else assert.fail('Uncaptured synthetic board source: ' + pathname);
        return new Response(JSON.stringify(value), { headers: { date: observed.toUTCString(), age: '0', 'cache-control': 'public,max-age=30' } });
      },
      pushImpl: (record, payload, config, options) => {
        const content = payload.aps['content-state'];
        assert.equal(content.contentStateContract, 'station-board-v2');
        assert.ok(content.arrivals.length > 0, 'Fresh board must render qualified synthetic arrivals');
        return send('activities', options.signal, payload);
      } });
  });
  add('alerts', alertConfig.workerIntervalMs, 4000, async signal => {
    const at = new Date();
    const after = { lineID: 'central', lineName: 'Central', severity: 6, isDisrupted: true,
      status: 'Synthetic delay', reason: 'Local capacity fixture' };
    await alerts.enqueue([{ before: { isDisrupted: false }, after, fingerprint: `synthetic-${++alertSequence}` }],
      await alerts.activeRecords(at, alertConfig.inactivityMs), at);
    await runDisruptionAlertWorkerCycle({ store: alerts, config: alertConfig, now: at, signal, logger: silent,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
      pushImpl: (record, token, item, config, options) => send('alerts', options.signal, item.payload) });
  });
  add('widgets', widgetConfig.intervalMs, 6000, signal => runWidgetPushWorkerCycle({ store: widgets,
    config: widgetConfig, signal, pushImpl: async (record, token, config, options) => {
      assert.ok(options.isCurrent()); await send('widgets', options.signal, {}); return 'accepted';
    } }));
  return { workers, events, errors, sends, sourceReads, activityRuns, activityReruns, activity, alerts, widgets, transport,
    start() { for (const { worker } of workers) worker.start(); },
    async stop() { await Promise.all(workers.map(({ worker }) => worker.stop())); } };
}

// Pure evidence checks are also applied to the real run. A serialized producer
// or an empty worker loop cannot accidentally become a cohosting pass.
export function verifyOverlap({ start, end, events, sends, errors, workers, toleranceMs = 5000 }) {
  assert.ok(end > start); assert.deepEqual(errors, []);
  for (const { name, intervalMs, initialDelayMs } of workers) {
    const starts = events.filter(e => e.name === name && e.event === 'cycle-start' && e.at >= start && e.at < end);
    const completed = events.filter(e => e.name === name && e.event === 'cycle-complete' && e.at >= start && e.at < end);
    assert.ok(starts.length && completed.length, `${name}: no complete cycle overlapping producer`);
    assert.ok(sends.some(e => e.name === name && e.at >= start && e.at < end), `${name}: no real synthetic send during producer`);
    assert.ok(events.filter(e => e.name === name).every(e => e.state.running <= 1 && e.state.maximum <= 1), `${name}: concurrent cycles`);
    for (const completion of completed) {
      const beginning = starts.filter(e => e.at <= completion.at).at(-1);
      assert.ok(beginning && completion.at - beginning.at <= intervalMs, `${name}: cycle exceeds its production interval`);
    }
    // Existing initial and periodic timers are distinct, both anchored at start().
    const dues = [start + initialDelayMs, ...Array.from({ length: Math.floor((end - start) / intervalMs) }, (_, i) => start + (i + 1) * intervalMs)].sort((a,b) => a-b);
    const obligations = new Map();
    for (const due of dues.filter(due => due + toleranceMs < end)) {
      // Multiple triggers while one cycle is active legitimately share one
      // pending follow-up. Idle triggers require distinct actual starts.
      const active = starts.findIndex((beginning,index) => {
        const next = starts[index + 1];
        const finish = completed.find(completion => completion.at >= beginning.at && (!next || completion.at < next.at));
        return beginning.at < due && finish?.at > due;
      });
      const group = active < 0 ? `idle:${due}` : `pending:${active}`;
      const prior = obligations.get(group); obligations.set(group, { first: prior?.first ?? due, last: due });
    }
    const used = new Set();
    for (const { first, last } of obligations.values()) {
      const match = starts.findIndex((event,index) => !used.has(index) && event.at >= last && event.at <= first + toleranceMs);
      assert.ok(match >= 0, `${name}: missed production cadence (distinct cycle required)`); used.add(match);
    }
  }
}

export async function verifyCancellation(directory, { entryTimeoutMs = 5000, omitTrigger = null } = {}) {
  const entered = deferred(); let requests = 0;
  const transport = mockApns({ stalled: true, entered: () => { if (++requests === 3) entered.resolve(); } });
  const workload = await notificationWorkload(directory, transport);
  const pending = []; let timer, failure, elapsed;
  try {
    for (const { name, worker } of workload.workers) if (name !== omitTrigger) pending.push(worker.trigger());
    await Promise.race([entered.promise, new Promise((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation entry deadline: missing notification send')), entryTimeoutMs);
    })]);
    for (let i = 0; i < 30; i++) workload.workers.forEach(({ worker }, index) => assert.equal(worker.trigger(), pending[index]));
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    const start = performance.now();
    await workload.stop(); await Promise.allSettled(pending);
    elapsed = performance.now() - start;
  }
  const disposed = transport.sessions.every(({ session, request }) => session.destroyed && request.destroyed);
  if (!failure) try {
    assert.ok(elapsed <= 5000, 'Cancellation exceeds existing shutdown drain');
    const record = workload.activity.state.records[0]; assert.equal(record.lastPushAt, null); assert.equal(record.backoffUntil, null);
    assert.equal(workload.alerts.state.queue.length, 1); assert.equal(workload.alerts.state.queue[0].attempts, 0);
    assert.equal(workload.widgets.state.records[0].lastSuccessAt, undefined); assert.equal(workload.widgets.state.records[0].failures, 0);
    assert.equal(workload.widgets.state.records[0].claim, null);
    assert.equal(requests, 3, 'Pending reruns cannot dispatch after stop'); assert.deepEqual(workload.errors, []); assert.ok(disposed);
  } catch (error) { failure = error; }
  const result = { status: failure ? 'failed' : 'passed', failure: failure?.message, milliseconds: elapsed,
    requests, disposed, errors: workload.errors, states: { activity: workload.activity.state,
      alerts: workload.alerts.state, widgets: workload.widgets.state } };
  await fs.writeFile(path.join(directory, 'cancellation-result.json'), JSON.stringify(result, null, 2) + '\n');
  if (failure) throw failure;
  return { milliseconds: elapsed, unfinishedAcknowledged: false, retryConsumed: false, coalescedPendingDropped: true };
}

async function healthProbe() {
  const samples = [], errors = [];
  const server = http.createServer((request, response) => { response.writeHead(200); response.end('synthetic-health'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const worker = new SerialWorker({ initialDelayMs: 0, intervalMs: 1000,
    onError: error => errors.push(error.message), run: signal => new Promise((resolve, reject) => {
      const start = performance.now();
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/healthz', signal }, response => {
        response.resume(); response.on('end', () => {
          if (response.statusCode !== 200) { reject(new Error('Synthetic health response failed')); return; }
          samples.push({ at: start, milliseconds: performance.now() - start }); resolve();
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error('Existing health timeout exceeded')));
      request.on('error', reject);
    }) });
  return { samples, errors, start: () => worker.start(), stop: async () => {
    await worker.stop(); await new Promise(resolve => server.close(resolve));
  } };
}

const replay = String.raw`
import sys,json,hashlib
from pathlib import Path
from datetime import datetime
from urllib.parse import urlsplit,parse_qs
sys.path.insert(0,'/app/runtime/timetable-producer/scripts')
import tb085_prepare_renewal as p
import tb085_live_parity as live
root=Path(FIXTURE_DIRECTORY_JSON);fixture=json.loads((root/'fixture.json').read_text())
class CapturedDatetime(datetime):
 at=datetime.fromisoformat(fixture['clock'])
 @classmethod
 def now(cls,tz=None):return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)
p.datetime=p.monitor.datetime=live.datetime=CapturedDatetime
def identity(url):
 u=urlsplit(url);return u.scheme,u.hostname,u.path,parse_qs(u.query).get('direction')
def read(url,method,name=None):
 matches=[r for r in fixture['records'] if r['method']==method and identity(r['url'])==identity(url) and (name is None or r['name']==name)]
 if not matches:raise ValueError('Uncaptured transport boundary')
 r=matches[-1];raw=(root/r['body']).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==r['sha256']
 CapturedDatetime.at=datetime.fromisoformat(r['receivedAt'])
 return r,raw
def fetch(directory,name,url,limit,deadline,*,head=False,allowed=(200,)):
 r,raw=read(url,'HEAD' if head else 'GET',name)
 assert r['status'] in allowed and len(raw)<=limit
 target=directory/(name+'.body');target.write_bytes(raw)
 return {k:v for k,v in r.items() if k not in ('name','method')}|{'body':target.name,'bytes':len(raw)}
def request(url,method,limit):
 r,raw=read(url,method);assert r['status']==200 and len(raw)<=limit
 return {k.title():v for k,v in r['headers'].items()},raw
p.fetch=fetch;p.monitor.request=request
`;

export async function runImage(fixtureDirectory, evidence) {
  assert.ok(path.isAbsolute(fixtureDirectory) && path.isAbsolute(evidence));
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  assert.ok(!contains(fixtureDirectory, evidence) && !contains(evidence, fixtureDirectory),
    'Input and evidence directories must be disjoint');
  await fs.mkdir(evidence, { recursive: true });
  assert.deepEqual(await fs.readdir(evidence), [], 'Evidence directory must be empty');
  const cg = name => fs.readFile('/sys/fs/cgroup/' + name, 'utf8');
  assert.equal((await cg('memory.max')).trim(), '268435456');
  assert.equal((await cg('memory.swap.max')).trim(), '0');
  assert.equal((await cg('cpu.max')).trim(), '100000 100000');
  const fixtureBytes = await fs.readFile(path.join(fixtureDirectory, 'fixture.json'));
  const fixture = JSON.parse(fixtureBytes);
  assert.ok(fixture.records.length && fixture.scopes.length && fixture.scopes.length <= 32);
  const file = relative => { assert.ok(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..')); return path.join(fixtureDirectory, relative); };
  for (const record of fixture.records) assert.equal(sha(await fs.readFile(file(record.body))), record.sha256);
  const now = Date.parse(fixture.clock); assert.ok(Number.isFinite(now));
  const observation = { current: () => fixture.observation };
  const priorBytes = await fs.readFile(file(fixture.previousResource)), prior = JSON.parse(priorBytes);
  const priorDirectory = path.join(evidence, 'prior'), empty = path.join(evidence, 'empty-archives');
  await fs.mkdir(priorDirectory, { recursive: true }); await fs.mkdir(empty, { recursive: true });
  await fs.writeFile(path.join(priorDirectory, prior.publicationSHA256 + '.json'), priorBytes);
  const baseSourceIndex = await loadSourceBodyArchiveIndex({ publicationDirectory: priorDirectory, archiveDirectory: empty });
  const store = await new TimetablePublicationAdmissionStore({ directory: path.join(evidence, 'admission'),
    baselineSHA256: prior.publicationSHA256, publicationDirectory: priorDirectory, archiveDirectory: empty,
    observation, baseSourceIndex, now: () => now }).initialize();
  const cache = path.join(evidence, 'cache', fixture.publication); await fs.mkdir(cache, { recursive: true });
  assert.deepEqual(Object.keys(fixture.archive).sort(), ['metadata.json', 'receipt.json', 'source.zip']);
  for (const [target, source] of Object.entries(fixture.archive)) await fs.copyFile(file(source), path.join(cache, target));
  const replayPath = path.join(evidence, 'transport-replay.py');
  await fs.writeFile(replayPath, replay.replace('FIXTURE_DIRECTORY_JSON', JSON.stringify(fixtureDirectory)));
  const diagnostic = []; let diagnosticBytes = 0;
  const producer = new TimetableRecoveryProducer({ cacheDirectory: path.join(evidence, 'cache'),
    workDirectory: path.join(evidence, 'work'), admissionStore: store, now: () => now,
    readCurrentResource: identity => store.readPublicPublicationBytes(identity.publicationSHA256),
    spawnChild: (command, args, options) => {
      const job = JSON.parse(args.at(-1));
      job.launcher = `exec(open(${JSON.stringify(replayPath)}).read(),globals())\n` + job.launcher;
      const child = spawn(command, [...args.slice(0, -1), JSON.stringify(job)], options);
      child.stderr.on('data', chunk => {
        const remaining = 65536 - diagnosticBytes;
        if (remaining > 0) { const kept = chunk.subarray(0, remaining); diagnostic.push(kept); diagnosticBytes += kept.length; }
      });
      return child;
    } });
  const workload = await notificationWorkload(evidence), health = await healthProbe(), start = performance.now();
  workload.start(); health.start();
  let result;
  try {
    const recovered = await producer.recover({ publicationSHA256: fixture.publication, scopes: fixture.scopes });
    const end = performance.now(); assert.deepEqual(recovered, { unresolvedScopes: [] });
    assert.equal(store.latestAdmittedIdentity.publicationSHA256, fixture.publication);
    verifyOverlap({ ...workload, start, end });
    assert.deepEqual(health.errors, []); assert.ok(health.samples.length > 0);
    assert.ok(health.samples.every(sample => sample.milliseconds <= 5000), 'Existing health timeout exceeded');
    result = { status: 'passed', producerMilliseconds: end - start, identity: store.latestAdmittedIdentity };
  } catch (error) { result = { status: 'failed', reason: error.message, producerMilliseconds: performance.now() - start }; }
  finally { await workload.stop(); await health.stop(); }
  try { result.cancellation = await verifyCancellation(path.join(evidence, 'cancellation')); }
  catch (error) { result.status = 'failed'; result.cancellation = { failure: error.message }; }
  result.workers = workload.workers.map(({ name, intervalMs, initialDelayMs }) => ({ name, intervalMs, initialDelayMs }));
  result.events = workload.events; result.sends = workload.sends;
  result.board = { sourceReads: workload.sourceReads, activityRuns: workload.activityRuns, activityReruns: workload.activityReruns,
    lastPushAt: workload.activity.state.records[0]?.lastPushAt,
    contentDigest: workload.activity.state.records[0]?.lastBoardContentDigest,
    sources: workload.activity.state.records[0]?.stationBoardCache?.sources };
  result.fixtureSHA256 = sha(fixtureBytes);
  result.capturedTimetableClock = fixture.clock;
  result.notificationClock = 'Actual Date.now/performance.now with unchanged production intervals; no captured-clock injection';
  const bundleBytes = await fs.readFile(new URL('../runtime/timetable-producer/manifest.json', import.meta.url));
  result.bundle = { manifestSHA256: sha(bundleBytes), ...JSON.parse(bundleBytes) };
  result.harnessSHA256 = sha(await fs.readFile(new URL(import.meta.url)));
  result.health = { samples: health.samples, errors: health.errors, qualification: 'Synthetic loopback HTTP, not the production server' };
  result.memory = Object.fromEntries(await Promise.all(['memory.max', 'memory.peak', 'memory.events', 'cpu.max'].map(async name => [name, (await cg(name)).trim()])));
  if (!/(?:^|\n)oom_kill 0(?:\n|$)/.test(result.memory['memory.events'])
      || !/(?:^|\n)oom 0(?:\n|$)/.test(result.memory['memory.events'])) {
    result.status = 'failed'; result.memoryFailure = 'Observed cgroup OOM';
  }
  result.qualification = 'Captured-clock timetable replay and actual fresh synthetic station-board/alert/widget cycles only. No live provider, physical APNs, production activation, full registration load or spare-capacity claim.';
  await fs.writeFile(path.join(evidence, 'producer-child-diagnostic.txt'), Buffer.concat(diagnostic));
  await fs.writeFile(path.join(evidence, 'cohosting-result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [fixture, evidence] = process.argv.slice(2);
  runImage(fixture, evidence).then(result => { console.log(JSON.stringify(result)); if (result.status !== 'passed') process.exitCode = 1; }).catch(async error => {
    if (evidence) await fs.writeFile(path.join(evidence, 'cohosting-failure.json'), JSON.stringify({ status: 'failed', message: error.message }, null, 2) + '\n');
    console.error(error); process.exitCode = 1;
  });
}
