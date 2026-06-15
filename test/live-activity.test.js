import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApnsPayload,
  buildContentState,
  normalizePlatformID,
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
  assert.equal(typeof payload.aps['stale-date'], 'number');
});
