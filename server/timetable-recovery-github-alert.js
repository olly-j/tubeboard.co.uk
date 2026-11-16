import { createHash } from 'node:crypto';
import { TransactionalJsonStore } from './transactional-json-store.js';
import { parseBoundedJSON } from './bounded-json.js';

const COMMENTS = 'https://api.github.com/repos/olly-j/My-Train-Times/issues/298/comments';
const ISSUE = 'https://api.github.com/repos/olly-j/My-Train-Times/issues/298';
const LIMIT = 262144, PAGES = 5;
export const ALERT_QUIESCENCE_MS = 30 * 60 * 1000;
const pending = () => new Error('Timetable operator alert remains pending');
const keyFor = edition => createHash('sha256').update(`timetable-recovery:${edition}`).digest('hex');
const valid = value => /^[a-f0-9]{64}$/.test(value || '');
function normalize(state) {
  const incident = state?.incident;
  if (state?.version !== 2 || !(state.authorizedEdition === null || valid(state.authorizedEdition)) || !(state.firstAttemptAt === null || Number.isSafeInteger(state.firstAttemptAt) && state.firstAttemptAt >= 0)
    || !(incident === null || incident && typeof incident === 'object' && !Array.isArray(incident))
    || incident && (!valid(incident.edition) || incident.key !== keyFor(incident.edition)
      || typeof incident.postStarted !== 'boolean' || typeof incident.delivered !== 'boolean'
      || !(incident.postAttemptAt === null || Number.isSafeInteger(incident.postAttemptAt) && incident.postAttemptAt >= 0)
      || incident.postStarted && incident.postAttemptAt === null || state.authorizedEdition !== incident.edition
      || !Number.isSafeInteger(incident.notBefore) || incident.notBefore < 0 || state.firstAttemptAt === null)) throw pending();
  return { version: 2, authorizedEdition: state.authorizedEdition, firstAttemptAt: state.firstAttemptAt, incident: incident || null };
}
function bodyFor(edition, key) {
  return `Timetable recovery could not qualify publication \`${edition}\`.\n\nReason: qualification-recovery-failed.\n\n<!-- tubeboard-timetable-recovery:${key} -->`;
}

// One instance/process owns this file, as for TransactionalJsonStore. The token
// must be externally supplied and restricted to Issues read/write on the fixed
// repository. This module has no scheduler and is deliberately not wired in.
export class GitHubTimetableRecoveryAlert {
  #token; #actorID; #fetch; #now; #tail = Promise.resolve(); #store; #timeout; #quiescence;
  constructor({ filePath, token, actorID, fetchImpl = fetch, now = Date.now, timeoutMs = 10000, quiescenceMs = ALERT_QUIESCENCE_MS }) {
    if (!Number.isSafeInteger(quiescenceMs) || quiescenceMs < ALERT_QUIESCENCE_MS) throw pending();
    this.#quiescence = quiescenceMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw pending();
    this.#token = token; this.#actorID = actorID; this.#fetch = fetchImpl; this.#now = now; this.#timeout = timeoutMs;
    this.#store = new TransactionalJsonStore(filePath, { version: 2, authorizedEdition: null, firstAttemptAt: null, incident: null }, normalize);
  }
  deliver(request) {
    const operation = this.#tail.then(() => this.#deliver(request));
    this.#tail = operation.catch(() => {});
    return operation;
  }
  // The controller must explicitly authorize a new current edition. CAS plus
  // serialized delivery prevents stale callbacks from resurrecting the old one.
  // Wiring this API to authoritative edition changes is an activation gate.
  supersede({ expectedPublicationSHA256, publicationSHA256 }) {
    const operation = this.#tail.then(async () => {
      if (!valid(expectedPublicationSHA256) || !valid(publicationSHA256) || expectedPublicationSHA256 === publicationSHA256) throw pending();
      await this.#store.transaction(state => {
        if (state.authorizedEdition !== expectedPublicationSHA256) throw pending();
        // Old callbacks are fenced by authorizedEdition; their history must
        // not consume the finite lookup budget of the newly authorized edition.
        state.authorizedEdition = publicationSHA256; state.incident = null; state.firstAttemptAt = null;
      });
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  async #deliver({ key, publicationSHA256: edition, reason, signal }) {
    if (!valid(edition) || key !== keyFor(edition) || reason !== 'qualification-recovery-failed'
      || !Number.isSafeInteger(this.#actorID) || this.#actorID < 1
      || typeof this.#token !== 'string' || !this.#token.trim() || signal?.aborted) throw pending();
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw pending();
    await this.#store.transaction(state => {
      if (state.authorizedEdition !== null && state.authorizedEdition !== edition) throw pending();
      state.authorizedEdition ??= edition;
      if (state.incident?.key === key) return { changed: false };
      if (state.incident && !state.incident.delivered) throw pending();
      state.firstAttemptAt ??= now;
      state.incident = { key, edition, postStarted: false, postAttemptAt: null, delivered: false, notBefore: 0 };
    });
    if (this.#store.state.incident.delivered) return;
    if (this.#store.state.incident.notBefore > now) throw pending();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const interrupted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(pending()), { once: true }));
    try {
      await Promise.race([this.#attempt(edition, key, controller.signal), interrupted]);
    } catch { throw pending(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async #request(url, method, body, signal) {
    signal.throwIfAborted();
    const response = await this.#fetch(url, { method, signal, redirect: 'error', headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`,
      'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'TubeBoard-timetable-recovery',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify({ body }) } : {}) });
    signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      let delay = 0;
      const retry = response.headers.get('retry-after');
      if (retry !== null) delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.#now();
      if (response.headers.get('x-ratelimit-remaining') === '0') delay = Math.max(delay || 0, Number(response.headers.get('x-ratelimit-reset')) * 1000 - this.#now());
      if (Number.isFinite(delay) && delay > 0) {
        const deadline = Math.min(Number.MAX_SAFE_INTEGER, this.#now() + Math.ceil(delay));
        await this.#store.transaction(state => { state.incident.notBefore = Math.max(state.incident.notBefore, deadline); });
      }
      // Explicit rejection can retry on the next coordinator attempt. Ambiguous
      // failures instead require quiescence plus a complete marker lookup.
      if (method === 'POST' && [400, 401, 403, 404, 422, 429].includes(response.status)) {
        await this.#store.transaction(state => { state.incident.postStarted = false; });
      }
      throw pending();
    }
    const chunks = []; let size = 0;
    try {
      if (!response.body) throw pending();
      for await (const chunk of response.body) {
        signal.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > LIMIT) throw pending(); chunks.push(bytes);
      }
      signal.throwIfAborted();
      return { status: response.status, value: parseBoundedJSON(Buffer.concat(chunks, size), LIMIT), link: response.headers.get('link') };
    } catch { void response.body?.cancel().catch(() => {}); throw pending(); }
  }
  async #attempt(edition, key, signal) {
    const body = bodyFor(edition, key);
    const matches = comment => Number.isSafeInteger(comment?.id) && comment.id > 0 && comment.user?.id === this.#actorID && comment.body === body && comment.issue_url === ISSUE;
    const since = new Date(Math.max(0, this.#store.state.firstAttemptAt - 60000)).toISOString();
    let absent = false;
    for (let page = 1; page <= PAGES; page++) {
      const url = new URL(COMMENTS); url.searchParams.set('since', since); url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
      const response = await this.#request(url.href, 'GET', null, signal);
      if (response.status !== 200 || !Array.isArray(response.value) || response.value.length > 100
        || response.value.some(comment => !Number.isSafeInteger(comment?.id) || comment.id < 1 || typeof comment.body !== 'string' || comment.issue_url !== ISSUE)) throw pending();
      if (response.value.some(matches)) { await this.#markDelivered(signal); return; }
      const links = response.link?.split(',') || [];
      if (links.some(link => !/^\s*<[^>]+>;\s*rel="(?:next|prev|first|last)"\s*$/.test(link))) throw pending();
      const next = links.filter(link => /rel="next"/.test(link));
      if (!next.length) { absent = true; break; }
      if (next.length !== 1) throw pending();
      const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next[0]);
      const expected = new URL(url); expected.searchParams.set('page', String(page + 1));
      if (!match) throw pending();
      const actual = new URL(match[1]); actual.searchParams.sort(); expected.searchParams.sort();
      if (actual.href !== expected.href) throw pending();
    }
    const incident = this.#store.state.incident;
    if (!absent || incident.postStarted && this.#now() - incident.postAttemptAt < this.#quiescence) throw pending();
    // BEST-EFFORT deduplication: GitHub POST has no idempotency key. A prior
    // accepted comment can appear after this complete lookup, causing a rare
    // duplicate. Delayed retry favors eventual alert delivery over silent loss.
    signal.throwIfAborted();
    await this.#store.transaction(state => { state.incident.postStarted = true; state.incident.postAttemptAt = this.#now(); });
    signal.throwIfAborted();
    const response = await this.#request(COMMENTS, 'POST', body, signal);
    if (response.status !== 201 || !matches(response.value)) throw pending();
    await this.#markDelivered(signal);
  }
  async #markDelivered(signal) {
    signal.throwIfAborted();
    await this.#store.transaction(state => { state.incident.delivered = true; });
  }
}
