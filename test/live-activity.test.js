import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApnsPayload,
  buildContentState,
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

test('validates token registration payloads', () => {
  assert.equal(validateTokenPayload(validTokenPayload).ok, true);

  const invalid = validateTokenPayload({
    ...validTokenPayload,
    lineID: 'overground',
    pushTokenHex: 'not-a-token'
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /lineID/);
  assert.match(invalid.errors.join('\n'), /pushTokenHex/);
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

test('builds APNs envelope with Unix timestamps', () => {
  const now = new Date('2026-06-14T15:20:00Z');
  const payload = buildApnsPayload({ updatedAt: 803832000 }, now);

  assert.equal(payload.aps.timestamp, Math.floor(now.getTime() / 1000));
  assert.equal(payload.aps.event, 'update');
  assert.equal(payload.aps['content-state'].updatedAt, 803832000);
  assert.equal(typeof payload.aps['stale-date'], 'number');
});
