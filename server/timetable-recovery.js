import { createHash } from 'node:crypto';
import { TransactionalJsonStore } from './transactional-json-store.js';
import { SerialWorker } from './worker-lifecycle.js';
import { validateOriginDiscovery } from './timetable-origin-discovery.js';

const SHA = /^[a-f0-9]{64}$/;
const MAX_DEMAND = 256, MAX_REQUIRED = 256, MAX_SCOPES = 512, BATCH_SIZE = 32;
const RETRY_MS = [60_000, 300_000, 1_800_000, 21_600_000];
const INITIAL = { version: 1, edition: null, editionGeneration: 0, episode: 0, phase: 'unresolved',
  serviceDay: null, assessment: null, lastAssessmentAt: 0, requiredScopes: [], demandScopes: [], resolutionHandoff: null, pending: [], completed: [], failures: 0,
  nextAttemptAt: 0, incident: null, discovery: null, discoveryError: null, publicationRequiredScopes: [] };
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
  const publicationRequiredScopes = value.publicationRequiredScopes ?? requiredScopes;
  const discovery = value.discovery ?? null, discoveryError = value.discoveryError ?? null;
  if (discovery !== null) validateOriginDiscovery(discovery);
  if (![null, 'unavailable', 'required-scope-overflow'].includes(discoveryError)
      || !Array.isArray(publicationRequiredScopes) || publicationRequiredScopes.length > MAX_REQUIRED
      || new Set(publicationRequiredScopes).size !== publicationRequiredScopes.length
      || publicationRequiredScopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 128
        || !requiredScopes.includes(scope))) throw invalid();
  const handoff = value.resolutionHandoff ?? null;
  const discoveryFence = handoff?.discoveryFence;
  if (discoveryFence !== undefined && (!discoveryFence || typeof discoveryFence !== 'object'
      || Object.keys(discoveryFence).sort().join(',') !== 'confirmedAt,epoch,validUntil'
      || !SHA.test(discoveryFence.epoch) || typeof discoveryFence.validUntil !== 'string'
      || !Number.isFinite(Date.parse(discoveryFence.validUntil))
      || !(discoveryFence.confirmedAt === null || Number.isSafeInteger(discoveryFence.confirmedAt)
        && discoveryFence.confirmedAt >= handoff.assessment?.assessedAt
        && discoveryFence.confirmedAt < Date.parse(discoveryFence.validUntil)))) throw invalid();
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
  return { ...structuredClone(value), discovery, discoveryError, publicationRequiredScopes, editionGeneration: generation, episode, phase,
    lastAssessmentAt, requiredScopes, demandScopes, resolutionHandoff: handoff, serviceDay: value.serviceDay ?? null, assessment: value.assessment ?? null };
}

// One process owns the durable queue. Completion is a current proof/day
// assessment, not an edition-only promise. No scheduler beyond SerialWorker.
export class TimetableRecovery {
  constructor({ filePath, observation, latestIdentity, validScope, recover, alert, authorizeAlertEdition, assessCoverage,
    discoverOrigins, discoveryBindings,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = () => {} }) {
    this.store = new TransactionalJsonStore(filePath, INITIAL, normalize);
    Object.assign(this, { observation, latestIdentity, validScope, recover, alert, authorizeAlertEdition, assessCoverage, now,
      discoverOrigins, discoveryBindings });
    this.discoveryValidated = false;
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
      discoveryCurrent: this.#discoveryCurrent(), discoveryError: state.discoveryError,
      discoveredEligibleScopes: state.discovery?.eligibleScopes.length ?? 0,
      currentDiscoveryGaps: state.discovery?.unresolvedPublicSourceGaps.filter(gap => gap.affectsCurrentCoverage).length ?? 0,
      coverageCurrent: matching && this.#current(state.edition) && this.#discoveryHealthy() && state.pending.length === 0 && state.phase === 'healthy' && state.serviceDay === serviceDay(this.now()) && this.now() >= state.lastAssessmentAt };
  }
  supportsDiscoveredScope(scope) {
    return Boolean(this.discoverOrigins && this.#discoveryCurrent() && this.store.state.discovery.requiredScopes.includes(scope));
  }
  #discoveryCurrent() {
    if (!this.discoverOrigins) return true;
    const state = this.store.state, inventory = state.discovery;
    return this.discoveryValidated && !state.discoveryError && inventory
      && inventory.publicationSHA256 === state.edition && this.#current(state.edition)
      && this.now() >= Date.parse(inventory.assessedAt) && this.now() < Date.parse(inventory.validUntil)
      && inventory.serviceDay === serviceDay(this.now());
  }
  #discoveryHealthy() {
    return !this.discoverOrigins || this.#discoveryCurrent() && this.store.state.discovery.discoveryStatus === 'complete';
  }
  #discoveryEpoch(inventory = this.store.state.discovery) {
    return this.discoverOrigins ? createHash('sha256').update(JSON.stringify(inventory)).digest('hex') : null;
  }
  async #discover(edition, signal) {
    if (!this.discoverOrigins) return;
    this.discoveryValidated = false;
    try {
      let inventory = this.store.state.discovery, bindings;
      try { bindings = await this.discoveryBindings({ publicationSHA256: edition, signal });
        validateOriginDiscovery(inventory, { publicationSHA256: edition, at: this.now(), bindings }); }
      catch {
        signal.throwIfAborted();
        if (this.store.state.nextAttemptAt > this.now()) throw invalid();
        inventory = await this.discoverOrigins({ publicationSHA256: edition, signal });
        bindings = await this.discoveryBindings({ publicationSHA256: edition, signal });
        validateOriginDiscovery(inventory, { publicationSHA256: edition, at: this.now(), bindings });
      }
      signal.throwIfAborted();
      if (!this.#current(edition)) throw invalid();
      await this.store.transaction(state => {
        signal.throwIfAborted();
        if (state.edition !== edition || !this.#current(edition)) throw invalid();
        const required = [...new Set([...state.publicationRequiredScopes, ...inventory.requiredScopes,
          ...(inventory.discoveryStatus === 'incomplete' ? state.requiredScopes : [])])];
        state.discovery = structuredClone(inventory);
        if (!inventory.requiredScopesComplete || !inventory.eligibleScopesComplete) {
          // Overflow reports its full denominator, never a replacement prefix.
          // Existing independent required/demand custody remains repairable.
          state.discoveryError = null; this.#phase(state, 'unresolved'); return;
        }
        if (required.length > MAX_REQUIRED) {
          state.discoveryError = 'required-scope-overflow'; this.#phase(state, 'unresolved'); return;
        }
        state.discoveryError = null;
        const demand = state.demandScopes.filter(scope => !required.includes(scope));
        const keep = new Set([...required, ...demand]);
        // Preserve failure rotation, retain customer demand, append newly found
        // origins. A new observation must never sort failed scopes to the front.
        state.pending = state.pending.filter(scope => keep.has(scope));
        state.completed = state.completed.filter(scope => keep.has(scope));
        for (const scope of keep) if (!state.pending.includes(scope) && !state.completed.includes(scope)) state.pending.push(scope);
        state.requiredScopes = required; state.demandScopes = demand;
        if (inventory.discoveryStatus !== 'complete' || state.pending.length) this.#phase(state, 'unresolved');
      });
      this.discoveryValidated = true;
    } catch {
      signal.throwIfAborted();
      await this.store.transaction(state => { state.discoveryError = 'unavailable'; this.#phase(state, 'unresolved'); });
    }
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
      if (phase === 'unresolved' && state.resolutionHandoff?.discoveryFence?.confirmedAt !== null) state.episode++;
      state.phase = phase; state.incident = null;
    }
    if (phase === 'healthy') {
      if (!state.resolutionHandoff || state.resolutionHandoff.discoveryFence?.confirmedAt === null) {
        state.resolutionHandoff = { publicationSHA256: state.edition, generation: state.editionGeneration,
          episode: state.episode, resolved: true, assessment: structuredClone(state.assessment),
          ...(this.discoverOrigins ? { discoveryFence: { epoch: this.#discoveryEpoch(state.discovery),
            validUntil: state.discovery.validUntil, confirmedAt: null } } : {}) };
      }
      state.failures = 0; state.nextAttemptAt = 0; state.incident = null;
    }
  }
  async #authorize(signal) {
    if (!this.authorizeAlertEdition) return true;
    signal.throwIfAborted(); let state = this.store.state;
    try {
      if (state.resolutionHandoff) {
        const handoff = state.resolutionHandoff;
        // An interrupted new healthy write is not a confirmed historical
        // interval. Keep custody until a fresh assessment can confirm it.
        if (handoff.discoveryFence?.confirmedAt === null) {
          if (state.phase === 'healthy') return false;
          // No confirmed healthy interval occurred. Preserve the pending
          // handoff, but current unresolved authority and alerts must proceed.
        } else {
          await this.authorizeAlertEdition(handoff); signal.throwIfAborted();
          await this.store.transaction(next => { if (next.resolutionHandoff?.generation === handoff.generation) next.resolutionHandoff = null; });
          state = this.store.state;
        }
      }
      if (this.discoverOrigins && state.phase === 'healthy' && !this.#discoveryHealthy()) {
        await this.store.transaction(next => { if (next.phase === 'healthy' && !this.#discoveryHealthy()) this.#phase(next, 'unresolved'); });
        state = this.store.state;
      }
      // Historical handoff repair above may have awaited a different store.
      // It cannot confer current resolution after this inventory expires.
      if (this.discoverOrigins && state.phase === 'healthy' && !this.#discoveryHealthy()) return false;
      await this.authorizeAlertEdition({ publicationSHA256: state.edition, generation: state.editionGeneration,
        episode: state.episode, resolved: state.phase === 'healthy' });
      signal.throwIfAborted(); return true;
    } catch { signal.throwIfAborted(); return false; }
  }
  async #assess(identity, signal) {
    if (!validIdentity(identity) || typeof this.assessCoverage !== 'function') throw invalid();
    const at = this.now(), before = this.store.state;
    const discoveryEpoch = this.#discoveryEpoch();
    if (!Number.isSafeInteger(at) || at < before.lastAssessmentAt) throw invalid();
    const requestedScopes = [...before.pending, ...before.completed];
    const result = await this.assessCoverage({ identity: structuredClone(identity), requestedScopes,
      mandatoryScopes: this.discoverOrigins ? before.requiredScopes : [], at, signal });
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
      if (this.discoverOrigins) {
        if (state.requiredScopes.some(scope => !result.requiredScopes.includes(scope))) throw invalid();
        const publicationRequired = result.publicationRequiredScopes;
        if (!list(publicationRequired) || publicationRequired.length > MAX_REQUIRED
            || publicationRequired.some(scope => !result.requiredScopes.includes(scope))) throw invalid();
        state.publicationRequiredScopes = [...new Set([...state.publicationRequiredScopes, ...publicationRequired])];
        if (state.publicationRequiredScopes.length > MAX_REQUIRED) throw invalid();
      } else state.publicationRequiredScopes = [...result.requiredScopes];
      state.requiredScopes = [...result.requiredScopes]; state.demandScopes = demand;
      state.serviceDay = result.serviceDay; state.lastAssessmentAt = at;
      state.assessment = { ...Object.fromEntries(identityKeys.map(k => [k, identity[k]])), serviceDay: result.serviceDay, assessedAt: at };
      if (state.pending.length) this.#phase(state, 'unresolved');
    });
    // The assessment write may have waited behind another transaction or disk
    // persistence. Re-read actual authority after it, before resolving custody.
    await this.#fence(identity, at, result.serviceDay, signal);
    if (this.store.state.pending.length === 0 && this.#discoveryHealthy()) {
      const beforeHealthy = this.store.state;
      await this.store.transaction(state => {
        signal.throwIfAborted();
        if (!this.#current(identity.publicationSHA256) || serviceDay(this.now()) !== result.serviceDay || this.now() < at) throw invalid();
        // A request may have committed while this write waited in the queue.
        // It was not part of the assessment and cannot resolve alert custody.
        this.#phase(state, state.pending.length || !this.#discoveryHealthy()
          || this.#discoveryEpoch(state.discovery) !== discoveryEpoch ? 'unresolved' : 'healthy');
      });
      try {
        await this.#fence(identity, at, result.serviceDay, signal, discoveryEpoch, true);
        if (this.discoverOrigins && this.store.state.resolutionHandoff?.discoveryFence?.confirmedAt === null) {
          await this.store.transaction(state => {
            const handoff = state.resolutionHandoff;
            if (!handoff || handoff.assessment.assessedAt !== at || handoff.discoveryFence?.epoch !== discoveryEpoch
                || !this.#discoveryHealthy() || this.#discoveryEpoch(state.discovery) !== discoveryEpoch) throw invalid();
            // This timestamp records the genuine post-healthy-write fence,
            // never a later retiming of an older confirmed interval.
            handoff.discoveryFence.confirmedAt = this.now();
          });
        }
      }
      catch (error) {
        // No healthy authorization has left this method. Undo only this
        // unconfirmed transition, retaining any earlier pending custody.
        await this.store.transaction(state => {
          if (state.editionGeneration === Number.MAX_SAFE_INTEGER) throw invalid();
          state.editionGeneration++; state.phase = beforeHealthy.phase; state.episode = beforeHealthy.episode;
          state.incident = beforeHealthy.incident; state.failures = beforeHealthy.failures; state.nextAttemptAt = beforeHealthy.nextAttemptAt;
          state.resolutionHandoff = beforeHealthy.resolutionHandoff;
          if (this.discoverOrigins && !this.#discoveryHealthy()) this.#phase(state, 'unresolved');
        });
        throw error;
      }
    }
  }
  async #fence(identity, at, day, signal, discoveryEpoch = null, requireComplete = false) {
    const latest = await this.latestIdentity(); signal.throwIfAborted();
    if (!sameIdentity(identity, latest) || !this.#current(identity.publicationSHA256)
      || serviceDay(this.now()) !== day || this.now() < at
      || discoveryEpoch !== null && (!this.#discoveryCurrent() || this.#discoveryEpoch() !== discoveryEpoch
        || requireComplete && !this.#discoveryHealthy())) throw invalid();
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
      if (this.discoverOrigins) {
        const keep = new Set([...state.publicationRequiredScopes, ...state.demandScopes]);
        state.pending = state.pending.filter(scope => keep.has(scope));
        state.requiredScopes = [...state.publicationRequiredScopes]; state.discovery = null; state.discoveryError = null;
      }
      state.resolutionHandoff = null; state.assessment = null; state.serviceDay = null;
      state.failures = 0; state.nextAttemptAt = 0; state.incident = null;
    });
    await this.#discover(edition, signal);
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
      if (state.pending.length === 0 && this.#discoveryHealthy()) { this.worker.scheduleRerun('recovery', null); return; }
      // No delivery is acknowledged until this episode's durable authority was
      // accepted. A pending incident can still be retried during backoff.
      if (state.incident && !state.incident.delivered && state.nextAttemptAt <= this.now()) await this.#deliverIncident(edition, signal, authorized);
    }
    state = this.store.state;
    if (state.nextAttemptAt > this.now()) { this.worker.scheduleRerun('recovery', state.nextAttemptAt - this.now()); return; }
    if (this.discoverOrigins && state.pending.length === 0 && !this.#discoveryHealthy()
        && (!validIdentity(latest) || latest.publicationSHA256 === edition)) {
      await this.#reserve(); await this.#scheduleFailure(edition, signal); return;
    }
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
      if (this.store.state.pending.length === 0 && this.#discoveryHealthy()) { this.worker.scheduleRerun('recovery', null); return; }
      if (scopes.some(scope => this.store.state.completed.includes(scope) && !prior.completed.includes(scope))) {
        // Actual assessed progress permits the next bounded batch immediately;
        // it is not whole-publication health and cannot resolve an incident.
        await this.store.transaction(next => {
          next.pending = [...next.pending.filter(scope => !scopes.includes(scope)), ...next.pending.filter(scope => scopes.includes(scope))];
          next.nextAttemptAt = 0; if (!next.incident) next.failures = 0;
        });
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
