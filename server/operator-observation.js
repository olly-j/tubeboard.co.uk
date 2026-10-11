import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

const WORKER_EVENTS = new Set(['started', 'pending', 'cycle-start', 'cycle-complete', 'timer', 'stop', 'idle']);
const COUNTS = ['running', 'maximum', 'cyclesStarted', 'cyclesCompleted', 'aborted', 'timers'];
const FLAGS = ['active', 'pending', 'stopped', 'started', 'cancellationRequested'];
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const boolean = (value) => typeof value === 'boolean' ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;

// No loading, purging, transaction, complete record clone, or diagnostic identity export.
export function selectedPresence({ activities, alerts, ownedInstallID, known }) {
  const wireID = ownedInstallID.trim(); // Live Activity validation preserves case.
  const digest = createHash('sha256').update(wireID.toLowerCase()).digest('hex'); // Alerts normalize case.
  const result = { activitiesPresent: null, alertsPresent: null, alertsQueued: null };
  if (known.has('activities')) result.activitiesPresent = activities.snapshot((state) =>
    Array.isArray(state.records) && state.records.length <= 2048
      ? state.records.some((record) => record.installID === wireID) : null);
  if (known.has('alerts')) {
    const selected = alerts.snapshot((state) => ({
      present: Array.isArray(state.records) && state.records.length <= 2048
        ? state.records.some((record) => record.installDigest === digest) : null,
      queued: Array.isArray(state.queue) && state.queue.length <= 2048
        ? state.queue.some((record) => record.installDigest === digest) : null
    }));
    result.alertsPresent = selected.present; result.alertsQueued = selected.queued;
  }
  return result;
}

export async function startOperatorObservation(options = {}) {
  try {
    if (!options.configPath) return null; // No filesystem/socket/timer/store I/O when disabled.
    return await initializeObservation(options);
  } catch { throw new Error('Private operator observation unavailable'); }
}

async function initializeObservation({ configPath, servedRoots = [], selection = () => ({}) }) {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || !path.isAbsolute(configPath)
      || configPath !== path.resolve(configPath) || await fs.realpath(configPath) !== configPath) throw new Error('Invalid private observation configuration');
  const parent = path.dirname(configPath); const parentStat = await fs.lstat(parent);
  if (!Array.isArray(servedRoots) || servedRoots.length > 4) throw new Error('Invalid served roots');
  const actualServedRoots = await Promise.all(servedRoots.map((root) => fs.realpath(root)));
  if (!parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o7777) !== 0o700
      || actualServedRoots.some((root) => inside(parent, root))) throw new Error('Invalid private observation directory');
  const candidate = await fs.lstat(configPath);
  if (!candidate.isFile() || candidate.uid !== uid || (candidate.mode & 0o7777) !== 0o600 || candidate.size > 4096) throw new Error('Invalid private observation file');
  const file = await fs.open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== uid || (before.mode & 0o7777) !== 0o600 || before.size > 4096) throw new Error('Invalid private observation file');
    const buffer = Buffer.alloc(4097); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096 || bytesRead !== before.size) throw new Error('Invalid observation size');
    config = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Observation configuration changed');
  } finally { await file.close(); }
  if (!config || Object.keys(config).sort().join(',') !== 'expiresAt,ownedInstallID'
      || typeof config.ownedInstallID !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.ownedInstallID)
      || typeof config.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.expiresAt)) throw new Error('Invalid observation scope');
  const remaining = Date.parse(config.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 90_000) throw new Error('Invalid observation lease');
  const socketPath = path.join(parent, 'operator-observation.sock');
  try { await fs.lstat(socketPath); throw new Error('Observation collision'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const known = new Set(); const workers = {}; const clients = new Set();
  const http = { accepted: 0, inFlight: 0, finished: 0, aborted: 0, draining: false, drained: false, deadline: false, shutdown: false };
  let closed = false; let ready = false; let connections = 0; let sequence = 0; let bytes = 0; let activitiesPositiveObserved = false; let alertsPositiveObserved = false; let socketIdentity;
  const server = net.createServer((client) => {
    if (closed || !ready || clients.size >= 1 || ++connections > 4) { client.destroy(); return; }
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('data', () => client.destroy()); // No request or business-control protocol.
    publish();
  });
  server.on('error', () => { close(); });
  const timer = setTimeout(() => close(), remaining); timer.unref();
  function close() {
    closed = true; clearTimeout(timer);
    for (const client of clients) client.destroy(); clients.clear();
    if (!server.listening) return;
    server.close(() => {
      void fs.lstat(socketPath).then((current) => {
        if (socketIdentity && current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino)
          return fs.unlink(socketPath);
      }).catch(() => {});
    });
  }
  function publish() {
    if (closed || !clients.size) return;
    try {
      let raw;
      try { raw = selection(config.ownedInstallID, known); if (raw?.then) { void Promise.resolve(raw).catch(() => {}); raw = {}; } }
      catch { raw = {}; }
      const selected = { activitiesKnown: known.has('activities'), alertsKnown: known.has('alerts'),
        activitiesPresent: known.has('activities') ? boolean(raw?.activitiesPresent) : null,
        alertsPresent: known.has('alerts') ? boolean(raw?.alertsPresent) : null,
        alertsQueued: known.has('alerts') ? boolean(raw?.alertsQueued) : null };
      activitiesPositiveObserved ||= selected.activitiesPresent === true;
      alertsPositiveObserved ||= selected.alertsPresent === true;
      const frame = JSON.stringify({ version: 1, sequence: ++sequence, workers, http: { ...http },
        selected: { ...selected, activitiesPositiveObserved, alertsPositiveObserved } }) + '\n';
      bytes += Buffer.byteLength(frame);
      if (sequence > 128 || bytes > 32768 || Buffer.byteLength(frame) > 4096) { close(); return; }
      for (const client of clients) {
        if (client.writableLength > 4096 || !client.write(frame)) client.destroy();
      }
    } catch { close(); } // Observation cannot propagate errors into business work.
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  }).catch((error) => { close(); throw error; });
  try {
    socketIdentity = await fs.lstat(socketPath);
    if (!socketIdentity.isSocket() || socketIdentity.uid !== uid) throw new Error('Private socket unavailable');
    await fs.chmod(socketPath, 0o600); const after = await fs.lstat(socketPath);
    if (closed || Date.now() >= Date.parse(config.expiresAt) || !socketIdentity.isSocket()
        || !after.isSocket() || after.uid !== uid || after.ino !== socketIdentity.ino || after.dev !== socketIdentity.dev
        || (after.mode & 0o7777) !== 0o600) throw new Error('Private socket unavailable');
  } catch (error) { close(); throw error; }
  ready = true;
  server.unref();
  return {
    worker(kind, event, state) {
      try {
        if (closed || !['activities', 'alerts'].includes(kind) || !WORKER_EVENTS.has(event)) return;
        workers[kind] = { event, ...Object.fromEntries(COUNTS.map((key) => [key, count(state[key])])),
          ...Object.fromEntries(FLAGS.map((key) => [key, boolean(state[key])])) }; publish();
      } catch { close(); }
    },
    loaded(kind) { if (!closed && ['activities', 'alerts'].includes(kind)) { known.add(kind); publish(); } },
    http(event) {
      if (closed) return;
      if (event === 'accepted') { http.accepted += 1; http.inFlight += 1; }
      else if (event === 'finished' || event === 'aborted') { http[event] += 1; http.inFlight = Math.max(0, http.inFlight - 1); }
      else if (event === 'shutdown') { http.shutdown = true; http.draining = true; }
      else if (event === 'drained') { http.drained = true; http.draining = false; }
      else if (event === 'deadline') http.deadline = true;
      else return;
      publish();
    },
    close
  };
}
