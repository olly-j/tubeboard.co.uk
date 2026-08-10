import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { validateTokenPayload } from '../server/live-activity.js';
import { LIVE_ACTIVITY_CONTRACT_VERSION } from '../server/version.js';

const schemaPath = new URL('../contracts/live-activity-registration-v1.schema.json', import.meta.url);
const fixturePath = new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url);
const homePagePath = new URL('../index.html', import.meta.url);
const appStoreURL = 'https://apps.apple.com/gb/app/tubeboard-live-departures/id6779771046';

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

test('public home page links to the live App Store listing without launch placeholders', async () => {
  const html = await fs.readFile(homePagePath, 'utf8');
  const structuredDataText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  const structuredData = JSON.parse(structuredDataText);
  const website = structuredData['@graph'].find((item) => item['@type'] === 'WebSite');
  const organization = structuredData['@graph'].find((item) => item['@type'] === 'Organization');
  const mobileApplication = structuredData['@graph'].find((item) => item['@type'] === 'MobileApplication');

  assert.match(html, new RegExp(appStoreURL.replaceAll('.', '\\.')));
  assert.match(html, /Download on the App Store/);
  assert.doesNotMatch(html, /coming soon/i);
  assert.doesNotMatch(html, /preparing for (?:its )?App Store release/i);
  assert.equal(website.url, 'https://tubeboard.co.uk/');
  assert.equal(organization.url, 'https://tubeboard.co.uk/');
  assert.equal(organization.downloadUrl, undefined);
  assert.equal(mobileApplication.url, appStoreURL);
  assert.equal(mobileApplication.downloadUrl, appStoreURL);
});
