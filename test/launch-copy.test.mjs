import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const pages = await Promise.all(['index.html', 'support.html'].map(async (name) => ({
  name, html: await fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')
})));
const home = pages[0].html;
const support = pages[1].html;
const appStoreURL = 'https://apps.apple.com/gb/app/tubeboard-live-departures/id6779771046';

for (const { name, html } of pages) {
  test(`${name} keeps one main heading and working in-page accessibility targets`, () => {
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    assert.equal([...html.matchAll(/<main\b/g)].length, 1);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
    for (const match of html.matchAll(/\b(?:aria-labelledby|aria-controls)="([^"]+)"/g)) {
      for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), `Missing target ${id}`);
    }
    for (const match of html.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(ids.includes(match[1]), `Broken local link ${match[1]}`);
    }
    assert.match(html, /class="skip-link" href="#main"/);
  });

  test(`${name} retains bounded image layout and first-party script loading`, () => {
    for (const match of html.matchAll(/<img\b[^>]*>/g)) {
      assert.match(match[0], /\balt="[^"]*"/);
      assert.match(match[0], /\bwidth="\d+"/);
      assert.match(match[0], /\bheight="\d+"/);
    }
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(scripts, ['/site-20260724.js']);
    assert.doesNotMatch(html, /<iframe|<script[^>]+src="https?:/i);
  });
}

test('launch schema and visible links identify the same existing app without changing price or platform IDs', () => {
  const text = home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  const graph = JSON.parse(text)['@graph'];
  const app = graph.find((item) => item['@type'] === 'MobileApplication');
  assert.equal(app.url, appStoreURL);
  assert.equal(app.downloadUrl, appStoreURL);
  assert.equal(app.isAccessibleForFree, true);
  assert.equal(app.offers.price, '0');
  for (const match of home.matchAll(/href="(https:\/\/apps.apple.com[^\"]+)"/g)) {
    assert.equal(match[1], appStoreURL);
  }
  assert.ok(app.featureList.some((feature) => /Premium Follow a Train/.test(feature)));
  assert.ok(app.featureList.some((feature) => /London Overground/.test(feature)));
  assert.ok(app.featureList.some((feature) => /By destination/.test(feature)));
  assert.ok(app.featureList.some((feature) => /Apple Watch.*widgets/.test(feature)));
  for (const price of ['£1.99', '£9.99', '£24.99']) {
    assert.ok(home.includes(price));
    assert.ok(support.includes(price));
  }
});

test('free/Premium comparison separates free network coverage from paid added surfaces', () => {
  const rows = new Map([...home.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)]
    .map((row) => [row[1], [row[2], row[3]]]));
  assert.deepEqual(rows.get('London Overground departures'), ['Included', 'Included']);
  assert.deepEqual(rows.get('Follow a Train'), ['Not included', 'Included']);
  assert.deepEqual(rows.get('Next departures and By destination layouts'), ['Not included', 'Included']);
  assert.deepEqual(rows.get('Apple Watch app and widgets'), ['Not included', 'Included']);
  assert.deepEqual(rows.get('Automatic refresh and both board modes'), ['Included', 'Included']);
  assert.deepEqual(rows.get('Live Activities'), ['Three sessions', 'Unlimited']);
});

test('homepage and support agree on line coverage and current Premium continuity', () => {
  for (const line of ['Lioness', 'Mildmay', 'Windrush', 'Weaver', 'Suffragette', 'Liberty']) {
    assert.ok(home.includes(line));
    assert.ok(support.includes(line));
  }
  for (const { html } of pages) {
    assert.match(html, /existing monthly, yearly or Lifetime purchase includes the new Premium features/);
    assert.match(html, /Next departures within each direction|Next departures, ordered within each direction/);
    assert.match(html, /compatible watch face/);
    assert.doesNotMatch(html, /private universal-link|specific Premium train|non-scrolling stop sequence/);
  }
});

test('support distinguishes route context, live proof, onward workings and browser limitations', () => {
  assert.match(support, /Route context and live train information are separate/);
  assert.match(support, /without a countdown is not a promise/);
  assert.match(support, /Reliable onward destinations remain a separate data limitation/);
  assert.match(support, /Browser live tracking is not available/);
  assert.match(support, /reopen the original link/);
  assert.match(support, /not your precise location, saved stations, account or purchase details/);
  assert.match(support, /Turning the feature off requests server deletion; an offline request is retried/);
  assert.doesNotMatch(support, /never misses|guaranteed|track every train/i);
});

test('social preview copy and current-source assets match across cards', () => {
  const ogTitle = home.match(/property="og:title" content="([^"]+)"/)?.[1];
  const twitterTitle = home.match(/name="twitter:title" content="([^"]+)"/)?.[1];
  const ogDescription = home.match(/property="og:description" content="([^"]+)"/)?.[1];
  const twitterDescription = home.match(/name="twitter:description" content="([^"]+)"/)?.[1];
  assert.equal(ogTitle, twitterTitle);
  assert.equal(ogDescription, twitterDescription);
  assert.match(ogTitle, /1\.2/);
  assert.match(home, /TB-088 release gate/);
  assert.match(home, /tubeboard-og-v1-2-20260905103957\.png/);
  assert.doesNotMatch(home, /v1-1-20260825/);
});
