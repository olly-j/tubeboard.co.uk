// Black-box local service probe. Uses only synthetic contract fixtures and a
// private operator lease; all outbound workers are disabled. No production I/O.
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const repoDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error('Local probe readiness deadline'); await delay(5); }
}
export async function probeHTTPDrain({ nodePath = process.execPath, repoRoot = repoDefault,
  connection = 'default', clients = 1, stalled = false, optOut = false, completionDelayMs = 50 } = {}) {
  if (!['default', 'close'].includes(connection) || ![1, 3].includes(clients) || !Number.isSafeInteger(completionDelayMs) || completionDelayMs < 0 || completionDelayMs > 1500) throw Error('Invalid local probe case');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tb-http-drain-')));
  const configPath = path.join(directory, 'operator.json');
  const installID = '00000000-0000-4000-8000-000000000001';
  await fs.writeFile(configPath, JSON.stringify({ ownedInstallID: installID, expiresAt: new Date(Date.now() + 90000).toISOString() }), { mode: 0o600 });
  const dataFile = path.join(directory, 'activities.json');
  const child = spawn(nodePath, ['server/index.js'], { cwd: repoRoot, env: {
    PATH: process.env.PATH, TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(), PORT: '0',
    LIVE_ACTIVITY_WORKER_ENABLED: 'false', DISRUPTION_ALERT_WORKER_ENABLED: 'false', WIDGET_PUSH_WORKER_ENABLED: 'false', TUBEBOARD_STATUS_MONITOR_ENABLED: 'false',
    TUBEBOARD_TIMETABLE_EDITION_MONITOR_ENABLED: 'false', TUBEBOARD_TIMETABLE_PUBLICATION_ALERT_ENABLED: 'false',
    LIVE_ACTIVITY_DATA_FILE: dataFile, DISRUPTION_ALERT_DATA_FILE: path.join(directory, 'alerts.json'), TUBEBOARD_OPERATOR_OBSERVATION_CONFIG: configPath
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '', observer; const requests = [], frames = [];
  child.stderr.on('data', data => { stderr += data; });
  const outerDeadline = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const port = await new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', data => { output += data; const match = /localhost:(\d+)/.exec(output); if (match) resolve(Number(match[1])); }); child.once('error', reject); child.once('exit', () => reject(Error('Local probe service exited before ready'))); });
    const socketPath = path.join(directory, 'operator-observation.sock');
    await until(async () => { try { return (await fs.stat(socketPath)).isSocket(); } catch { return false; } });
    for (let attempt = 0; attempt < 4; attempt++) {
      observer = net.createConnection(socketPath); observer.on('error', () => {}); let raw = '';
      observer.on('data', data => { raw += data; let end; while ((end = raw.indexOf('\n')) >= 0) { frames.push(JSON.parse(raw.slice(0, end))); raw = raw.slice(end + 1); } });
      try { await until(() => frames.length || observer.destroyed, 1000); if (frames.length) break; } catch { /* retry pre-readiness only */ }
      observer.destroy();
    }
    if (!frames.length) throw Error('Local observer unavailable');
    const fixture = JSON.parse(await fs.readFile(path.join(repoRoot, 'contracts/fixtures/live-activity-registration-v1.json')));
    const route = optOut ? '/api/live-activities/end' : '/api/live-activities/tokens';
    const payloads = Array.from({ length: clients }, (_, index) => ({ ...fixture, installID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      activityID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, tokenUpdatedAt: new Date().toISOString() }));
    if (optOut) {
      for (const payload of payloads) {
        const response = await fetch(`http://127.0.0.1:${port}/api/live-activities/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(payload) });
        if (response.status !== 200 || !(await response.json()).ok) throw Error('Local synthetic seed rejected');
      }
    }
    const pending = payloads.map(payload => {
      const body = JSON.stringify(optOut ? { installID: payload.installID, activityID: payload.activityID, reason: 'user-ended' } : payload);
      let request;
      const result = new Promise(resolve => {
        request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', ...(connection === 'close' ? { Connection: 'close' } : {}) } }, response => {
          let text = ''; response.on('data', data => { text += data; }); response.on('end', () => resolve({ status: response.statusCode, ok: JSON.parse(text).ok, connection: response.headers.connection }));
        });
        request.on('error', error => resolve({ error: error.code })); request.write(body.slice(0, 10));
      });
      requests.push(request); return { request, body, result };
    });
    await until(() => frames.at(-1)?.http.inFlight === clients);
    const started = Date.now(); child.kill('SIGTERM');
    await until(() => frames.some(frame => frame.http.shutdown && frame.http.inFlight === clients));
    if (!stalled) for (let index = 0; index < pending.length; index++) { await delay(index === 0 ? completionDelayMs : 50); pending[index].request.end(pending[index].body.slice(10)); }
    const [code, signal] = await exited;
    const responses = await Promise.all(pending.map(item => item.result));
    let records = [];
    try { records = JSON.parse(await fs.readFile(dataFile)).records; } catch { /* stalled body has no write */ }
    return { nodeVersion: execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim(), connection, clients, stalled, optOut, completionDelayMs,
      code, signal, drainElapsedMs: Date.now() - started, responses,
      persistedRecords: records.length, endedRecords: records.filter(record => record.active === false && record.endedAt).length,
      deadlineObserved: frames.some(frame => frame.http.deadline), drainingInFlightObserved: frames.some(frame => frame.http.shutdown && frame.http.inFlight === clients), stderrEmpty: stderr.length === 0 };
  } finally {
    clearTimeout(outerDeadline); for (const request of requests) request.destroy(); observer?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
