import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { validateTokenPayload } from '../server/live-activity.js';
import { LIVE_ACTIVITY_CONTRACT_VERSION } from '../server/version.js';

const schemaPath = new URL('../contracts/live-activity-registration-v1.schema.json', import.meta.url);
const fixturePath = new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url);

test('versioned registration fixture matches the service validator', async () => {
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const validation = validateTokenPayload(fixture);

  assert.equal(schema['x-tubeboard-contract-version'], LIVE_ACTIVITY_CONTRACT_VERSION);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(
    Object.keys(fixture).sort(),
    Object.keys(schema.properties).sort()
  );
  assert.deepEqual(
    schema.required.filter((field) => fixture[field] === undefined),
    []
  );
});
