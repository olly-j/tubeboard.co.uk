import { createHash } from 'node:crypto';
import { TransactionalJsonStore } from './transactional-json-store.js';
import { SerialWorker } from './worker-lifecycle.js';

const SHA = /^[a-f0-9]{64}$/;
const MAX_SCOPES = 256;
const BATCH_SIZE = 32;
const RETRY_MS = [60_000, 300_000, 1_800_000, 21_600_000];
const INITIAL = { version: 1, edition: null, editionGeneration: 0, pending: [], completed: [], failures: 0,
  nextAttemptAt: 0, incident: null };

function normalize(value) {
  if (value?.version !== 1 || !(value.edition === null || SHA.test(value.edition)) ||
      !Number.isSafeInteger(value.failures) || value.failures < 0 ||
      !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0 ||
      !Array.isArray(value.pending) || !Array.isArray(value.completed) ||
      value.pending.length + value.completed.length > MAX_SCOPES ||
      [...value.pending, ...value.completed].some(s => typeof s !== 'string' || s.length > 128) ||
      new Set([...value.pending, ...value.completed]).size !== value.pending.length + value.completed.length ||
      !(value.incident === null || SHA.test(value.incident?.key) &&
        typeof value.incident.delivered === 'boolean')) throw new Error('Invalid timetable recovery state');
  const generation = value.editionGeneration ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid timetable recovery state');
  return { ...structuredClone(value), editionGeneration: generation };
}

// One service process owns this durable queue. No GitHub job, client identity,
// location, or upstream response is stored. The producer/admission boundary
// alone decides whether coverage is qualified; this worker never supplies it.
export class TimetableRecovery {
  constructor({ filePath, observation, latestIdentity, validScope, recover, alert, authorizeAlertEdition,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = () => {} }) {
    this.store = new TransactionalJsonStore(filePath, INITIAL, normalize);
    this.observation = observation;
    this.latestIdentity = latestIdentity;
    this.validScope = validScope;
    this.recover = recover;
    this.alert = alert;
    this.authorizeAlertEdition = authorizeAlertEdition;
    this.now = now;
    this.worker = new SerialWorker({ run: signal => this.#run(signal),
      onError, schedule, cancel });
  }

  async request(scope) {
    if (typeof scope !== 'string' || scope.length > 128 || !this.validScope(scope)) return false;
    return this.store.transaction(state => {
      if (state.pending.includes(scope) || state.completed.includes(scope)) return { changed: false, value: true };
      if (state.pending.length + state.completed.length >= MAX_SCOPES) return { changed: false, value: false };
      state.pending.push(scope);
      return { value: true };
    });
  }

  // Called after the existing edition observer refresh, or a validated demand.
  // trigger coalesces overlapping reads; it does not start a second poll loop.
  tick() { return this.worker.trigger(); }
  stop() { return this.worker.stop(); }

  async status() {
    await this.store.load();
    const state = this.store.state;
    return { publicationSHA256: state.edition, pendingScopes: state.pending.length,
      failures: state.failures, nextAttemptAt: state.nextAttemptAt,
      alertPending: Boolean(state.incident && !state.incident.delivered) };
  }

  async #run(signal) {
    const observed = this.observation.current();
    if (!observed || !SHA.test(observed.publicationSHA256) ||
        !(Date.parse(observed.observedAt) <= this.now() && Date.parse(observed.expiresAt) > this.now())) return;
    const edition = observed.publicationSHA256;
    await this.store.transaction(state => {
      if (state.edition === edition) return { changed: false };
      if (state.editionGeneration === Number.MAX_SAFE_INTEGER) throw new Error('Timetable edition generation exhausted');
      state.editionGeneration++;
      state.edition = edition;
      // Already admitted scopes are supplied by the producer from the previous
      // proof, not re-enqueued as user traffic. Unresolved requests survive.
      state.completed = [];
      state.failures = 0;
      state.nextAttemptAt = 0;
      state.incident = null;
    });
    let state = this.store.state;
    let alertAuthorized = true;
    // Persist controller authority first. A crash before/after the second store
    // is repaired by this idempotent handoff on every subsequent worker run.
    if (this.authorizeAlertEdition) {
      signal.throwIfAborted();
      try {
        await this.authorizeAlertEdition({ publicationSHA256: edition, generation: state.editionGeneration });
      } catch {
        signal.throwIfAborted();
        // Alert storage cannot gate timetable preparation/admission. Keep the
        // incident pending and retry authorization on the next existing run.
        alertAuthorized = false;
      }
      signal.throwIfAborted();
      const current = this.observation.current();
      if (current?.publicationSHA256 !== edition || !(Date.parse(current.observedAt) <= this.now() && Date.parse(current.expiresAt) > this.now())) return;
    }
    const latest = await this.latestIdentity();
    if (latest?.publicationSHA256 === edition && state.pending.length === 0) {
      if (state.incident && !state.incident.delivered) {
        if (state.nextAttemptAt <= this.now()) await this.#deliverIncident(edition, signal, alertAuthorized);
        state = this.store.state;
        if (!state.incident.delivered) this.worker.scheduleRerun('recovery', Math.max(0, state.nextAttemptAt - this.now()));
      }
      return;
    }
    if (state.nextAttemptAt > this.now()) {
      this.worker.scheduleRerun('recovery', state.nextAttemptAt - this.now());
      return;
    }
    const scopes = state.pending.slice(0, BATCH_SIZE);
    // Reserve the retry before external work. A restart during preparation
    // cannot cause an immediate download/retry storm.
    await this.store.transaction(next => {
      next.failures = Math.min(next.failures + 1, 1_000_000);
      next.nextAttemptAt = this.now() + RETRY_MS[Math.min(next.failures - 1, RETRY_MS.length - 1)];
      // Persist the incident before a third attempt that might terminate the
      // process. It is delivered only after failure/restart, never while a
      // successful third attempt is still able to clear it.
      if (next.failures >= 3 && !next.incident) {
        const key = createHash('sha256').update(`timetable-recovery:${edition}`).digest('hex');
        next.incident = { key, delivered: false };
      }
    });
    let unresolved = scopes, failure = true;
    try {
      signal.throwIfAborted();
      const result = await this.recover({ publicationSHA256: edition, scopes, signal });
      signal.throwIfAborted();
      const identity = await this.latestIdentity();
      const current = this.observation.current();
      if (current?.publicationSHA256 !== edition ||
          !(Date.parse(current.observedAt) <= this.now() && Date.parse(current.expiresAt) > this.now()) ||
          identity?.publicationSHA256 !== edition || !Array.isArray(result?.unresolvedScopes) ||
          result.unresolvedScopes.some(scope => !scopes.includes(scope)) ||
          new Set(result.unresolvedScopes).size !== result.unresolvedScopes.length) {
        throw new Error('Timetable recovery did not establish admitted coverage');
      }
      unresolved = result.unresolvedScopes;
      failure = unresolved.length > 0;
    } catch {
      if (signal.aborted) {
        // A deliberate graceful stop is not a failed preparation. Abrupt
        // process death still leaves the reserved attempt durable.
        await this.store.transaction(next => { next.failures = state.failures; next.incident = state.incident; });
        signal.throwIfAborted();
      }
      // Keep all pending scopes and only a fixed diagnostic class. Provider
      // errors and process output may contain sensitive operational details.
    }
    await this.store.transaction(next => {
      const completed = scopes.filter(scope => !unresolved.includes(scope));
      next.pending = next.pending.filter(scope => !completed.includes(scope));
      next.completed.push(...completed);
      if (failure) {
        // Let later stations make progress even when this batch has a lasting
        // provider gap. There is still only one bounded retry timer.
        next.pending = [...next.pending.filter(scope => !unresolved.includes(scope)), ...unresolved];
        next.nextAttemptAt = this.now() + RETRY_MS[Math.min(next.failures - 1, RETRY_MS.length - 1)];
      } else {
        next.failures = 0;
        next.nextAttemptAt = 0;
        next.incident = null;
      }
    });
    state = this.store.state;
    await this.#deliverIncident(edition, signal, alertAuthorized);
    state = this.store.state;
    if (failure || state.pending.length > 0) {
      this.worker.scheduleRerun('recovery', Math.max(0, state.nextAttemptAt - this.now()));
    } else {
      this.worker.scheduleRerun('recovery', null);
    }
  }

  async #deliverIncident(edition, signal, alertAuthorized = true) {
    const state = this.store.state;
    const current = this.observation.current();
    if (state.edition !== edition || current?.publicationSHA256 !== edition ||
        !(Date.parse(current.observedAt) <= this.now() && Date.parse(current.expiresAt) > this.now())) return;
    if (state.incident && !state.incident.delivered && this.alert && alertAuthorized) {
      try {
        // The stable incident key lets the transport deduplicate ordinary
        // restart retries. Ambiguous GitHub delivery remains best-effort;
        // bounded retry is preferable to permanently losing the alert.
        await this.alert({ key: state.incident.key, publicationSHA256: edition,
          reason: 'qualification-recovery-failed', pendingScopes: state.pending.length, signal });
        await this.store.transaction(next => { next.incident.delivered = true; });
      } catch {
        signal.throwIfAborted();
        await this.store.transaction(next => { next.nextAttemptAt = Math.max(next.nextAttemptAt, this.now() + RETRY_MS.at(-1)); });
      }
    } else if (state.incident && !state.incident.delivered) {
      // Missing transport is not an acknowledgement and must not spin a timer.
      await this.store.transaction(next => { next.nextAttemptAt = Math.max(next.nextAttemptAt, this.now() + RETRY_MS.at(-1)); });
    }
  }
}
