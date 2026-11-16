import { createHash } from 'node:crypto';
import { TransactionalJsonStore } from './transactional-json-store.js';
import { SerialWorker } from './worker-lifecycle.js';

const SHA = /^[a-f0-9]{64}$/;
const MAX_DEMAND = 256, MAX_REQUIRED = 256, MAX_SCOPES = 512, BATCH_SIZE = 32;
const RETRY_MS = [60_000, 300_000, 1_800_000, 21_600_000];
const INITIAL = { version: 1, edition: null, editionGeneration: 0, episode: 0, phase: 'unresolved',
  serviceDay: null, assessment: null, lastAssessmentAt: 0, requiredScopes: [], demandScopes: [], resolutionHandoff: null, pending: [], completed: [], failures: 0,
  nextAttemptAt: 0, incident: null };
const serviceDay = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const validIdentity = identity => SHA.test(identity?.publicationSHA256 ?? '') && SHA.test(identity?.proofBodySHA256 ?? '')
  && SHA.test(identity?.resourceSHA256 ?? '') && Number.isSafeInteger(identity?.proofRevision) && identity.proofRevision > 0;
const identityKeys = ['publicationSHA256', 'proofRevision', 'proofBodySHA256', 'resourceSHA256'];
const sameIdentity = (a, b) => identityKeys.every(key => a?.[key] === b?.[key]);
const incidentKey = (edition, episode) => createHash('sha256').update(`timetable-recovery:${edition}${episode ? `:episode:${episode}` : ''}`).digest('hex');
const invalid = () => new Error('Invalid timetable current coverage assessment');

function normalize(value) {
  if (value?.version !== 1 || !(value.edition === null || SHA.test(value.edition)) ||
      !Number.isSafeInteger(value.failures) || value.failures < 0 ||
      !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0 ||
      !Array.isArray(value.pending) || !Array.isArray(value.completed) ||
      value.pending.length + value.completed.length > MAX_SCOPES ||
      [...value.pending, ...value.completed].some(s => typeof s !== 'string' || !s || s.length > 128) ||
      new Set([...value.pending, ...value.completed]).size !== value.pending.length + value.completed.length ||
      !(value.incident === null || SHA.test(value.incident?.key) && typeof value.incident.delivered === 'boolean')) throw invalid();
  const generation = value.editionGeneration ?? 0, episode = value.episode ?? 0;
  const lastAssessmentAt = value.lastAssessmentAt ?? 0, phase = value.phase ?? 'unresolved';
  const requiredScopes = value.requiredScopes ?? [], demandScopes = value.demandScopes ?? [...value.pending, ...value.completed].filter(s => !requiredScopes.includes(s));
  const handoff = value.resolutionHandoff ?? null;
  if (![requiredScopes, demandScopes].every(scopes => Array.isArray(scopes) && scopes.length <= 256 && new Set(scopes).size === scopes.length && scopes.every(s => typeof s === 'string' && s.length > 0 && s.length <= 128))
    || demandScopes.some(s => requiredScopes.includes(s))
    || requiredScopes.length + demandScopes.length !== value.pending.length + value.completed.length
    || [...value.pending, ...value.completed].some(s => !requiredScopes.includes(s) && !demandScopes.includes(s))
    || !(handoff === null || handoff.publicationSHA256 === value.edition && Number.isSafeInteger(handoff.generation) && handoff.generation >= 0 && handoff.generation <= generation && Number.isSafeInteger(handoff.episode) && handoff.episode >= 0 && handoff.episode <= episode && handoff.resolved === true && validIdentity(handoff.assessment)
      && handoff.assessment.publicationSHA256 === value.edition && Number.isSafeInteger(handoff.assessment.assessedAt) && handoff.assessment.assessedAt >= 0
      && /^\d{4}-\d{2}-\d{2}$/.test(handoff.assessment.serviceDay))) throw invalid();
  if (![generation, episode, lastAssessmentAt].every(n => Number.isSafeInteger(n) && n >= 0)
      || !['healthy', 'unresolved'].includes(phase)
      || !(value.serviceDay == null || /^\d{4}-\d{2}-\d{2}$/.test(value.serviceDay))
      || !(value.assessment == null || validIdentity(value.assessment) && Number.isSafeInteger(value.assessment.assessedAt)
        && value.assessment.assessedAt >= 0 && value.assessment.assessedAt <= lastAssessmentAt
        && value.assessment.publicationSHA256 === value.edition && value.assessment.serviceDay === value.serviceDay)) throw invalid();
  return { ...structuredClone(value), editionGeneration: generation, episode, phase,
    lastAssessmentAt, requiredScopes, demandScopes, resolutionHandoff: handoff, serviceDay: value.serviceDay ?? null, assessment: value.assessment ?? null };
}

// One process owns the durable queue. Completion is a current proof/day
// assessment, not an edition-only promise. No scheduler beyond SerialWorker.
export class TimetableRecovery {
  constructor({ filePath, observation, latestIdentity, validScope, recover, alert, authorizeAlertEdition, assessCoverage,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = () => {} }) {
    this.store = new TransactionalJsonStore(filePath, INITIAL, normalize);
    Object.assign(this, { observation, latestIdentity, validScope, recover, alert, authorizeAlertEdition, assessCoverage, now });
    this.worker = new SerialWorker({ run: signal => this.#run(signal), onError, schedule, cancel });
  }
  async request(scope) {
    if (typeof scope !== 'string' || !scope || scope.length > 128 || !this.validScope(scope)) return false;
    return this.store.transaction(state => {
      if (state.pending.includes(scope) || state.completed.includes(scope)) return { changed: false, value: true };
      const required = state.requiredScopes.includes(scope);
      if (!required && state.demandScopes.length >= MAX_DEMAND || state.pending.length + state.completed.length >= MAX_SCOPES) return { changed: false, value: false };
      if (!required) state.demandScopes.push(scope);
      state.pending.push(scope); return { value: true };
    });
  }
  tick() { return this.worker.trigger(); }
  stop() { return this.worker.stop(); }
  async status() {
    await this.store.load(); const state = this.store.state;
    let matching = false;
    try { matching = sameIdentity(state.assessment, await this.latestIdentity()); } catch { /* unavailable is not healthy */ }
    return { publicationSHA256: state.edition, pendingScopes: state.pending.length, failures: state.failures,
      nextAttemptAt: state.nextAttemptAt, alertPending: Boolean(state.incident && !state.incident.delivered),
      serviceDay: state.serviceDay, assessmentIdentity: state.assessment,
      coverageCurrent: matching && this.#current(state.edition) && state.pending.length === 0 && state.phase === 'healthy' && state.serviceDay === serviceDay(this.now()) && this.now() >= state.lastAssessmentAt };
  }
  #current(edition) {
    const observed = this.observation.current(), at = this.now();
    return observed?.publicationSHA256 === edition && Number.isSafeInteger(at) && at >= 0
      && Date.parse(observed.observedAt) <= at && Date.parse(observed.expiresAt) > at;
  }
  #phase(state, phase) {
    if (state.phase !== phase) {
      if (state.editionGeneration === Number.MAX_SAFE_INTEGER || phase === 'unresolved' && state.episode === Number.MAX_SAFE_INTEGER) throw invalid();
      state.editionGeneration++;
      if (phase === 'unresolved') state.episode++;
      state.phase = phase; state.incident = null;
    }
    if (phase === 'healthy') {
      state.resolutionHandoff ??= { publicationSHA256: state.edition, generation: state.editionGeneration, episode: state.episode, resolved: true, assessment: structuredClone(state.assessment) };
      state.failures = 0; state.nextAttemptAt = 0; state.incident = null;
    }
  }
  async #authorize(signal) {
    if (!this.authorizeAlertEdition) return true;
    signal.throwIfAborted(); let state = this.store.state;
    try {
      if (state.resolutionHandoff) {
        const handoff = state.resolutionHandoff;
        await this.authorizeAlertEdition(handoff); signal.throwIfAborted();
        await this.store.transaction(next => { if (next.resolutionHandoff?.generation === handoff.generation) next.resolutionHandoff = null; });
        state = this.store.state;
      }
      await this.authorizeAlertEdition({ publicationSHA256: state.edition, generation: state.editionGeneration,
        episode: state.episode, resolved: state.phase === 'healthy' });
      signal.throwIfAborted(); return true;
    } catch { signal.throwIfAborted(); return false; }
  }
  async #assess(identity, signal) {
    if (!validIdentity(identity) || typeof this.assessCoverage !== 'function') throw invalid();
    const at = this.now(), before = this.store.state;
    if (!Number.isSafeInteger(at) || at < before.lastAssessmentAt) throw invalid();
    const requestedScopes = [...before.pending, ...before.completed];
    const result = await this.assessCoverage({ identity: structuredClone(identity), requestedScopes, at, signal });
    signal.throwIfAborted();
    const currentIdentity = await this.latestIdentity(); signal.throwIfAborted();
    const list = values => Array.isArray(values) && values.length <= MAX_SCOPES && new Set(values).size === values.length
      && values.every(s => typeof s === 'string' && s.length > 0 && s.length <= 128 && this.validScope(s));
    if (!this.#current(identity.publicationSHA256) || !sameIdentity(identity, currentIdentity)
      || serviceDay(this.now()) !== serviceDay(at) || this.now() < at || result?.valid !== true
      || result.publicationSHA256 !== identity.publicationSHA256 || result.proofRevision !== identity.proofRevision
      || result.proofBodySHA256 !== identity.proofBodySHA256 || result.assessedAt !== at || result.serviceDay !== serviceDay(at)
      || !list(result.requiredScopes) || result.requiredScopes.length > MAX_REQUIRED || !list(result.assessedScopes) || !list(result.coveredScopes) || !list(result.unresolvedScopes)) throw invalid();
    const partition = [...result.coveredScopes, ...result.unresolvedScopes];
    if (new Set(partition).size !== partition.length || partition.length !== result.assessedScopes.length
      || partition.some(s => !result.assessedScopes.includes(s)) || requestedScopes.some(s => !partition.includes(s)) || result.requiredScopes.some(s => !partition.includes(s))
      || result.assessedScopes.filter(s => !result.requiredScopes.includes(s)).length > MAX_DEMAND) throw invalid();
    await this.store.transaction(state => {
      signal.throwIfAborted();
      if (state.edition !== identity.publicationSHA256 || !this.#current(identity.publicationSHA256)
        || serviceDay(this.now()) !== result.serviceDay || this.now() < at) throw invalid();
      // Requests arriving during the read retain their place until assessed.
      const added = state.pending.filter(s => !requestedScopes.includes(s) && !partition.includes(s));
      if (partition.length + added.length > MAX_SCOPES) throw invalid();
      const unresolved = new Set(result.unresolvedScopes);
      state.pending = [...state.pending.filter(s => unresolved.has(s)),
        ...result.unresolvedScopes.filter(s => !state.pending.includes(s)), ...added];
      state.completed = [...result.coveredScopes];
      const demand = [...state.pending, ...state.completed].filter(s => !result.requiredScopes.includes(s));
      if (demand.length > MAX_DEMAND) throw invalid();
      state.requiredScopes = [...result.requiredScopes]; state.demandScopes = demand;
      state.serviceDay = result.serviceDay; state.lastAssessmentAt = at;
      state.assessment = { ...Object.fromEntries(identityKeys.map(k => [k, identity[k]])), serviceDay: result.serviceDay, assessedAt: at };
      if (state.pending.length) this.#phase(state, 'unresolved');
    });
    // The assessment write may have waited behind another transaction or disk
    // persistence. Re-read actual authority after it, before resolving custody.
    await this.#fence(identity, at, result.serviceDay, signal);
    if (this.store.state.pending.length === 0) {
      const beforeHealthy = this.store.state;
      await this.store.transaction(state => {
        signal.throwIfAborted();
        if (!this.#current(identity.publicationSHA256) || serviceDay(this.now()) !== result.serviceDay || this.now() < at) throw invalid();
        // A request may have committed while this write waited in the queue.
        // It was not part of the assessment and cannot resolve alert custody.
        this.#phase(state, state.pending.length ? 'unresolved' : 'healthy');
      });
      try { await this.#fence(identity, at, result.serviceDay, signal); }
      catch (error) {
        // No healthy authorization has left this method. Undo only this
        // unconfirmed transition, retaining any earlier pending custody.
        await this.store.transaction(state => {
          if (state.editionGeneration === Number.MAX_SAFE_INTEGER) throw invalid();
          state.editionGeneration++; state.phase = beforeHealthy.phase; state.episode = beforeHealthy.episode;
          state.incident = beforeHealthy.incident; state.failures = beforeHealthy.failures; state.nextAttemptAt = beforeHealthy.nextAttemptAt;
          state.resolutionHandoff = beforeHealthy.resolutionHandoff;
        });
        throw error;
      }
    }
  }
  async #fence(identity, at, day, signal) {
    const latest = await this.latestIdentity(); signal.throwIfAborted();
    if (!sameIdentity(identity, latest) || !this.#current(identity.publicationSHA256)
      || serviceDay(this.now()) !== day || this.now() < at) throw invalid();
  }
  async #reserve() {
    await this.store.transaction(state => {
      this.#phase(state, 'unresolved');
      state.failures = Math.min(state.failures + 1, 1_000_000);
      state.nextAttemptAt = this.now() + RETRY_MS[Math.max(0, Math.min(state.failures - 1, RETRY_MS.length - 1))];
      if (state.failures >= 3 && !state.incident) state.incident = { key: incidentKey(state.edition, state.episode), delivered: false };
    });
  }
  async #scheduleFailure(edition, signal, scopes = []) {
    await this.store.transaction(state => {
      state.pending = [...state.pending.filter(s => !scopes.includes(s)), ...scopes.filter(s => state.pending.includes(s))];
      state.nextAttemptAt = Math.max(state.nextAttemptAt, this.now() + RETRY_MS[Math.max(0, Math.min(state.failures - 1, RETRY_MS.length - 1))]);
    });
    const authorized = await this.#authorize(signal);
    await this.#deliverIncident(edition, signal, authorized);
    this.worker.scheduleRerun('recovery', Math.max(0, this.store.state.nextAttemptAt - this.now()));
  }
  async #run(signal) {
    const observed = this.observation.current(), edition = observed?.publicationSHA256;
    if (!SHA.test(edition ?? '') || !this.#current(edition)) return;
    await this.store.transaction(state => {
      if (state.edition === edition) return { changed: false };
      if (state.editionGeneration === Number.MAX_SAFE_INTEGER) throw invalid();
      state.editionGeneration++; state.edition = edition; state.episode = 0; state.phase = 'unresolved';
      state.pending = [...state.pending, ...state.completed]; state.completed = [];
      state.resolutionHandoff = null; state.assessment = null; state.serviceDay = null;
      state.failures = 0; state.nextAttemptAt = 0; state.incident = null;
    });
    // Repair the durable phase handoff before opening a later same-edition
    // episode. Alert-store errors never block timetable recovery.
    await this.#authorize(signal);
    if (!this.#current(edition)) return;
    let state = this.store.state;
    let latest;
    try { latest = await this.latestIdentity(); signal.throwIfAborted(); }
    catch {
      signal.throwIfAborted();
      if (state.nextAttemptAt <= this.now()) await this.#reserve();
      await this.#scheduleFailure(edition, signal); return;
    }
    if (latest?.publicationSHA256 === edition) {
      try { await this.#assess(latest, signal); }
      catch {
        signal.throwIfAborted();
        if (state.nextAttemptAt <= this.now()) await this.#reserve();
        await this.#scheduleFailure(edition, signal); return;
      }
      const authorized = await this.#authorize(signal);
      state = this.store.state;
      if (state.pending.length === 0) { this.worker.scheduleRerun('recovery', null); return; }
      // No delivery is acknowledged until this episode's durable authority was
      // accepted. A pending incident can still be retried during backoff.
      if (state.incident && !state.incident.delivered && state.nextAttemptAt <= this.now()) await this.#deliverIncident(edition, signal, authorized);
    }
    state = this.store.state;
    if (state.nextAttemptAt > this.now()) { this.worker.scheduleRerun('recovery', state.nextAttemptAt - this.now()); return; }
    const scopes = state.pending.slice(0, BATCH_SIZE), prior = state;
    await this.#reserve();
    try {
      signal.throwIfAborted();
      const result = await this.recover({ publicationSHA256: edition, scopes, signal }); signal.throwIfAborted();
      if (!Array.isArray(result?.unresolvedScopes) || result.unresolvedScopes.some(s => !scopes.includes(s))
          || new Set(result.unresolvedScopes).size !== result.unresolvedScopes.length || !this.#current(edition)) throw invalid();
      const identity = await this.latestIdentity(); signal.throwIfAborted();
      if (identity?.publicationSHA256 !== edition) throw invalid();
      await this.#assess(identity, signal);
      await this.#authorize(signal);
      if (this.store.state.pending.length === 0) { this.worker.scheduleRerun('recovery', null); return; }
      if (scopes.length && scopes.every(scope => this.store.state.completed.includes(scope))) {
        // Actual assessed progress permits the next bounded batch immediately;
        // it is not whole-publication health and cannot resolve an incident.
        await this.store.transaction(next => { next.nextAttemptAt = 0; if (!next.incident) next.failures = 0; });
        this.worker.scheduleRerun('recovery', 0); return;
      }
    } catch {
      if (signal.aborted) {
        await this.store.transaction(state => { state.failures = prior.failures; state.incident = prior.incident; });
        signal.throwIfAborted();
      }
    }
    await this.#scheduleFailure(edition, signal, scopes);
  }
  async #deliverIncident(edition, signal, authorized) {
    const state = this.store.state;
    if (!this.#current(edition) || state.edition !== edition || state.phase !== 'unresolved') return;
    if (state.incident && !state.incident.delivered && this.alert && authorized) {
      try {
        await this.alert({ key: state.incident.key, publicationSHA256: edition, episode: state.episode,
          reason: 'qualification-recovery-failed', pendingScopes: state.pending.length, signal });
        await this.store.transaction(next => { next.incident.delivered = true; });
      } catch {
        signal.throwIfAborted();
        await this.store.transaction(next => { next.nextAttemptAt = Math.max(next.nextAttemptAt, this.now() + RETRY_MS.at(-1)); });
      }
    } else if (state.incident && !state.incident.delivered) {
      await this.store.transaction(next => { next.nextAttemptAt = Math.max(next.nextAttemptAt, this.now() + RETRY_MS.at(-1)); });
    }
  }
}
