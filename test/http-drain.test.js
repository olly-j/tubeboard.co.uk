import test from 'node:test';
import assert from 'node:assert/strict';
import { probeHTTPDrain } from '../scripts/http-drain-probe.mjs';

for (const connection of ['default', 'close']) {
  test(`accepted in-flight body drains after completion with ${connection} connection`, { timeout: 10000 }, async () => {
    const result = await probeHTTPDrain({ connection, completionDelayMs: 1200 });
    assert.equal(result.code, 0); assert.equal(result.deadlineObserved, false);
    assert.equal(result.drainingInFlightObserved, true); assert.equal(result.persistedRecords, 1);
    assert.deepEqual(result.responses.map(response => [response.status, response.ok]), [[200, true]]);
  });
}
for (const optOut of [false, true]) {
  test(`multiple concurrent accepted ${optOut ? 'opt-out' : 'registration'} bodies all persist before drain`, { timeout: 10000 }, async () => {
    const result = await probeHTTPDrain({ clients: 3, optOut, completionDelayMs: 1200 });
    assert.equal(result.code, 0); assert.equal(result.deadlineObserved, false);
    assert.equal(result.drainingInFlightObserved, true); assert.equal(result.persistedRecords, 3);
    assert.deepEqual(result.responses.map(response => [response.status, response.ok]), [[200, true], [200, true], [200, true]]);
    assert.equal(result.endedRecords, optOut ? 3 : 0);
  });
}
test('a stalled accepted body is still cut off by the unchanged five-second deadline', { timeout: 10000 }, async () => {
  const result = await probeHTTPDrain({ stalled: true });
  assert.equal(result.code, 1); assert.equal(result.persistedRecords, 0);
  assert.equal(result.drainingInFlightObserved, true); assert.equal(result.deadlineObserved, true);
  assert.ok(result.drainElapsedMs >= 4900 && result.drainElapsedMs < 8000);
  assert.ok(result.responses[0].error);
});
