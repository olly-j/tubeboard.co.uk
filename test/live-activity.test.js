import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildApnsPayload,
  buildContentState,
  getRolloverDelayMs,
  LiveActivityStore,
  loadConfig,
  normalizePlatformID,
  runLiveActivityWorkerCycle,
  validateEndPayload,
  validateTokenPayload
} from '../server/live-activity.js';

const validTokenPayload = {
  installID: 'A7D20A75-1F4E-4C4E-AF64-2D6D6E2FB1E9',
  activityID: 'E8C5C7A6-2E62-4F22-A35F-2C5A3F9A7D35',
  stationID: '940GZZLULYN',
  lineID: 'central',
  pushTokenHex: '7f2a'.repeat(16),
  tokenUpdatedAt: '2026-06-14T15:20:00Z',
  appBundleID: 'OllyJ.My-Train-Times',
  appVersion: '1.0',
  buildNumber: '1',
  environment: 'production'
};

const platformTokenPayload = {
  ...validTokenPayload,
  selectionMode: 'platform',
  platformID: 'eastbound-platform-2',
  platformHeading: 'Eastbound - Platform 2',
  platformLabel: 'Platform 2',
  platformDirection: 'Eastbound'
};

test('validates token registration payloads', () => {
  assert.equal(validateTokenPayload(validTokenPayload).ok, true);
  assert.equal(validateTokenPayload(platformTokenPayload).ok, true);
  assert.equal(validateTokenPayload({ ...validTokenPayload, platformID: 'eastbound-platform-2' }).value.selectionMode, 'platform');
  assert.equal(validateTokenPayload(validTokenPayload).value.selectionMode, 'allPlatforms');

  const invalid = validateTokenPayload({
    ...validTokenPayload,
    lineID: 'overground',
    pushTokenHex: 'not-a-token'
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /lineID/);
  assert.match(invalid.errors.join('\n'), /pushTokenHex/);

  const invalidSelection = validateTokenPayload({
    ...validTokenPayload,
    selectionMode: 'station'
  });
  assert.equal(invalidSelection.ok, false);
  assert.match(invalidSelection.errors.join('\n'), /selectionMode/);

  const missingPlatform = validateTokenPayload({
    ...validTokenPayload,
    selectionMode: 'platform'
  });
  assert.equal(missingPlatform.ok, false);
  assert.match(missingPlatform.errors.join('\n'), /platformID/);
});

test('validates activity end payloads', () => {
  assert.equal(validateEndPayload({
    installID: validTokenPayload.installID,
    activityID: validTokenPayload.activityID,
    endedAt: '2026-06-14T16:05:00Z',
    reason: 'userEnded'
  }).ok, true);

  assert.equal(validateEndPayload({ installID: '', activityID: '' }).ok, false);
});

test('builds ContentState with Swift Date JSON numbers', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    validTokenPayload,
    [
      {
        id: 'central-1',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:22:00Z'
      },
      {
        id: 'district-1',
        lineId: 'district',
        stationName: 'Leyton Underground Station',
        destinationName: 'Richmond Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      }
    ],
    [
      {
        id: 'central',
        lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }]
      }
    ],
    now
  );

  assert.equal(contentState.stationName, 'Leyton');
  assert.equal(contentState.lineName, 'Central');
  assert.equal(contentState.platform, 'Eastbound - Platform 2');
  assert.equal(contentState.arrivals.length, 1);
  assert.equal(contentState.arrivals[0].destination, 'Epping');
  assert.equal(contentState.arrivals[0].countdownText, '02:00');
  assert.equal(typeof contentState.updatedAt, 'number');
  assert.equal(typeof contentState.arrivals[0].expectedArrival, 'number');
});

test('keeps platform-specific Live Activities on the selected platform', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    platformTokenPayload,
    [
      {
        id: 'central-1',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      },
      {
        id: 'central-2',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:22:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(contentState.platform, 'Eastbound - Platform 2');
  assert.equal(contentState.arrivals.length, 1);
  assert.equal(contentState.arrivals[0].id, 'central-2');
  assert.equal(contentState.arrivals[0].destination, 'Epping');
});

test('does not fall back to all platforms when the selected platform is empty', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    platformTokenPayload,
    [
      {
        id: 'central-1',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(contentState.platform, 'Eastbound - Platform 2');
  assert.deepEqual(contentState.arrivals, []);
  assert.equal(contentState.staleAt, contentState.updatedAt + 300);
});

test('allPlatforms mode keeps next station departures by time', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    { ...validTokenPayload, selectionMode: 'allPlatforms' },
    [
      {
        id: 'central-late',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:24:00Z'
      },
      {
        id: 'central-soon',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(contentState.arrivals.length, 2);
  assert.equal(contentState.arrivals[0].id, 'central-soon');
  assert.equal(contentState.arrivals[1].id, 'central-late');
});

test('removes arrivals that are due within the expiry grace window', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    { ...validTokenPayload, selectionMode: 'allPlatforms' },
    [
      {
        id: 'already-due',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:20:05Z'
      },
      {
        id: 'next-future',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:20:20Z'
      },
      {
        id: 'later-future',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Hainault Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(contentState.arrivals.length, 2);
  assert.equal(contentState.arrivals[0].id, 'next-future');
  assert.equal(contentState.arrivals[1].id, 'later-future');
});

test('platform mode sends empty arrivals when selected platform has no future arrivals', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    platformTokenPayload,
    [
      {
        id: 'selected-due',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:20:05Z'
      },
      {
        id: 'other-platform-future',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:22:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(contentState.platform, 'Eastbound - Platform 2');
  assert.deepEqual(contentState.arrivals, []);
  assert.equal(contentState.staleAt, contentState.updatedAt + 300);
});

test('computes rollover delay when first arrival is due before next worker cycle', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const contentState = buildContentState(
    { ...validTokenPayload, selectionMode: 'allPlatforms' },
    [
      {
        id: 'soon',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Epping Underground Station',
        expectedArrival: '2026-06-14T15:20:20Z'
      },
      {
        id: 'later',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Eastbound - Platform 2',
        destinationName: 'Hainault Underground Station',
        expectedArrival: '2026-06-14T15:22:00Z'
      }
    ],
    [{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
    now
  );

  assert.equal(getRolloverDelayMs(contentState, now, 90_000), 30_000);
  assert.equal(getRolloverDelayMs(contentState, now, 25_000), null);
});

test('normalizes platform headings like the app', () => {
  assert.equal(normalizePlatformID('Eastbound - Platform 2'), 'eastbound-platform-2');
  assert.equal(normalizePlatformID('North & South and Platform 3'), 'north-south-platform-3');
});

test('builds APNs envelope with Unix timestamps', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const payload = buildApnsPayload({ updatedAt: 803832000 }, now);

  assert.equal(payload.aps.timestamp, Math.floor(now.getTime() / 1000));
  assert.equal(payload.aps.event, 'update');
  assert.equal(payload.aps['content-state'].updatedAt, 803832000);
  assert.equal(payload.aps['stale-date'], Math.floor(now.getTime() / 1000) + 300);
});

test('platform empty arrivals still produce heartbeat pushes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubeboard-live-activity-'));
  const store = new LiveActivityStore(path.join(tempDir, 'records.json'));
  const now = new Date();
  await store.upsertToken(platformTokenPayload, now);
  store.state.records[0].consecutiveEmptyCycles = 12;
  await store.save();

  const pushed = [];
  const fetchImpl = async (url) => {
    const urlString = String(url);
    if (urlString.includes('/Status')) {
      return jsonResponse([{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }]);
    }

    return jsonResponse([
      {
        id: 'wrong-platform',
        lineId: 'central',
        stationName: 'Leyton Underground Station',
        platformName: 'Westbound - Platform 1',
        destinationName: 'White City Underground Station',
        expectedArrival: '2026-06-14T15:21:00Z'
      }
    ]);
  };

  await runLiveActivityWorkerCycle({
    store,
    config: loadConfig({ LIVE_ACTIVITY_DATA_FILE: path.join(tempDir, 'records.json') }),
    fetchImpl,
    pushImpl: async (record, payload) => {
      pushed.push({ record, payload });
      return { status: 200 };
    },
    logger: silentLogger()
  });

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.aps['content-state'].platform, 'Eastbound - Platform 2');
  assert.deepEqual(pushed[0].payload.aps['content-state'].arrivals, []);
  assert.equal(pushed[0].payload.aps['content-state'].staleAt, pushed[0].payload.aps['content-state'].updatedAt + 300);
  assert.equal(pushed[0].payload.aps['stale-date'], pushed[0].payload.aps.timestamp + 300);
});

test('allPlatforms repeated empty arrivals can still back off', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubeboard-live-activity-'));
  const store = new LiveActivityStore(path.join(tempDir, 'records.json'));
  await store.upsertToken({ ...validTokenPayload, selectionMode: 'allPlatforms' }, new Date());
  store.state.records[0].consecutiveEmptyCycles = 12;
  await store.save();

  const pushed = [];
  const fetchImpl = async (url) => {
    const urlString = String(url);
    if (urlString.includes('/Status')) {
      return jsonResponse([{ id: 'central', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }]);
    }

    return jsonResponse([]);
  };

  await runLiveActivityWorkerCycle({
    store,
    config: loadConfig({ LIVE_ACTIVITY_DATA_FILE: path.join(tempDir, 'records.json') }),
    fetchImpl,
    pushImpl: async (record, payload) => {
      pushed.push({ record, payload });
      return { status: 200 };
    },
    logger: silentLogger()
  });

  assert.equal(pushed.length, 0);
  assert.equal(store.state.records[0].backoffReason, 'emptyArrivals');
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    }
  };
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
