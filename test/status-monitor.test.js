import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  STATUS_SCHEMA_VERSION,
  STATUS_LINES,
  TubeBoardStatusMonitor,
  isExpectedServiceWindow,
  loadStatusConfig,
  renderStatusPage
} from '../server/status-monitor.js';

const schemaPath = new URL('../contracts/tubeboard-status-v1.schema.json', import.meta.url);

const midday = new Date('2026-08-10T12:00:00Z');

test('starts unknown without making a live request', () => {
  const monitor = makeMonitor();
  const snapshot = monitor.getSnapshot();

  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.checker.state, 'starting');
  assert.equal(snapshot.checkedAt, null);
  assert.equal(snapshot.lines.length, 11);
});

test('versioned public status schema matches generated response fields', async () => {
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const snapshot = makeMonitor().getSnapshot();

  assert.equal(schema['x-tubeboard-contract-version'], STATUS_SCHEMA_VERSION);
  assert.equal(snapshot.schemaVersion, STATUS_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(snapshot).sort(), schema.required.sort());
  assert.deepEqual(Object.keys(snapshot.checker).sort(), schema.properties.checker.required.sort());
  assert.equal(snapshot.lines.length, 11);
  assert.deepEqual(Object.keys(snapshot.lines[0]).sort(), schema.$defs.line.required.sort());
  assert.deepEqual(Object.keys(snapshot.lines[0].official).sort(), schema.$defs.official.required.sort());
  assert.deepEqual(Object.keys(snapshot.lines[0].tubeBoard).sort(), schema.$defs.tubeBoard.required.sort());
});

test('one bounded cycle reports operational data separately from TfL status', async () => {
  const requestUrls = [];
  const sleeps = [];
  const monitor = makeMonitor({
    fetchImpl: healthyFetch({ requestUrls, disruptedLineID: 'district' }),
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  await monitor.runCycle();
  const snapshot = monitor.getSnapshot();

  assert.equal(requestUrls.length, 23);
  assert.equal(sleeps.length, 22);
  assert.ok(sleeps.every((milliseconds) => milliseconds === 2_000));
  assert.equal(snapshot.state, 'operational');
  assert.equal(snapshot.lines.find((line) => line.id === 'district').official.state, 'disrupted');
  assert.equal(snapshot.lines.find((line) => line.id === 'district').tubeBoard.state, 'operational');
  assert.equal(snapshot.checker.requestBudgetPerCycle, 23);
  assert.equal(snapshot.checker.scheduledFullSweep, false);
});

test('Circle probes use stations whose TfL arrivals identify Circle trains', () => {
  const circle = STATUS_LINES.find((line) => line.id === 'circle');

  assert.deepEqual(circle.stations, ['940GZZLUERC', '940GZZLUBST']);
  assert.ok(!circle.stations.includes('940GZZLUTWH'));
  assert.ok(!circle.stations.includes('940GZZLUALD'));
});

test('requires three unhealthy windows to degrade and two healthy windows to recover', async () => {
  let responseMode = 'empty';
  const monitor = makeMonitor({
    fetchImpl: async (url) => responseMode === 'empty'
      ? responseFor(url, { emptyArrivals: true })
      : responseFor(url),
    sleep: async () => {}
  });

  await monitor.runCycle();
  await monitor.runCycle();
  assert.equal(lineState(monitor, 'central'), 'unknown');

  await monitor.runCycle();
  assert.equal(lineState(monitor, 'central'), 'degraded');

  responseMode = 'healthy';
  await monitor.runCycle();
  assert.equal(lineState(monitor, 'central'), 'degraded');
  await monitor.runCycle();
  assert.equal(lineState(monitor, 'central'), 'operational');
});

test('empty checks do not degrade outside the evidence window', async () => {
  const overnight = new Date('2026-08-10T03:00:00Z');
  const monitor = makeMonitor({
    now: () => overnight,
    fetchImpl: async (url) => responseFor(url, { emptyArrivals: true }),
    sleep: async () => {}
  });

  await monitor.runCycle();
  await monitor.runCycle();
  await monitor.runCycle();

  assert.equal(isExpectedServiceWindow(overnight), false);
  assert.equal(lineState(monitor, 'central'), 'unknown');
});

test('empty checks during an official disruption remain unknown rather than degraded', async () => {
  const monitor = makeMonitor({
    fetchImpl: healthyFetch({ emptyArrivals: true, disruptEveryLine: true }),
    sleep: async () => {}
  });

  await monitor.runCycle();
  await monitor.runCycle();
  await monitor.runCycle();

  assert.equal(lineState(monitor, 'central'), 'unknown');
  assert.equal(monitor.getSnapshot().lines[0].official.state, 'disrupted');
});

test('a current snapshot becomes unknown after fifteen minutes', async () => {
  let current = midday;
  const monitor = makeMonitor({
    now: () => current,
    fetchImpl: healthyFetch(),
    sleep: async () => {}
  });

  await monitor.runCycle();
  assert.equal(monitor.getSnapshot().state, 'operational');

  current = new Date(midday.getTime() + 16 * 60 * 1000);
  const stale = monitor.getSnapshot();
  assert.equal(stale.state, 'unknown');
  assert.equal(stale.checker.state, 'stale');
  assert.ok(stale.lines.every((line) => line.tubeBoard.state === 'unknown'));
});

test('TfL rate limiting returns bounded backoff and unknown status', async () => {
  const monitor = makeMonitor({
    fetchImpl: async () => fakeResponse([], { status: 429, headers: { 'retry-after': '900' } }),
    sleep: async () => {}
  });

  const result = await monitor.runCycle();
  assert.equal(result.backoffMs, 15 * 60 * 1000);
  assert.equal(monitor.getSnapshot().state, 'unknown');
});

test('a station 429 aborts the remaining shared-key sweep immediately', async () => {
  const requestUrls = [];
  const sleeps = [];
  const monitor = makeMonitor({
    fetchImpl: async (url) => {
      requestUrls.push(String(url));
      if (String(url).includes('/Status')) {
        return responseFor(url);
      }
      return fakeResponse([], { status: 429, headers: { 'retry-after': '600' } });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  const result = await monitor.runCycle();

  assert.equal(result.backoffMs, 10 * 60 * 1000);
  assert.equal(monitor.getSnapshot().state, 'unknown');
  assert.equal(requestUrls.length, 2);
  assert.equal(sleeps.length, 1);
});

test('status page is server-rendered, highlights a canonical line and escapes notices', () => {
  const monitor = makeMonitor({
    config: makeConfig({ notice: '<script>alert(1)</script>' })
  });
  const html = renderStatusPage(monitor.getSnapshot(), 'central');

  assert.match(html, /<!doctype html>/);
  assert.match(html, /id="line-central" aria-current="true"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /One empty response never declares a line outage/);
});

test('production status configuration is opt-in and rate bounds cannot be weakened', () => {
  const disabled = loadStatusConfig({});
  const bounded = loadStatusConfig({
    TUBEBOARD_STATUS_MONITOR_ENABLED: 'true',
    TUBEBOARD_STATUS_INTERVAL_MS: '1',
    TUBEBOARD_STATUS_REQUEST_SPACING_MS: '1',
    TUBEBOARD_STATUS_NOTICE: '  Known   issue  '
  });

  assert.equal(disabled.enabled, false);
  assert.equal(bounded.enabled, true);
  assert.equal(bounded.intervalMs, 5 * 60 * 1000);
  assert.equal(bounded.requestSpacingMs, 2_000);
  assert.equal(bounded.notice, 'Known issue');
});

function makeMonitor(overrides = {}) {
  return new TubeBoardStatusMonitor({
    config: makeConfig(),
    fetchImpl: healthyFetch(),
    now: () => midday,
    sleep: async () => {},
    logger: { warn() {} },
    ...overrides
  });
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    intervalMs: 5 * 60 * 1000,
    staleAfterMs: 15 * 60 * 1000,
    requestSpacingMs: 2_000,
    requestTimeoutMs: 8_000,
    tflAppKey: '',
    notice: null,
    ...overrides
  };
}

function healthyFetch(options = {}) {
  return async (url) => {
    options.requestUrls?.push(String(url));
    return responseFor(url, options);
  };
}

function responseFor(url, options = {}) {
  const pathname = new URL(url).pathname;
  if (pathname === '/Line/Mode/tube/Status') {
    const statuses = STATUS_LINES.map((line) => {
      const disrupted = options.disruptEveryLine || line.id === options.disruptedLineID;
      return {
        id: line.id,
        lineStatuses: [{
          statusSeverity: disrupted ? 5 : 10,
          statusSeverityDescription: disrupted ? 'Planned Closure' : 'Good Service',
          reason: disrupted ? `${line.name} line: planned engineering work.` : ''
        }]
      };
    });
    return fakeResponse(statuses);
  }

  if (options.emptyArrivals) {
    return fakeResponse([]);
  }

  const stationID = decodeURIComponent(pathname.split('/')[2] || '');
  const matchingLines = STATUS_LINES.filter((line) => line.stations.includes(stationID));
  return fakeResponse(matchingLines.map((line, index) => ({
    id: `${line.id}-${stationID}-${index}`,
    lineId: line.id,
    timeToStation: 120 + index
  })));
}

function fakeResponse(value, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() { return value; }
  };
}

function lineState(monitor, lineID) {
  return monitor.getSnapshot().lines.find((line) => line.id === lineID).tubeBoard.state;
}
