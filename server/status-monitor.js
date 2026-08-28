export const STATUS_SCHEMA_VERSION = 2;
export const STATUS_V1_SCHEMA_VERSION = 1;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_SPACING_MS = 2_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const REQUIRED_UNHEALTHY_WINDOWS = 3;
const REQUIRED_HEALTHY_WINDOWS = 2;

export const STATUS_LINES = [
  { id: 'bakerloo', name: 'Bakerloo', stations: ['940GZZLUWKA', '940GZZLULBN'] },
  { id: 'central', name: 'Central', stations: ['940GZZLULYN', '940GZZLUBNK'] },
  // Circle trains terminate at Edgware Road and pass Baker Street. Tower Hill
  // and Aldgate are shared termini/through stations where TfL's StopPoint
  // Arrivals response can be valid but omit Circle trains entirely, creating
  // a permanent false-degraded signal while live boards remain available.
  { id: 'circle', name: 'Circle', stations: ['940GZZLUERC', '940GZZLUBST'] },
  { id: 'district', name: 'District', stations: ['940GZZLUTWH', '940GZZLUUPK'] },
  { id: 'hammersmith-city', name: 'Hammersmith & City', stations: ['940GZZLUHSC', '940GZZLUWHM'] },
  { id: 'jubilee', name: 'Jubilee', stations: ['940GZZLUSJW', '940GZZLUWLO'] },
  { id: 'metropolitan', name: 'Metropolitan', stations: ['940GZZLUNOW', '940GZZLUALD'] },
  { id: 'northern', name: 'Northern', stations: ['940GZZLUCTN', '940GZZLUMDN'] },
  { id: 'piccadilly', name: 'Piccadilly', stations: ['940GZZLUCKS', '940GZZLUUXB'] },
  { id: 'victoria', name: 'Victoria', stations: ['940GZZLUPCO', '940GZZLUBLR'] },
  { id: 'waterloo-city', name: 'Waterloo & City', stations: ['940GZZLUWLO', '940GZZLUBNK'] },
  { id: 'liberty', name: 'Liberty', stations: ['910GROMFORD', '910GUPMNSTR'] },
  { id: 'lioness', name: 'Lioness', stations: ['910GEUSTON', '910GWATFJDC'] },
  { id: 'mildmay', name: 'Mildmay', stations: ['910GSTFD', '910GRICHMND'] },
  { id: 'suffragette', name: 'Suffragette', stations: ['910GGOSPLOK', '910GBARKRIV'] },
  { id: 'weaver', name: 'Weaver', stations: ['910GLIVST', '910GCHINGFD'] },
  { id: 'windrush', name: 'Windrush', stations: ['910GHGHI', '910GWCROYDN'] }
];

export const STATUS_REQUEST_BUDGET_PER_CYCLE = 1 + STATUS_LINES.reduce(
  (total, line) => total + line.stations.length,
  0
);
export const STATUS_V1_REQUEST_BUDGET_PER_CYCLE = 23;
const STATUS_V1_LINE_IDS = new Set(STATUS_LINES.slice(0, 11).map((line) => line.id));

export function statusSnapshotForVersion(snapshot, version) {
  if (version === STATUS_SCHEMA_VERSION) {
    return structuredClone(snapshot);
  }
  if (version !== STATUS_V1_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported status contract version ${version}`);
  }

  const lines = snapshot.lines.filter((line) => STATUS_V1_LINE_IDS.has(line.id));
  const state = overallState(lines);
  return {
    ...structuredClone(snapshot),
    schemaVersion: STATUS_V1_SCHEMA_VERSION,
    state,
    summary: overallSummary(state),
    checker: {
      ...structuredClone(snapshot.checker),
      requestBudgetPerCycle: STATUS_V1_REQUEST_BUDGET_PER_CYCLE
    },
    lines
  };
}

export function loadStatusConfig(env = process.env) {
  return {
    enabled: env.TUBEBOARD_STATUS_MONITOR_ENABLED === 'true',
    intervalMs: boundedInteger(env.TUBEBOARD_STATUS_INTERVAL_MS, DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS, 60 * 60 * 1000),
    staleAfterMs: boundedInteger(env.TUBEBOARD_STATUS_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS, 60 * 60 * 1000),
    requestSpacingMs: boundedInteger(env.TUBEBOARD_STATUS_REQUEST_SPACING_MS, DEFAULT_REQUEST_SPACING_MS, DEFAULT_REQUEST_SPACING_MS, 30_000),
    requestTimeoutMs: boundedInteger(env.TUBEBOARD_STATUS_REQUEST_TIMEOUT_MS, 8_000, 2_000, 30_000),
    tflAppKey: env.TFL_APP_KEY || '',
    notice: boundedNotice(env.TUBEBOARD_STATUS_NOTICE)
  };
}

export class TubeBoardStatusMonitor {
  constructor({
    config = loadStatusConfig(),
    fetchImpl = fetch,
    now = () => new Date(),
    sleep = defaultSleep,
    logger = console
  } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.history = new Map();
    this.running = false;
    this.timer = null;
    this.snapshot = createUnknownSnapshot(this.now(), config);
  }

  start(initialDelayMs = 2_000) {
    if (!this.config.enabled || this.timer) {
      return;
    }

    this.timer = setTimeout(() => this.runAndSchedule(), initialDelayMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runAndSchedule() {
    this.timer = null;
    const result = await this.runCycle();
    const delayMs = Math.max(this.config.intervalMs, result.backoffMs || 0);
    this.timer = setTimeout(() => this.runAndSchedule(), delayMs);
    this.timer.unref?.();
  }

  async runCycle() {
    if (!this.config.enabled) {
      this.snapshot = createUnknownSnapshot(this.now(), this.config);
      return { backoffMs: 0 };
    }

    if (this.running) {
      return { backoffMs: 0, skipped: true };
    }

    this.running = true;
    let requestedBackoffMs = 0;

    try {
      const officialResult = await this.fetchOfficialStatuses();
      requestedBackoffMs = Math.max(requestedBackoffMs, officialResult.backoffMs || 0);
      const officialByLine = officialResult.statuses;
      const checkedAt = this.now();
      const lines = [];

      for (const line of STATUS_LINES) {
        const observations = [];

        for (const stationID of line.stations) {
          await this.sleep(this.config.requestSpacingMs);

          const observation = await this.fetchStationObservation(stationID, line.id);
          observations.push(observation);
          requestedBackoffMs = Math.max(requestedBackoffMs, observation.backoffMs || 0);
          if (observation.state === 'rate-limited') {
            const error = new Error('TfL rate limited the status sweep');
            error.backoffMs = observation.backoffMs || this.config.intervalMs;
            throw error;
          }
        }

        const official = officialByLine.get(line.id) || unknownOfficialStatus();
        const evidence = classifyEvidence(observations, official, checkedAt);
        const tubeBoard = this.applyEvidence(line.id, evidence, observations);
        lines.push({ id: line.id, name: line.name, official, tubeBoard });
      }

      const state = overallState(lines);
      this.snapshot = {
        schemaVersion: STATUS_SCHEMA_VERSION,
        state,
        summary: overallSummary(state),
        checkedAt: checkedAt.toISOString(),
        staleAt: new Date(checkedAt.getTime() + this.config.staleAfterMs).toISOString(),
        notice: this.config.notice,
        checker: {
          state: 'current',
          intervalSeconds: Math.round(this.config.intervalMs / 1000),
          requestBudgetPerCycle: STATUS_REQUEST_BUDGET_PER_CYCLE,
          scheduledFullSweep: false
        },
        lines
      };
    } catch (error) {
      requestedBackoffMs = Math.max(requestedBackoffMs, error.backoffMs || 0);
      this.logger.warn?.(`TubeBoard status cycle unavailable: ${safeErrorMessage(error)}`);
      this.snapshot = createUnknownSnapshot(this.now(), this.config, 'The latest TubeBoard data check could not complete.');
    } finally {
      this.running = false;
    }

    return { backoffMs: Math.min(requestedBackoffMs, MAX_BACKOFF_MS) };
  }

  getSnapshot(at = this.now()) {
    const checkedAtMs = Date.parse(this.snapshot.checkedAt || '');
    if (!Number.isFinite(checkedAtMs)) {
      return structuredClone(this.snapshot);
    }
    if (at.getTime() - checkedAtMs > this.config.staleAfterMs) {
      return markSnapshotStale(this.snapshot, this.config);
    }
    return structuredClone(this.snapshot);
  }

  async fetchOfficialStatuses() {
    const url = new URL('https://api.tfl.gov.uk/Line/Mode/tube,overground/Status');
    addAppKey(url, this.config.tflAppKey);
    const result = await fetchJson(url, this.config, this.fetchImpl);
    if (!Array.isArray(result.value)) {
      return { statuses: new Map(), backoffMs: result.backoffMs };
    }

    const statuses = new Map();
    for (const rawLine of result.value) {
      if (!rawLine || typeof rawLine.id !== 'string' || !Array.isArray(rawLine.lineStatuses)) {
        continue;
      }

      const validStatuses = rawLine.lineStatuses.filter((entry) => {
        return entry && Number.isInteger(entry.statusSeverity);
      });
      const lineStatus = validStatuses.find((entry) => entry.statusSeverity !== 10)
        || validStatuses[0];
      if (!lineStatus) {
        continue;
      }

      const isGoodService = lineStatus.statusSeverity === 10;
      statuses.set(rawLine.id, {
        state: isGoodService ? 'good-service' : 'disrupted',
        summary: safePublicText(lineStatus.statusSeverityDescription, isGoodService ? 'Good service' : 'Service disruption'),
        reason: isGoodService ? null : safePublicText(lineStatus.reason, 'See TfL for current service information.')
      });
    }

    return { statuses, backoffMs: result.backoffMs };
  }

  async fetchStationObservation(stationID, lineID) {
    const url = new URL(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(stationID)}/Arrivals`);
    addAppKey(url, this.config.tflAppKey);

    try {
      const result = await fetchJson(url, this.config, this.fetchImpl);
      if (!Array.isArray(result.value)) {
        return { state: 'contract-error', matchingArrivals: 0, backoffMs: result.backoffMs };
      }

      const contractIsValid = result.value.every((arrival) => {
        return typeof arrival.id === 'string'
          && typeof arrival.lineId === 'string'
          && Number.isInteger(arrival.timeToStation)
          && arrival.timeToStation >= 0;
      });
      const matching = result.value.filter((arrival) => arrival?.lineId === lineID);

      return {
        state: contractIsValid ? (matching.length > 0 ? 'arrivals' : 'empty') : 'contract-error',
        matchingArrivals: contractIsValid ? matching.length : 0,
        backoffMs: result.backoffMs
      };
    } catch (error) {
      return {
        state: error.rateLimited ? 'rate-limited' : 'request-error',
        matchingArrivals: 0,
        backoffMs: error.backoffMs || 0
      };
    }
  }

  applyEvidence(lineID, evidence, observations) {
    const history = this.history.get(lineID) || {
      degraded: false,
      healthyWindows: 0,
      unhealthyWindows: 0
    };

    if (evidence === 'healthy') {
      history.healthyWindows += 1;
      history.unhealthyWindows = 0;
      if (history.degraded && history.healthyWindows >= REQUIRED_HEALTHY_WINDOWS) {
        history.degraded = false;
      }
    } else if (evidence === 'unhealthy') {
      history.unhealthyWindows += 1;
      history.healthyWindows = 0;
      if (history.unhealthyWindows >= REQUIRED_UNHEALTHY_WINDOWS) {
        history.degraded = true;
      }
    } else {
      history.healthyWindows = 0;
      history.unhealthyWindows = 0;
    }

    this.history.set(lineID, history);
    const successfulStations = observations.filter((item) => item.state === 'arrivals').length;

    if (history.degraded) {
      return {
        state: 'degraded',
        reason: evidence === 'healthy'
          ? 'Recovery is being confirmed across another check window.'
          : 'Repeated representative checks could not confirm usable TubeBoard arrival data.',
        sampledStations: observations.length,
        successfulStations
      };
    }

    if (evidence === 'healthy') {
      return {
        state: 'operational',
        reason: 'Representative arrival checks are returning usable data.',
        sampledStations: observations.length,
        successfulStations
      };
    }

    return {
      state: 'unknown',
      reason: evidence === 'unhealthy'
        ? 'A possible data issue is being confirmed across repeated checks.'
        : 'There is not enough evidence to classify TubeBoard arrival data right now.',
      sampledStations: observations.length,
      successfulStations
    };
  }
}

export function renderStatusPage(snapshot, selectedLineID = null) {
  const selectedLine = STATUS_LINES.some((line) => line.id === selectedLineID) ? selectedLineID : null;
  const checkedText = snapshot.checkedAt
    ? new Date(snapshot.checkedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      })
    : 'No completed check yet';
  const notice = snapshot.notice
    ? `<aside class="status-notice" aria-label="Service notice"><strong>TubeBoard notice</strong><p>${escapeHtml(snapshot.notice)}</p></aside>`
    : '';
  const lineRows = snapshot.lines.map((line) => {
    const highlighted = line.id === selectedLine ? ' status-line-selected' : '';
    const current = line.id === selectedLine ? ' aria-current="true"' : '';
    return `<article class="status-line${highlighted}" id="line-${escapeHtml(line.id)}"${current}>
      <header><h2>${escapeHtml(line.name)}</h2><span class="status-badge status-${escapeHtml(line.tubeBoard.state)}">${escapeHtml(displayState(line.tubeBoard.state))}</span></header>
      <dl>
        <div><dt>TubeBoard data</dt><dd>${escapeHtml(line.tubeBoard.reason)}</dd></div>
        <div><dt>Official TfL service</dt><dd><strong>${escapeHtml(line.official.summary)}</strong>${line.official.reason ? ` — ${escapeHtml(line.official.reason)}` : ''}</dd></div>
      </dl>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TubeBoard data status</title>
  <meta name="description" content="Current TubeBoard data checks and official TfL service information for Underground and London Overground lines.">
  <meta name="theme-color" content="#f6f6f3">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://tubeboard.co.uk/status">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/tubeboard-icon-v3-32.png">
  <link rel="stylesheet" href="/styles-20260820.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="TubeBoard home"><img src="/assets/tubeboard-icon-v3-32.png" alt="" width="32" height="32"><span>TubeBoard</span></a>
    <nav aria-label="Primary"><a href="/">Home</a><a href="/support">Support</a><a href="/privacy">Privacy</a></nav>
  </header>
  <main id="main" class="status-page">
    <header class="status-intro">
      <p class="section-context">Data status</p>
      <h1>${escapeHtml(overallHeading(snapshot.state))}</h1>
      <p class="legal-lead">${escapeHtml(snapshot.summary)}</p>
      <p class="status-checked">Last completed check: <time>${escapeHtml(checkedText)}</time></p>
    </header>
    ${notice}
    <section class="status-explainer" aria-labelledby="status-explainer-title">
      <h2 id="status-explainer-title">What this page means</h2>
      <p><strong>TubeBoard data</strong> checks whether representative TfL arrival responses remain usable by the app. <strong>Official TfL service</strong> reports disruption information supplied by TfL. They are different: an official disruption is not automatically a TubeBoard data fault.</p>
      <p>One empty response never declares a line outage. Unknown means the checker is stale, unavailable, outside its evidence window, or still confirming a possible issue.</p>
    </section>
    <section class="status-lines" aria-label="Supported line status">${lineRows}</section>
    <section class="status-actions" aria-labelledby="status-actions-title">
      <h2 id="status-actions-title">Still seeing a problem?</h2>
      <p>Return to TubeBoard and try the board again. Compare with station information before travelling. If the problem continues, <a href="mailto:support@tubeboard.co.uk">email TubeBoard support</a> with the line, station, approximate time, app version and a screenshot if useful.</p>
    </section>
  </main>
  <footer class="site-footer"><div class="footer-brand"><strong>TubeBoard</strong><p>Live London Tube departures.</p></div><nav aria-label="Footer"><a href="/">Home</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="https://apps.apple.com/gb/app/tubeboard-live-departures/id6779771046">App Store</a></nav><div class="footer-legal"><p>Powered by TfL Open Data. TubeBoard is independent and is not affiliated with, endorsed by or sponsored by Transport for London.</p><p>© 2026 TubeBoard.</p></div></footer>
</body>
</html>`;
}

function classifyEvidence(observations, official, now) {
  if (observations.some((item) => item.state === 'arrivals')) {
    return 'healthy';
  }

  const allEmpty = observations.length > 0 && observations.every((item) => item.state === 'empty');
  if (allEmpty && (official.state === 'disrupted' || !isExpectedServiceWindow(now))) {
    return 'inconclusive';
  }

  const corroboratingFailures = observations.filter((item) => item.state !== 'arrivals').length >= 2;
  return corroboratingFailures ? 'unhealthy' : 'inconclusive';
}

export function isExpectedServiceWindow(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 6 * 60 + 30 || totalMinutes <= 30;
}

function createUnknownSnapshot(now, config, reason = null) {
  const enabled = config.enabled;
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: 'unknown',
    summary: reason || (enabled
      ? 'TubeBoard is waiting for enough current evidence to report data health.'
      : 'TubeBoard data monitoring is temporarily unavailable.'),
    checkedAt: null,
    staleAt: null,
    notice: config.notice,
    checker: {
      state: enabled ? 'starting' : 'disabled',
      intervalSeconds: Math.round(config.intervalMs / 1000),
      requestBudgetPerCycle: STATUS_REQUEST_BUDGET_PER_CYCLE,
      scheduledFullSweep: false
    },
    lines: STATUS_LINES.map((line) => ({
      id: line.id,
      name: line.name,
      official: unknownOfficialStatus(),
      tubeBoard: {
        state: 'unknown',
        reason: 'No current TubeBoard data-health evidence is available.',
        sampledStations: 0,
        successfulStations: 0
      }
    }))
  };
}

function markSnapshotStale(snapshot, config) {
  const stale = structuredClone(snapshot);
  stale.state = 'unknown';
  stale.summary = 'The latest TubeBoard data check is too old to describe current conditions.';
  stale.notice = config.notice;
  stale.checker.state = config.enabled ? 'stale' : 'disabled';
  stale.lines = stale.lines.map((line) => ({
    ...line,
    official: unknownOfficialStatus(),
    tubeBoard: {
      ...line.tubeBoard,
      state: 'unknown',
      reason: 'The latest TubeBoard data check is stale.'
    }
  }));
  return stale;
}

function unknownOfficialStatus() {
  return {
    state: 'unknown',
    summary: 'Official TfL status unavailable',
    reason: 'Check TfL or station information before travelling.'
  };
}

async function fetchJson(url, config, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'TubeBoard-Status/1.0 (+https://tubeboard.co.uk/status)' },
      signal: controller.signal
    });
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    if (response.status === 429) {
      const error = new Error('TfL rate limited a status check');
      error.rateLimited = true;
      error.backoffMs = Math.max(DEFAULT_INTERVAL_MS, retryAfterMs || 0);
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`TfL status check failed with HTTP ${response.status}`);
      error.backoffMs = response.status >= 500 ? DEFAULT_INTERVAL_MS : 0;
      throw error;
    }
    return { value: await response.json(), backoffMs: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

function addAppKey(url, appKey) {
  if (appKey) {
    url.searchParams.set('app_key', appKey);
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.min(MAX_BACKOFF_MS, Math.max(0, dateMs - Date.now())) : 0;
}

function overallState(lines) {
  if (lines.some((line) => line.tubeBoard.state === 'degraded')) return 'degraded';
  if (lines.some((line) => line.tubeBoard.state === 'unknown' || line.official.state === 'unknown')) return 'unknown';
  return 'operational';
}

function overallSummary(state) {
  if (state === 'operational') return 'Representative TubeBoard arrival checks are returning usable data across every supported line.';
  if (state === 'degraded') return 'Repeated checks have found a possible TubeBoard arrival-data problem on one or more lines.';
  return 'TubeBoard does not currently have enough fresh evidence to classify every line.';
}

function overallHeading(state) {
  if (state === 'operational') return 'TubeBoard data checks are operational';
  if (state === 'degraded') return 'TubeBoard is investigating degraded data';
  return 'TubeBoard data status is not fully known';
}

function displayState(state) {
  if (state === 'operational') return 'Operational';
  if (state === 'degraded') return 'Degraded';
  return 'Unknown';
}

function safePublicText(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().replace(/\s+/g, ' ').slice(0, 500);
}

function boundedNotice(value) {
  if (typeof value !== 'string') return null;
  const notice = value.trim().replace(/\s+/g, ' ').slice(0, 280);
  return notice || null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 160) : 'Unknown error';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
