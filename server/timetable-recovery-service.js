// Default-off server ownership only. Producer/admission/incident policy stays
// in its existing owners; this adapter adds no route or periodic scheduler.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePublicationResource } from './timetable-publication-resource.js';
import path from 'node:path';
import { TimetableRecovery } from './timetable-recovery.js';
import { TimetableRecoveryProducer } from './timetable-recovery-producer.js';
import { GitHubTimetableRecoveryAlert } from './timetable-recovery-github-alert.js';
import { validBoard, STATION_BOARD_LINES } from './station-board-v2.js';

const invalid = () => new Error('Invalid timetable recovery configuration');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
export function loadTimetableRecoveryConfig(env = {}, { servedDirectory } = {}) {
  const enabled = env.TUBEBOARD_TIMETABLE_RECOVERY_ENABLED;
  if (enabled !== undefined && enabled !== 'false' && enabled !== 'true') throw invalid();
  if (enabled !== 'true') return { enabled: false };
  const directory = env.TUBEBOARD_TIMETABLE_RECOVERY_DIRECTORY || '/data/timetable-recovery';
  const admission = env.TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY;
  const absolute = value => typeof value === 'string' && value !== path.parse(value).root
    && path.isAbsolute(value) && path.resolve(value) === value;
  if (env.TUBEBOARD_TIMETABLE_EDITION_MONITOR_ENABLED !== 'true' || !absolute(directory) || !absolute(admission)
      || !/^[a-f0-9]{64}$/.test(env.TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_BASELINE_SHA256 || '')
      || inside(directory, admission) || inside(admission, directory)
      || servedDirectory && [directory, admission].some(root => inside(path.resolve(servedDirectory), root) || inside(root, path.resolve(servedDirectory)))) throw invalid();
  const token = env.TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_TOKEN;
  if (token !== undefined && (typeof token !== 'string' || !token || token.trim() !== token)) throw invalid();
  const author = env.TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_AUTHOR_ID;
  if (author !== undefined && (!/^[1-9][0-9]*$/.test(author) || !Number.isSafeInteger(Number(author)))) throw invalid();
  return { enabled: true, directory,
    stateFile: path.join(directory, 'recovery.json'), cacheDirectory: path.join(directory, 'archive-cache'),
    workDirectory: path.join(directory, 'producer-work'), alertFile: path.join(directory, 'operator-alert.json'),
    alertToken: env.TUBEBOARD_TIMETABLE_RECOVERY_GITHUB_TOKEN || null, alertAuthorID: author ? Number(author) : null };
}

export function validRecoveryScope(scope) {
  if (typeof scope !== 'string' || !/^[a-z][a-z-]*\/[A-Za-z0-9]+$/.test(scope) || scope.length > 128) return false;
  const [line, station] = scope.split('/');
  return validBoard(station, line);
}

export class TimetableRecoveryService {
  constructor({ config, admissionStore, observation, activityStore, activityConfig, onError = () => {},
    Producer = TimetableRecoveryProducer, Recovery = TimetableRecovery, Alert = GitHubTimetableRecoveryAlert }) {
    Object.assign(this, { config, activityStore, activityConfig, onError, observation });
    this.admissionReady = Promise.resolve(admissionStore);
    this.components = { Producer, Recovery, Alert };
    this.supportedScopes = new Set(); this.supportedIdentity = null;
    this.stopped = false; this.pending = new Set(); this.syncing = null; this.wakePending = false;
    this.initializing = null;
    this.ready = config.enabled ? this.#ensureReady() : Promise.resolve(null);
    if (config.enabled) this.tick();
  }
  #ensureReady() {
    if (this.stopped) return Promise.resolve(null);
    if (this.recovery) return Promise.resolve(this.recovery);
    if (this.initializing) return this.initializing;
    this.initializing = this.#initialize().catch(() => { this.onError(); return null; })
      .finally(() => { this.initializing = null; });
    this.ready = this.initializing;
    return this.initializing;
  }
  async #initialize() {
    const store = await this.admissionReady;
    if (this.stopped) return null;
    if (!store?.latestAdmittedIdentity || typeof store.readPublicPublicationBytes !== 'function') throw invalid();
    const { config, observation } = this, { Producer, Recovery, Alert } = this.components;
    await fs.mkdir(config.directory, { recursive: true, mode: 0o700 });
    // No symlinked state/cache/work root; producer independently checks every
    // cache/work path and retains its existing kernel-custody limits.
    if (await fs.realpath(config.directory) !== config.directory) throw invalid();
    if (this.stopped) return null;
    const producer = new Producer({ admissionStore: store, cacheDirectory: config.cacheDirectory, workDirectory: config.workDirectory,
      readCurrentResource: async (identity, { signal } = {}) => {
        signal?.throwIfAborted();
        const bytes = await store.readPublicPublicationBytes(identity.publicationSHA256);
        signal?.throwIfAborted(); return bytes;
      } });
    const alert = config.alertToken && config.alertAuthorID ? new Alert({ filePath: config.alertFile,
      token: config.alertToken, actorID: config.alertAuthorID }) : null;
    // New-demand eligibility is ancillary: its transient read must never stop
    // an existing coordinator from repairing its durable required/prior queue.
    const recovery = new Recovery({ filePath: config.stateFile, observation,
      latestIdentity: () => store.latestAdmittedIdentity, validScope: validRecoveryScope,
      recover: request => producer.recover(request), assessCoverage: request => producer.assessCurrentCoverage(request),
      discoverOrigins: request => producer.discoverOrigins(request),
      discoveryBindings: request => producer.discoveryBindings(request),
      ...(alert ? { alert: request => alert.deliver(request), authorizeAlertEdition: request => alert.authorizeEdition(request) } : {}),
      onError: () => this.onError() });
    this.admissionStore = store; this.producer = producer; this.recovery = recovery;
    return recovery;
  }

  // Call only after validated registration custody was accepted. Persist scope
  // alone; never copy activity/token/install/customer records into this queue.
  accepted(record) {
    if (!this.config.enabled || this.stopped || record?.registrationAccepted === false || record?.contentStateContract !== 'station-board-v2') return false;
    const scope = `${record.lineID}/${record.stationID}`;
    if (!this.#supports(scope)) {
      // A valid accepted registration is also an existing wake opportunity
      // after transient initialization/readback failure, without admitting it.
      if (validRecoveryScope(scope)) this.tick();
      return false;
    }
    if (!this.pending.has(scope) && this.pending.size >= 256) return false;
    this.pending.add(scope); this.tick(); return true;
  }

  #supports(scope) {
    return validRecoveryScope(scope) && !STATION_BOARD_LINES.get(scope.split('/')[0])?.qualifiedRailDepartureSource
      && (this.supportedScopes.has(scope) || this.recovery?.supportsDiscoveredScope?.(scope) === true);
  }
  async #refreshSupported() {
    const identity = this.admissionStore.latestAdmittedIdentity;
    const key = JSON.stringify(identity);
    if (key === this.supportedIdentity) return;
    const bytes = await this.admissionStore.readPublicPublicationBytes(identity.publicationSHA256);
    const metadata = validatePublicationResource(bytes, identity.publicationSHA256);
    if (createHash('sha256').update(bytes).digest('hex') !== identity.resourceSHA256
        || metadata.revision !== identity.proofRevision || metadata.proofBodySHA256 !== identity.proofBodySHA256
        || JSON.stringify(this.admissionStore.latestAdmittedIdentity) !== key) throw invalid();
    const wrapper = JSON.parse(bytes), proof = JSON.parse(Buffer.from(wrapper.proofBodyBase64, 'base64'));
    const supported = new Set();
    for (const entry of proof.entries) {
      const scope = `${entry.lineID}/${entry.stationID}`;
      if (entry.status === 'qualified' && validRecoveryScope(scope)) supported.add(scope);
    }
    this.supportedScopes = supported; this.supportedIdentity = key;
  }

  // Observer and HTTP success never join a producer's potentially 300-second promise.
  // Coalesce local restoration work independently of the coordinator's worker.
  tick() {
    if (!this.config.enabled || this.stopped) return;
    this.wakePending = true;
    if (this.syncing) return;
    this.syncing = this.#sync().catch(() => this.onError()).finally(() => {
      this.syncing = null;
      if (this.wakePending && !this.stopped) this.tick();
    });
  }
  async #sync() {
    const recovery = await this.#ensureReady();
    if (!recovery || this.stopped) { this.wakePending = false; return; }
    do {
      this.wakePending = false;
      let failed = false, eligible = false, records = [];
      try { await this.#refreshSupported(); eligible = true; }
      catch {
        // Never broaden scope authority after an invalid/raced read. Retry
        // only at a later existing external tick, without dropping history.
        this.supportedScopes = new Set(); this.supportedIdentity = null;
        failed = true; this.onError();
      }
      if (this.stopped) return;
      if (eligible) {
        try { records = await this.activityStore.listActive(new Date(), this.activityConfig); }
        catch { failed = true; this.onError(); }
        if (this.stopped) return;
        for (const record of records) {
          const scope = `${record.lineID}/${record.stationID}`;
          if (record.contentStateContract === 'station-board-v2' && this.#supports(scope)
              && (this.pending.has(scope) || this.pending.size < 256)) this.pending.add(scope);
        }
        for (const scope of this.pending) {
          if (this.stopped) return;
          try {
            if (this.#supports(scope)) await recovery.request(scope);
            this.pending.delete(scope);
          } catch { failed = true; this.onError(); }
        }
      }
      if (!this.stopped) void recovery.tick().catch(() => this.onError());
      // Ancillary failure is not a self-trigger. Future observer/accepted
      // registration ticks can retry, while required recovery runs now.
      if (failed) this.wakePending = false;
    } while (this.wakePending && !this.stopped);
  }

  stop() {
    this.stopped = true; this.pending.clear(); this.wakePending = false;
    // Abort immediately. Late admission initialization checks stopped before
    // construction; it cannot create a worker after shutdown has returned.
    if (!this.recovery) return Promise.resolve();
    return Promise.all([this.recovery.stop(), this.syncing]);
  }
}
