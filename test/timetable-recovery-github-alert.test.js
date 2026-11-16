import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubTimetableRecoveryAlert } from '../server/timetable-recovery-github-alert.js';
const edition = 'a'.repeat(64);
const request = (value = edition) => ({ publicationSHA256: value, key: createHash('sha256').update(`timetable-recovery:${value}`).digest('hex'), reason: 'qualification-recovery-failed', rawError: 'PRIVATE', pendingScopes: 900 });
const issue = 'https://api.github.com/repos/olly-j/My-Train-Times/issues/298';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
async function fixture(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-alert-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = { calls: [], comments: [], now: 1000000, posts: 0 };
  const options = { filePath: path.join(dir, 'alert.json'), token: 'SECRET', actorID: 42, now: () => state.now, fetchImpl: async (url, options) => {
    state.calls.push({ url, options });
    if (handler) return handler(url, options, state);
    if (options.method === 'GET') return json(state.comments);
    state.posts++; const comment = { id: state.posts, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }; state.comments.push(comment); return json(comment, 201);
  } };
  return { state, options, worker: new GitHubTimetableRecoveryAlert(options), disk: async () => JSON.parse(await fs.readFile(options.filePath, 'utf8')) };
}
test('sanitized fixed target; concurrent duplicate and restart do not post twice', async t => {
  const { worker, state, options, disk } = await fixture(t);
  await Promise.all([worker.deliver(request()), worker.deliver(request())]);
  await new GitHubTimetableRecoveryAlert(options).deliver(request());
  assert.equal(state.posts, 1); assert.equal((await disk()).incident.delivered, true);
  const post = state.calls.find(call => call.options.method === 'POST');
  assert.equal(post.url, `${issue}/comments`); assert.equal(post.options.redirect, 'error');
  assert.match(post.options.body, /qualification-recovery-failed/); assert.ok(!post.options.body.includes('PRIVATE'));
  assert.ok(!JSON.stringify(await disk()).includes('SECRET'));
});
test('accepted POST with lost response reconciles across restart', async t => {
  const { worker, options, state } = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json(state.comments);
    state.posts++; state.comments.push({ id: 12, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }); throw Error('SECRET PRIVATE');
  });
  await assert.rejects(worker.deliver(request()), /^Error: Timetable operator alert remains pending$/);
  await new GitHubTimetableRecoveryAlert(options).deliver(request()); assert.equal(state.posts, 1);
});
test('ambiguous POST without observed marker never reposts or evicts unresolved incident', async t => {
  const { worker, options, state, disk } = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); state.posts++; return json({}, 503);
  });
  await assert.rejects(worker.deliver(request()));
  await assert.rejects(new GitHubTimetableRecoveryAlert(options).deliver(request()));
  await assert.rejects(worker.deliver(request('b'.repeat(64))));
  assert.equal(state.posts, 1); assert.equal((await disk()).incident.key, request().key);
});
test('explicit 401 rejection can retry without retaining response data', async t => {
  const { worker, state } = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); state.posts++;
    if (state.posts === 1) return json({ secret: 'SECRET' }, 401);
    return json({ id: 4, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }, 201);
  });
  await assert.rejects(worker.deliver(request())); await worker.deliver(request()); assert.equal(state.posts, 2);
});
test('429 Retry-After is durable and prevents early requests', async t => {
  const { worker, options, state, disk } = await fixture(t, () => json({}, 429, { 'retry-after': '120' }));
  await assert.rejects(worker.deliver(request())); assert.equal((await disk()).incident.notBefore, state.now + 120000);
  const count = state.calls.length; await assert.rejects(new GitHubTimetableRecoveryAlert(options).deliver(request())); assert.equal(state.calls.length, count);
  state.now += 120000; await assert.rejects(worker.deliver(request())); assert.equal(state.calls.length, count + 1);
});
test('pagination is bounded and foreign next URLs never receive token', async t => {
  const { worker, state } = await fixture(t, (url) => { const next = new URL(url); next.searchParams.set('page', '2'); return json([], 200, { link: `<${next}>; rel="next"` }); });
  await assert.rejects(worker.deliver(request())); assert.equal(state.calls.length, 2); // malformed repeated next fails closed
  const foreign = await fixture(t, () => json([], 200, { link: '<https://other.invalid/>; rel="next"' }));
  await assert.rejects(foreign.worker.deliver(request())); assert.equal(foreign.state.calls.length, 1);
});
test('valid fifth page is complete; sixth page stays pending without POST', async t => {
  const { worker, state } = await fixture(t, url => {
    const next = new URL(url); next.searchParams.set('page', String(Number(next.searchParams.get('page')) + 1));
    return json([], 200, { link: `<${next}>; rel="next"` });
  });
  await assert.rejects(worker.deliver(request())); assert.equal(state.calls.length, 5); assert.ok(state.calls.every(c => c.options.method === 'GET'));
});
test('response overflow and malformed comments fail before POST', async t => {
  for (const value of ['x'.repeat(262145), [{ id: 1, body: 'unknown' }]]) {
    const f = await fixture(t, () => json(value)); await assert.rejects(f.worker.deliver(request())); assert.equal(f.state.calls.length, 1);
  }
});
test('abort and deadline bound uncooperative fetch without exposing error', async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  const controller = new AbortController(); const work = f.worker.deliver({ ...request(), signal: controller.signal });
  setTimeout(() => controller.abort(Error('PRIVATE')), 10); await assert.rejects(work, /remains pending/);
  const worker = new GitHubTimetableRecoveryAlert({ ...f.options, timeoutMs: 10 }); await assert.rejects(worker.deliver(request()), /remains pending/);
});
test('unconfigured transport and invalid identities never make requests', async t => {
  const f = await fixture(t); await assert.rejects(new GitHubTimetableRecoveryAlert({ ...f.options, token: undefined }).deliver(request()));
  await assert.rejects(f.worker.deliver({ ...request(), reason: 'raw PRIVATE' })); assert.equal(f.state.calls.length, 0);
});
test('marker on a later page reconciles ambiguous delivery without repost', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'POST') { state.posts++; state.comments.push({ id: 19, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }); throw Error('lost'); }
    if (!state.comments.length) return json([]);
    if (new URL(url).searchParams.get('page') === '2') return json(state.comments);
    const next = new URL(url); next.searchParams.set('page', '2'); return json([], 200, { link: `<${next}>; rel="next"` });
  });
  await assert.rejects(f.worker.deliver(request())); await new GitHubTimetableRecoveryAlert(f.options).deliver(request()); assert.equal(f.state.posts, 1);
});
test('authorized newer incident rejects stale old callback after restart', async t => {
  const f = await fixture(t); await f.worker.deliver(request());
  const firstAttemptAt = (await f.disk()).firstAttemptAt; f.state.now += 3600000;
  await f.worker.supersede({ expectedPublicationSHA256: edition, publicationSHA256: 'b'.repeat(64) });
  await f.worker.deliver(request('b'.repeat(64)));
  await assert.rejects(new GitHubTimetableRecoveryAlert(f.options).deliver(request()));
  assert.equal(f.state.posts, 2); assert.equal((await f.disk()).firstAttemptAt, f.state.now);
  assert.ok((await f.disk()).firstAttemptAt > firstAttemptAt);
});
test('invalid successful POST stays ambiguous, not delivered', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); state.posts++; return json({ id: 1, issue_url: issue, user: { id: 42 }, body: 'wrong' }, 201);
  });
  await assert.rejects(f.worker.deliver(request())); await assert.rejects(f.worker.deliver(request()));
  assert.equal(f.state.posts, 1); assert.equal((await f.disk()).incident.delivered, false);
});
test('abort during POST persists reconciliation identity and cannot repost', async t => {
  const controller = new AbortController();
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); state.posts++; controller.abort(); return new Promise(() => {});
  });
  await assert.rejects(f.worker.deliver({ ...request(), signal: controller.signal }));
  await assert.rejects(new GitHubTimetableRecoveryAlert(f.options).deliver(request())); assert.equal(f.state.posts, 1);
  assert.equal((await f.disk()).incident.postStarted, true);
});
test('rate reset and HTTP-date retry floors are durable', async t => {
  for (const headers of [{ 'retry-after': new Date(1120000).toUTCString() }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1120' }]) {
    const f = await fixture(t, () => json({}, 403, headers)); await assert.rejects(f.worker.deliver(request())); assert.equal((await f.disk()).incident.notBefore, 1120000);
  }
});

test('untrusted author cannot establish delivery from a copied marker', async t => {
  const f = await fixture(t); await f.worker.deliver(request());
  const saved = await f.disk(); saved.incident.delivered = false;
  await fs.writeFile(f.options.filePath, JSON.stringify(saved)); f.state.comments[0].user.id = 99;
  await assert.rejects(new GitHubTimetableRecoveryAlert(f.options).deliver(request())); assert.equal(f.state.posts, 1);
  await assert.rejects(new GitHubTimetableRecoveryAlert({ ...f.options, actorID: undefined }).deliver(request()));
});
test('ambiguous delivery retries autonomously only after durable quiescence and complete absence', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]);
    state.posts++; if (state.posts === 1) throw Error('connection lost before acceptance unknown');
    return json({ id: 2, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }, 201);
  });
  await assert.rejects(f.worker.deliver(request())); const attempt = (await f.disk()).incident.postAttemptAt;
  f.state.now += 1799999; await assert.rejects(new GitHubTimetableRecoveryAlert(f.options).deliver(request())); assert.equal(f.state.posts, 1);
  f.state.now++; await new GitHubTimetableRecoveryAlert(f.options).deliver(request()); assert.equal(f.state.posts, 2);
  assert.equal((await f.disk()).incident.delivered, true); assert.equal((await f.disk()).incident.postAttemptAt, attempt + 1800000);
});
test('late trusted marker after quiescence prevents retry', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json(state.now >= 2800000 ? state.comments : []);
    state.posts++; state.comments.push({ id: 1, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }); throw Error('lost response');
  });
  await assert.rejects(f.worker.deliver(request())); f.state.now += 1800000;
  await new GitHubTimetableRecoveryAlert(f.options).deliver(request()); assert.equal(f.state.posts, 1);
});
test('best-effort limitation: invisible accepted first POST can cause a delayed duplicate', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); // first accepted comment not yet observable
    state.posts++; const comment = { id: state.posts, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }; state.comments.push(comment);
    if (state.posts === 1) throw Error('accepted response lost'); return json(comment, 201);
  });
  await assert.rejects(f.worker.deliver(request())); f.state.now += 1800000; await f.worker.deliver(request());
  assert.equal(f.state.comments.length, 2); assert.equal(f.state.comments[0].body, f.state.comments[1].body);
});
test('incomplete lookup cannot license retry even after quiescence', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'POST') { state.posts++; throw Error('lost'); }
    if (!state.posts) return json([]);
    const next = new URL(url); next.searchParams.set('page', String(Number(next.searchParams.get('page')) + 1));
    return json([], 200, { link: `<${next}>; rel="next"` });
  });
  await assert.rejects(f.worker.deliver(request())); f.state.now += 21600000;
  await assert.rejects(f.worker.deliver(request())); assert.equal(f.state.posts, 1);
});
test('explicit supersession requires exact current edition and rejects stale callbacks', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]); state.posts++; throw Error('lost');
  });
  await assert.rejects(f.worker.deliver(request()));
  await assert.rejects(f.worker.supersede({ expectedPublicationSHA256: 'c'.repeat(64), publicationSHA256: 'b'.repeat(64) }));
  assert.equal((await f.disk()).incident.edition, edition);
  await f.worker.supersede({ expectedPublicationSHA256: edition, publicationSHA256: 'b'.repeat(64) });
  const restarted = new GitHubTimetableRecoveryAlert(f.options);
  await assert.rejects(restarted.deliver(request())); assert.equal(f.state.posts, 1);
  await assert.rejects(restarted.deliver(request('b'.repeat(64)))); assert.equal(f.state.posts, 2);
  assert.equal((await f.disk()).incident.edition, 'b'.repeat(64));
});
test('quiescence cannot be configured below production minimum', async t => {
  const f = await fixture(t); assert.throws(() => new GitHubTimetableRecoveryAlert({ ...f.options, quiescenceMs: 1799999 }));
});

test('supersession resets bounded lookup horizon despite more than five pages of old history', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'POST') { state.posts++; return json({ id: state.posts, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }, 201); }
    const parsed = new URL(url);
    if (state.history && Date.parse(parsed.searchParams.get('since')) < 2000000) {
      const next = new URL(parsed); next.searchParams.set('page', String(Number(parsed.searchParams.get('page')) + 1));
      return json(Array.from({ length: 100 }, (_, i) => ({ id: Number(parsed.searchParams.get('page')) * 100 + i, issue_url: issue, body: 'unrelated historical comment' })), 200, { link: `<${next}>; rel="next"` });
    }
    return json([]);
  });
  await f.worker.deliver(request()); f.state.history = true;
  // A response-lost incident using the old horizon cannot establish absence.
  const old = await f.disk(); old.incident.delivered = false; old.incident.postStarted = true; old.incident.postAttemptAt = f.state.now;
  await fs.writeFile(f.options.filePath, JSON.stringify(old)); f.state.now += 21600000;
  let worker = new GitHubTimetableRecoveryAlert(f.options);
  const before = f.state.calls.length; await assert.rejects(worker.deliver(request())); assert.equal(f.state.calls.length - before, 5);
  assert.equal(f.state.posts, 1);
  await worker.supersede({ expectedPublicationSHA256: edition, publicationSHA256: 'b'.repeat(64) });
  worker = new GitHubTimetableRecoveryAlert(f.options); const after = f.state.calls.length;
  await assert.rejects(worker.deliver(request())); assert.equal(f.state.calls.length, after);
  await worker.deliver(request('b'.repeat(64))); assert.equal(f.state.calls.length - after, 2); // one complete GET + POST
  assert.equal((await f.disk()).firstAttemptAt, f.state.now); assert.equal(f.state.posts, 2);
  await new GitHubTimetableRecoveryAlert(f.options).deliver(request('b'.repeat(64))); assert.equal(f.state.posts, 2);
});
test('controller generation replay is idempotent and delayed authority cannot roll back after restart', async t => {
  const f = await fixture(t); await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 1 });
  await f.worker.deliver(request()); const original = await f.disk();
  await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 1 }); assert.deepEqual(await f.disk(), original);
  await f.worker.authorizeEdition({ publicationSHA256: 'b'.repeat(64), generation: 2 });
  const restarted = new GitHubTimetableRecoveryAlert(f.options);
  await assert.rejects(restarted.authorizeEdition({ publicationSHA256: edition, generation: 1 }));
  await assert.rejects(restarted.authorizeEdition({ publicationSHA256: edition, generation: 2 }));
  await assert.rejects(restarted.supersede({ expectedPublicationSHA256: 'b'.repeat(64), publicationSHA256: edition }));
  const saved = await f.disk(); assert.equal(saved.authorityGeneration, 2); assert.equal(saved.authorizedEdition, 'b'.repeat(64)); assert.equal(saved.firstAttemptAt, null);
});

const episodeRequest = episode => ({ ...request(), episode,
  key: createHash('sha256').update(`timetable-recovery:${edition}:episode:${episode}`).digest('hex') });
test('verified healthy resolution retains ambiguous-not-delivered custody before a later episode', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json([]);
    state.posts++; if (state.posts === 1) throw Error('accepted status unknown');
    return json({ id: 2, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }, 201);
  });
  await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 1 });
  await assert.rejects(f.worker.deliver(request()));
  await assert.rejects(f.worker.authorizeEdition({ publicationSHA256: edition, generation: 2, episode: 1 }));
  await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 2, resolved: true });
  const resolved = await f.disk(); assert.equal(resolved.incident.delivered, false); assert.equal(resolved.incident.resolved, true);
  assert.equal(resolved.incident.postStarted, true); assert.equal(resolved.incident.key, request().key);
  const restarted = new GitHubTimetableRecoveryAlert(f.options);
  await restarted.authorizeEdition({ publicationSHA256: edition, generation: 2, resolved: true });
  await assert.rejects(restarted.deliver(request()));
  await restarted.authorizeEdition({ publicationSHA256: edition, generation: 3, episode: 1 });
  await assert.rejects(restarted.authorizeEdition({ publicationSHA256: edition, generation: 2, resolved: true }));
  await restarted.deliver(episodeRequest(1)); assert.equal(f.state.posts, 2);
});
test('legacy edition-only durable alert state still reconciles the original marker', async t => {
  const f = await fixture(t, (url, options, state) => {
    if (options.method === 'GET') return json(state.comments);
    state.posts++; state.comments.push({ id: 7, issue_url: issue, user: { id: 42 }, body: JSON.parse(options.body).body }); throw Error('lost');
  });
  await assert.rejects(f.worker.deliver(request()));
  const legacy = await f.disk(); delete legacy.authorizedEpisode; delete legacy.authorizedResolved; delete legacy.incident.resolved;
  await fs.writeFile(f.options.filePath, JSON.stringify(legacy));
  await new GitHubTimetableRecoveryAlert(f.options).deliver(request()); assert.equal(f.state.posts, 1);
  assert.equal((await f.disk()).incident.delivered, true);
});
test('resolved custody can coalesce never-delivered intermediate episodes without reopening old callbacks', async t => {
  const f = await fixture(t); await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 1 });
  await f.worker.deliver(request());
  await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 2, resolved: true });
  // Intermediate gaps recovered while the alert transport was unavailable.
  // Only the controller's latest still-unresolved episode needs a new alert.
  await f.worker.authorizeEdition({ publicationSHA256: edition, generation: 7, episode: 3 });
  await f.worker.deliver(episodeRequest(3)); assert.equal(f.state.posts, 2);
  await assert.rejects(f.worker.deliver(episodeRequest(1)));
  await assert.rejects(f.worker.authorizeEdition({ publicationSHA256: edition, generation: 8, episode: 4 }));
});
