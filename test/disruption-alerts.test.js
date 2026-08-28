import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DISRUPTION_ALERT_CONTRACT_VERSION,
  DISRUPTION_ALERT_LINES,
  DisruptionAlertStore,
  buildAlertPayload,
  loadAppleRootCertificates,
  normalizeTubeStatuses,
  runDisruptionAlertWorkerCycle,
  shouldNotify,
  validateDeletePayload,
  validateRegistrationPayload,
  verifyPremiumTransaction
} from '../server/disruption-alerts.js';

const now = new Date('2026-08-10T12:00:00.000Z');
const encryptionKey = Buffer.alloc(32, 7);
const deviceToken = '01'.repeat(32);

test('registration and deletion validation fail closed', () => {
  const valid = registrationPayload();
  assert.equal(validateRegistrationPayload(valid).ok, true);
  assert.equal(validateDeletePayload({ contractVersion: 1, installID: valid.installID }).ok, true);
  assert.equal(validateDeletePayload({ contractVersion: 2, installID: valid.installID }).ok, true);

  const invalid = validateRegistrationPayload({
    ...valid,
    appBundleID: 'com.example.other',
    selectedLineIDs: ['central', 'central'],
    severity: 'anything',
    timeZone: 'Not/A-Time-Zone'
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /appBundleID/);
  assert.match(invalid.errors.join('\n'), /selectedLineIDs/);
  assert.match(invalid.errors.join('\n'), /severity/);
  assert.match(invalid.errors.join('\n'), /timeZone/);
});

test('contract v1 remains Tube-only while v2 accepts every named Overground line', () => {
  const overgroundLineIDs = ['liberty', 'lioness', 'mildmay', 'suffragette', 'weaver', 'windrush'];
  const v1 = validateRegistrationPayload(registrationPayload({ selectedLineIDs: overgroundLineIDs }));
  const v2 = validateRegistrationPayload(registrationPayload({
    contractVersion: 2,
    selectedLineIDs: [...DISRUPTION_ALERT_LINES.keys()]
  }));

  assert.equal(DISRUPTION_ALERT_CONTRACT_VERSION, 2);
  assert.equal(v1.ok, false);
  assert.match(v1.errors.join('\n'), /contract v1/);
  assert.equal(v2.ok, true, v2.errors.join('\n'));
  assert.equal(v2.value.selectedLineIDs.length, 17);
  assert.deepEqual(
    overgroundLineIDs.filter((lineID) => !v2.value.selectedLineIDs.includes(lineID)),
    []
  );
});

test('bundled Apple roots are the expected official G2 and G3 certificates', async () => {
  const certificates = await loadAppleRootCertificates();
  assert.equal(certificates.length, 2);
  assert.ok(certificates.every((certificate) => Buffer.isBuffer(certificate)));
  assert.deepEqual(
    certificates.map((certificate) => new X509Certificate(certificate).fingerprint256),
    [
      'C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50',
      '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79'
    ]
  );
});

test('Premium verification accepts only current TubeBoard products for this app', async () => {
  const config = { bundleId: 'OllyJ.My-Train-Times' };
  const validTransaction = {
    bundleId: config.bundleId,
    productId: 'uk.net.jeffers.tubeboard.premium.yearly',
    expiresDate: now.getTime() + 60_000
  };
  const verifierFactory = transactionVerifier(validTransaction);
  const entitlement = await verifyPremiumTransaction('signed', 'sandbox', config, now, verifierFactory);
  assert.deepEqual(entitlement, {
    productID: validTransaction.productId,
    expiresAt: '2026-08-10T12:01:00.000Z',
    verifiedAt: now.toISOString()
  });

  await assert.rejects(
    verifyPremiumTransaction('signed', 'sandbox', config, now, transactionVerifier({
      ...validTransaction,
      bundleId: 'com.example.other'
    })),
    /different app/
  );
  await assert.rejects(
    verifyPremiumTransaction('signed', 'sandbox', config, now, transactionVerifier({
      ...validTransaction,
      productId: 'com.example.premium'
    })),
    /unsupported product/
  );
  await assert.rejects(
    verifyPremiumTransaction('signed', 'sandbox', config, now, transactionVerifier({
      ...validTransaction,
      expiresDate: now.getTime()
    })),
    /expired/
  );
  await assert.rejects(
    verifyPremiumTransaction('signed', 'sandbox', config, now, transactionVerifier({
      ...validTransaction,
      revocationDate: now.getTime()
    })),
    /revoked/
  );
});

test('registration persistence encrypts tokens, hashes identifiers, replaces duplicate tokens and deletes immediately', async () => {
  const { store, filePath } = await temporaryStore();
  const first = registrationPayload();
  const entitlement = premiumEntitlement();
  await store.upsert(first, entitlement, now);

  const storedText = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(storedText, new RegExp(deviceToken));
  assert.doesNotMatch(storedText, new RegExp(first.installID));
  assert.equal(store.state.records.length, 1);
  assert.equal(store.decryptedToken(store.state.records[0]), deviceToken);

  const second = registrationPayload({
    installID: 'f15fb63a-4d90-4be9-a69e-e0e70f810789',
    selectedLineIDs: ['victoria']
  });
  await store.upsert(second, entitlement, new Date(now.getTime() + 1_000));
  assert.equal(store.state.records.length, 1);
  assert.deepEqual(store.state.records[0].selectedLineIDs, ['victoria']);

  assert.equal(await store.deleteByInstallID(second.installID), true);
  assert.equal(store.state.records.length, 0);
});

test('inactive and expired registrations are removed with their pending queue', async () => {
  const { store } = await temporaryStore();
  const payload = registrationPayload();
  await store.upsert(payload, premiumEntitlement(), now);
  store.state.queue.push({
    id: 'queued',
    installDigest: store.state.records[0].installDigest,
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
  await store.save();

  await store.purgeExpired(new Date(now.getTime() + 91 * 24 * 60 * 60 * 1000));
  assert.equal(store.state.records.length, 0);
  assert.equal(store.state.queue.length, 0);
});

test('TfL status changes require two matching observations before notification', async () => {
  const { store } = await temporaryStore();
  const good = lineStatus({ severity: 10, description: 'Good Service' });
  const disrupted = lineStatus({ severity: 6, description: 'Severe Delays', reason: 'Signal failure' });

  assert.deepEqual(await store.observeStatuses(normalizeTubeStatuses(good), now), []);
  assert.deepEqual(await store.observeStatuses(normalizeTubeStatuses(good), now), []);
  assert.deepEqual(await store.observeStatuses(normalizeTubeStatuses(disrupted), now), []);
  const transitions = await store.observeStatuses(normalizeTubeStatuses(disrupted), now);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].before.isDisrupted, false);
  assert.equal(transitions[0].after.status, 'Severe Delays');
});

test('Overground status is normalized with its official named-line identity', () => {
  const statuses = normalizeTubeStatuses([{
    id: 'windrush',
    name: 'Windrush',
    lineStatuses: [{
      statusSeverity: 9,
      statusSeverityDescription: 'Minor Delays',
      reason: 'A points failure'
    }]
  }]);

  assert.deepEqual(statuses, [{
    lineID: 'windrush',
    lineName: 'Windrush',
    severity: 9,
    status: 'Minor Delays',
    reason: 'A points failure',
    isDisrupted: true
  }]);
});

test('severity, recovery and overnight quiet-hour preferences are enforced', () => {
  const severeTransition = transition({ beforeSeverity: 10, afterSeverity: 6 });
  const minorTransition = transition({ beforeSeverity: 10, afterSeverity: 9 });
  const recoveryTransition = transition({ beforeSeverity: 6, afterSeverity: 10 });
  const record = preferenceRecord();

  assert.equal(shouldNotify(record, severeTransition, now), true);
  assert.equal(shouldNotify(record, minorTransition, now), false);
  assert.equal(shouldNotify({ ...record, severity: 'allDisruptions' }, minorTransition, now), true);
  assert.equal(shouldNotify(record, recoveryTransition, now), true);
  assert.equal(shouldNotify({ ...record, serviceResumedAlerts: false }, recoveryTransition, now), false);
  assert.equal(shouldNotify(record, severeTransition, new Date('2026-08-10T23:00:00.000Z')), false);
  assert.equal(shouldNotify(record, severeTransition, new Date('2026-08-10T08:00:00.000Z')), true);
});

test('notification payload is bounded and deep-links to the affected line', () => {
  const payload = buildAlertPayload(transition({ beforeSeverity: 10, afterSeverity: 6 }));
  assert.equal(payload.aps.alert.title, 'Central — Severe Delays');
  assert.equal(payload.aps.alert.body, 'Signal failure');
  assert.equal(payload.deepLink, 'tubeboard://line-status/central');
  assert.equal(payload.lineID, 'central');
  assert.equal(payload.contractVersion, 2);
});

test('queued alerts preserve each registration contract version', async () => {
  const { store } = await temporaryStore();
  await store.upsert(registrationPayload(), premiumEntitlement(), now);
  const transitionValue = transition({ beforeSeverity: 10, afterSeverity: 6 });

  await store.enqueue([{
    ...transitionValue,
    fingerprint: 'central-severe'
  }], store.state.records, now);

  assert.equal(store.state.queue[0].payload.contractVersion, 1);
});

test('worker sends one alert only after a stable transition', async () => {
  const { store } = await temporaryStore();
  await store.upsert(registrationPayload(), premiumEntitlement(), now);
  const responses = [
    lineStatus({ severity: 10, description: 'Good Service' }),
    lineStatus({ severity: 10, description: 'Good Service' }),
    lineStatus({ severity: 6, description: 'Severe Delays', reason: 'Signal failure' }),
    lineStatus({ severity: 6, description: 'Severe Delays', reason: 'Signal failure' })
  ];
  const pushes = [];
  const fetchImpl = async () => ({ ok: true, json: async () => responses.shift() });
  const pushImpl = async (_record, token, item) => pushes.push({ token, item });

  for (let index = 0; index < 4; index += 1) {
    await runDisruptionAlertWorkerCycle({
      store,
      config: workerConfig(),
      fetchImpl,
      pushImpl,
      logger: quietLogger(),
      now
    });
  }

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].token, deviceToken);
  assert.equal(pushes[0].item.lineID, 'central');
  assert.equal(store.state.queue.length, 0);
});

test('worker requests the combined Tube and Overground status catalogue', async () => {
  const { store } = await temporaryStore();
  await store.upsert(registrationPayload({ contractVersion: 2, selectedLineIDs: ['liberty'] }), premiumEntitlement(), now);
  const requested = [];

  await runDisruptionAlertWorkerCycle({
    store,
    config: workerConfig(),
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => [] };
    },
    pushImpl: async () => ({ status: 200 }),
    logger: quietLogger(),
    now
  });

  assert.equal(new URL(requested[0]).pathname, '/Line/Mode/tube,overground/Status');
});

test('permanent APNs errors delete the registration and do not retain a retry', async () => {
  const { store } = await temporaryStore();
  await store.upsert(registrationPayload(), premiumEntitlement(), now);
  const responses = [
    lineStatus({ severity: 10, description: 'Good Service' }),
    lineStatus({ severity: 10, description: 'Good Service' }),
    lineStatus({ severity: 6, description: 'Severe Delays' }),
    lineStatus({ severity: 6, description: 'Severe Delays' })
  ];
  const permanentError = Object.assign(new Error('Bad device token'), {
    permanent: true,
    reason: 'BadDeviceToken'
  });

  for (let index = 0; index < 4; index += 1) {
    await runDisruptionAlertWorkerCycle({
      store,
      config: workerConfig(),
      fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }),
      pushImpl: async () => { throw permanentError; },
      logger: quietLogger(),
      now
    });
  }

  assert.equal(store.state.records.length, 0);
  assert.equal(store.state.queue.length, 0);
});

function registrationPayload(overrides = {}) {
  return {
    contractVersion: 1,
    installID: '2f243a7e-d5f7-4aa7-a2f5-63c8b9ce0f14',
    deviceTokenHex: deviceToken,
    transactionJWS: 'a'.repeat(120),
    selectedLineIDs: ['central'],
    severity: 'severeOnly',
    quietHoursEnabled: true,
    quietHoursStartMinutes: 1320,
    quietHoursEndMinutes: 420,
    timeZone: 'Europe/London',
    serviceResumedAlerts: true,
    tokenUpdatedAt: now.toISOString(),
    appBundleID: 'OllyJ.My-Train-Times',
    appVersion: '1.1',
    buildNumber: '20260810124042',
    apnsEnvironment: 'production',
    storeEnvironment: 'sandbox',
    ...overrides
  };
}

function premiumEntitlement() {
  return {
    productID: 'uk.net.jeffers.tubeboard.premium.yearly',
    expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    verifiedAt: now.toISOString()
  };
}

async function temporaryStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubeboard-disruption-alert-'));
  const filePath = path.join(directory, 'registrations.json');
  return { store: new DisruptionAlertStore(filePath, encryptionKey), filePath };
}

function transactionVerifier(transaction) {
  return async () => ({ verifyAndDecodeTransaction: async () => transaction });
}

function lineStatus({ severity, description, reason = '' }) {
  return [{
    id: 'central',
    name: 'Central',
    lineStatuses: [{ statusSeverity: severity, statusSeverityDescription: description, reason }]
  }];
}

function transition({ beforeSeverity, afterSeverity }) {
  const makeStatus = (severity) => ({
    lineID: 'central',
    lineName: 'Central',
    severity,
    status: severity === 10 ? 'Good Service' : 'Severe Delays',
    reason: severity === 10 ? '' : 'Signal failure',
    isDisrupted: severity !== 10
  });
  return { before: makeStatus(beforeSeverity), after: makeStatus(afterSeverity) };
}

function preferenceRecord() {
  return {
    severity: 'severeOnly',
    quietHoursEnabled: true,
    quietHoursStartMinutes: 1320,
    quietHoursEndMinutes: 420,
    timeZone: 'UTC',
    serviceResumedAlerts: true
  };
}

function workerConfig() {
  return {
    inactivityMs: 90 * 24 * 60 * 60 * 1000,
    tflAppKey: '',
    apns: {}
  };
}

function quietLogger() {
  return { info() {}, warn() {} };
}
