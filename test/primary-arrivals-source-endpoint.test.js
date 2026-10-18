import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { PRIMARY_ARRIVALS_PATH } from '../server/primary-arrivals-source.js';

test('actual service route is disabled by default, bounded and isolated from existing endpoints', { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-primary-http-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, PORT: '0', LIVE_ACTIVITY_WORKER_ENABLED: 'false',
      DISRUPTION_ALERT_WORKER_ENABLED: 'false', TUBEBOARD_STATUS_MONITOR_ENABLED: 'false',
      LIVE_ACTIVITY_DATA_FILE: path.join(directory, 'activities.json'),
      DISRUPTION_ALERT_DATA_FILE: path.join(directory, 'alerts.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(timer); }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local service listen timeout')), 5000);
    let output = '';
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(Error('Local service ended before listen')); });
    child.stdout.on('data', bytes => {
      output = (output + bytes).slice(-4096);
      const match = /http:\/\/localhost:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const request = async (suffix, options) => fetch(origin + suffix, { ...options, signal: AbortSignal.timeout(3000) });
  const disabled = await request(PRIMARY_ARRIVALS_PATH);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.headers.get('cache-control'), 'no-store');
  assert.equal(disabled.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await disabled.json(), { schemaVersion: 1, sourceID: 'trackernet-arrivals-v1',
    stationID: '940GZZLUWOF', lineID: 'central', status: 'unavailable', reason: 'disabled' });
  const method = await request(PRIMARY_ARRIVALS_PATH, { method: 'POST' });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  assert.equal((await method.json()).reason, 'unsupportedMethod');
  const query = await request(PRIMARY_ARRIVALS_PATH + '?url=https%3A%2F%2Fexample.com');
  assert.equal(query.status, 400); assert.equal((await query.json()).reason, 'unsupportedQuery');
  const foreign = await request('/api/primary-arrivals/v1/northern/940GZZLUEGW');
  assert.equal(foreign.status, 404); assert.equal((await foreign.json()).reason, 'unsupportedSelection');
  const badHost = await new Promise((resolve, reject) => {
    const raw = http.get(new URL(PRIMARY_ARRIVALS_PATH, origin), { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    raw.setTimeout(3000, () => raw.destroy(Error('Local Host control timeout')));
    raw.once('error', reject);
  });
  assert.equal(badHost, 400);
  const health = await request('/healthz');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  for (const route of ['/privacy', '/support']) assert.equal((await request(route)).status, 200, route);
  assert.equal((await request('/server/primary-arrivals-source.js')).status, 404);
  assert.deepEqual(await fs.readdir(directory), [], 'disabled route does not create token or source stores');
});
