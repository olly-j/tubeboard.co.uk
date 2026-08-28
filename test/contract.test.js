import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  DISRUPTION_ALERT_CONTRACT_VERSION,
  validateRegistrationPayload
} from '../server/disruption-alerts.js';
import { validateTokenPayload } from '../server/live-activity.js';
import { LIVE_ACTIVITY_CONTRACT_VERSION } from '../server/version.js';

const schemaPath = new URL('../contracts/live-activity-registration-v1.schema.json', import.meta.url);
const fixturePath = new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url);
const disruptionAlertSchemaPath = new URL('../contracts/disruption-alert-registration-v1.schema.json', import.meta.url);
const disruptionAlertFixturePath = new URL('../contracts/fixtures/disruption-alert-registration-v1.json', import.meta.url);
const disruptionAlertV2SchemaPath = new URL('../contracts/disruption-alert-registration-v2.schema.json', import.meta.url);
const disruptionAlertV2FixturePath = new URL('../contracts/fixtures/disruption-alert-registration-v2.json', import.meta.url);
const homePagePath = new URL('../index.html', import.meta.url);
const privacyPagePath = new URL('../privacy.html', import.meta.url);
const supportPagePath = new URL('../support.html', import.meta.url);
const styleSheetPath = new URL('../styles-20260820.css', import.meta.url);
const appStoreURL = 'https://apps.apple.com/gb/app/tubeboard-live-departures/id6779771046';
const v11ProductAssets = [
  'home-status-v1-1-20260825',
  'live-board-v1-1-20260825',
  'detailed-board-v1-1-20260825',
  'widgets-v1-1-20260825',
  'nearby-interchange-v1-1-20260825',
  'premium-alerts-v1-1-20260825'
];

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
  assert.equal(schema.required.includes('selectionMode'), false);
  assert.equal(
    validateTokenPayload({ ...fixture, selectionMode: undefined }).ok,
    true
  );
  assert.deepEqual(schema.allOf[0].if.required, ['selectionMode']);
});

test('versioned disruption-alert fixture matches the service validator', async () => {
  const schema = JSON.parse(await fs.readFile(disruptionAlertSchemaPath, 'utf8'));
  const fixture = JSON.parse(await fs.readFile(disruptionAlertFixturePath, 'utf8'));
  const validation = validateRegistrationPayload(fixture);

  assert.equal(schema['x-tubeboard-contract-version'], 1);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(Object.keys(fixture).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.required.filter((field) => fixture[field] === undefined), []);
});

test('versioned disruption-alert v2 fixture adds the six named Overground lines', async () => {
  const schema = JSON.parse(await fs.readFile(disruptionAlertV2SchemaPath, 'utf8'));
  const fixture = JSON.parse(await fs.readFile(disruptionAlertV2FixturePath, 'utf8'));
  const validation = validateRegistrationPayload(fixture);

  assert.equal(schema['x-tubeboard-contract-version'], DISRUPTION_ALERT_CONTRACT_VERSION);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(Object.keys(fixture).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.required.filter((field) => fixture[field] === undefined), []);
  assert.deepEqual(
    schema.properties.selectedLineIDs.items.enum.slice(-6),
    ['liberty', 'lioness', 'mildmay', 'suffragette', 'weaver', 'windrush']
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

test('website source remains compatible with the currently public app release', async () => {
  const html = await fs.readFile(homePagePath, 'utf8');
  const structuredDataText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  const structuredData = JSON.parse(structuredDataText);
  const mobileApplication = structuredData['@graph'].find((item) => item['@type'] === 'MobileApplication');

  assert.match(html, /Elizabeth line/);
  assert.match(html, /saved station and one of its real platforms/i);
  assert.match(html, /Apple Watch/);
  assert.match(html, /Apple Vision Pro/);
  assert.match(html, /Opt-in disruption alerts/i);
  assert.match(html, /selected Tube lines/i);
  assert.doesNotMatch(html, /selected Tube and London Overground lines/i);
  assert.match(html, /cached or offline data clear/i);
  assert.match(html, /severity, resumed-service and quiet-hour controls/i);
  assert.doesNotMatch(html, /refresh (?:their|its) Tube data throughout the day/i);
  assert.doesNotMatch(html, /Apple TV|tvOS/i);
  assert.doesNotMatch(html, /assets\/product\/(?:live-board|station-picker|detailed-board|time-to-leave)-20260723/i);
  assert.match(html, /assets\/tubeboard-og-v1-1-20260825\.png/);
  assert.doesNotMatch(html, /assets\/product\/elizabeth-line-v1-1/i);
  assert.match(mobileApplication.operatingSystem, /watchOS 11\.5 or later/);
  assert.match(mobileApplication.operatingSystem, /visionOS 26\.0 or later/);
  assert.ok(mobileApplication.featureList.includes('Elizabeth line stations, arrivals and status'));
  assert.ok(!mobileApplication.featureList.some((feature) => /London Overground/i.test(feature)));

  for (const asset of v11ProductAssets) {
    assert.match(html, new RegExp(`/assets/product/${asset}\\.png`));
    assert.match(html, new RegExp(`/assets/product/${asset}\\.webp`));
    await fs.access(new URL(`../assets/product/${asset}.png`, import.meta.url));
    await fs.access(new URL(`../assets/product/${asset}.webp`, import.meta.url));
  }
  await fs.access(new URL('../assets/tubeboard-og-v1-1-20260825.png', import.meta.url));
});

test('v1.1 support explains platform widget configuration and offline state', async () => {
  const html = await fs.readFile(supportPagePath, 'utf8');

  assert.match(html, /choose a saved station and then choose one of its available platforms/i);
  assert.match(html, /reports that it is offline/i);
  assert.match(html, /shown separately as no current departures/i);
  assert.match(html, /Apple Watch/);
  assert.match(html, /Apple Vision Pro/);
  assert.match(html, /choose the lines you want under Settings/i);
  assert.doesNotMatch(html, /named London Overground lines/i);
  assert.match(html, /assets\/tubeboard-og-v1-1-20260825\.png/);
  assert.doesNotMatch(html, /Apple TV|tvOS/i);
});

test('privacy scope describes the supported London rail service without changing data-use claims', async () => {
  const html = await fs.readFile(privacyPagePath, 'utf8');

  assert.match(html, /intended for supported London rail departure information/i);
  assert.doesNotMatch(html, /intended for London Underground information/i);
  assert.match(html, /does not knowingly collect children’s information/i);
});

test('muted website copy keeps WCAG AA contrast on the softest section background', async () => {
  const css = await fs.readFile(styleSheetPath, 'utf8');
  const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
  const surfacesBackground = css.match(/\.surfaces\s*\{[^}]*background:\s*(#[0-9a-f]{6})/is)?.[1];

  assert.ok(muted);
  assert.ok(surfacesBackground);
  assert.ok(contrastRatio(muted, surfacesBackground) >= 4.5);
});

function contrastRatio(first, second) {
  const luminances = [first, second].map((hex) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((value) => {
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }).sort((left, right) => right - left);

  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}
