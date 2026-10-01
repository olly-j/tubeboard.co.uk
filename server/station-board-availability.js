// Original source authority and planned eligibility are independent. Expired
// announcements never become fresh closure evidence or renew a row's clock.
const row = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const scopeName = (source) => source === 'service' ? 'lineStatus' : source === 'station' ? 'stationDisruptions' : source;
const windows = (p) => p.closureWindows ?? (Number.isFinite(p.validFrom) && Number.isFinite(p.validUntil) ? [{ validFrom: p.validFrom, validUntil: p.validUntil }] : []);
export const eligibilityCutoff = (p) => p.expiresAt + 600000;
export function validAvailability(p, record) {
  if (!row(p) || p.stationID !== record.stationID || p.lineID !== record.lineID || !['lineStatus', 'stationDisruptions'].includes(p.sourceScope) || typeof p.closed !== 'boolean' || !Number.isFinite(p.observedAt) || !Number.isFinite(p.expiresAt) || p.expiresAt <= p.observedAt || p.expiresAt > p.observedAt + 120000 || (p.plannedUnavailable !== undefined && typeof p.plannedUnavailable !== 'boolean')) return false;
  if (p.closureWindows !== undefined && (!Array.isArray(p.closureWindows) || p.closureWindows.length > 32 || p.closureWindows.some((w) => !row(w) || !Number.isFinite(w.validFrom) || !Number.isFinite(w.validUntil) || w.validFrom >= w.validUntil))) return false;
  if ((p.validFrom !== undefined && p.validFrom !== null || p.validUntil !== undefined && p.validUntil !== null) && (!Number.isFinite(p.validFrom) || !Number.isFinite(p.validUntil) || p.validFrom >= p.validUntil)) return false;
  const w = windows(p);
  return !p.closed || Array.isArray(w) && w.length > 0 && w.length <= 32 && w.every((v) => row(v) && Number.isFinite(v.validFrom) && Number.isFinite(v.validUntil) && v.validFrom < v.validUntil && v.validFrom < eligibilityCutoff(p) && v.validUntil > p.observedAt) && p.expiresAt <= Math.max(...w.map((v) => v.validUntil));
}
export const qualifiedAvailability = (p, now) => p.observedAt <= now && now < p.observedAt + 600000;
export const retainedEligibility = (p, now) => p.observedAt <= now && now < eligibilityCutoff(p) && (p.plannedUnavailable === true || p.closed && windows(p).some((w) => w.validFrom < eligibilityCutoff(p) && w.validUntil > p.expiresAt));
export const activeClosure = (p, now) => qualifiedAvailability(p, now) && p.closed && now < p.expiresAt && windows(p).some((w) => w.validFrom <= now && now < w.validUntil);
export const expiredBarrier = (p, now) => retainedEligibility(p, now) && now >= p.expiresAt && (p.plannedUnavailable === true || p.closed && windows(p).some((w) => w.validFrom <= now && w.validUntil > p.expiresAt));
export const blocksScheduled = (p, time, now) => activeClosure(p, now) || expiredBarrier(p, now) || p.plannedUnavailable === true && qualifiedAvailability(p, now) && now < p.expiresAt || ((qualifiedAvailability(p, now) && now < p.expiresAt) || retainedEligibility(p, now)) && p.closed && Number.isFinite(time) && windows(p).some((w) => w.validFrom <= time && time < w.validUntil);
function originalProofs(cache) {
  const all = [...(cache?.availabilityProofs || [])];
  for (const [source, check] of Object.entries(cache?.closureSources || {})) {
    if (!row(check)) continue;
    const p = { ...check, sourceScope: check.sourceScope || scopeName(source) };
    // Old server caches used a single current check without explicit windows.
    if (p.closed && !p.closureWindows && !Number.isFinite(p.validFrom)) { p.validFrom = p.observedAt; p.validUntil = p.expiresAt; }
    all.push(p);
  }
  return all;
}
export function retainAvailability(previous, incoming, record, now) {
  const unique = new Map(originalProofs(previous).concat(originalProofs(incoming)).filter((p) => validAvailability(p, record) && (qualifiedAvailability(p, now) || retainedEligibility(p, now))).map((p) => [JSON.stringify([p.stationID, p.lineID, p.sourceScope, p.closed, p.observedAt, p.expiresAt, windows(p).map((w) => [w.validFrom, w.validUntil]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), p.plannedUnavailable === true]), p]));
  const result = [];
  for (const scope of ['lineStatus', 'stationDisruptions']) {
    const group = [...unique.values()].filter((p) => p.sourceScope === scope), fresh = group.filter((p) => qualifiedAvailability(p, now) && p.expiresAt > now);
    const latest = Math.max(...fresh.map((p) => p.observedAt));
    const candidates = fresh.filter((p) => p.observedAt === latest), restrictive = candidates.filter((p) => p.closed || p.plannedUnavailable === true);
    const current = restrictive.length ? restrictive : candidates.sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 1);
    let protectedProofs = group.filter((p) => retainedEligibility(p, now) && p.expiresAt <= now && p.observedAt >= latest);
    const active = protectedProofs.filter((p) => expiredBarrier(p, now)).sort((a, b) => eligibilityCutoff(b) - eligibilityCutoff(a) || b.observedAt - a.observedAt);
    if (active.length) protectedProofs = protectedProofs.filter((p) => !expiredBarrier(p, now) || p === active[0]);
    let selected = [...protectedProofs, ...current];
    if (!selected.length && group.length) selected = group.sort((a, b) => b.observedAt - a.observedAt || Number(b.plannedUnavailable === true) - Number(a.plannedUnavailable === true) || Number(b.closed) - Number(a.closed) || b.expiresAt - a.expiresAt).slice(0, 1);
    result.push(...selected);
  }
  if (result.length > 8) {
    const bounded = [];
    for (const scope of ['lineStatus', 'stationDisruptions']) {
      const group = result.filter((p) => p.sourceScope === scope);
      if (group.length <= 1) bounded.push(...group);
      else {
        const original = group.sort((a, b) => eligibilityCutoff(b) - eligibilityCutoff(a))[0];
        bounded.push({ stationID: original.stationID, lineID: original.lineID, sourceScope: scope, closed: false, observedAt: original.observedAt, expiresAt: original.expiresAt, plannedUnavailable: true });
      }
    }
    return bounded;
  }
  return result.sort((a, b) => a.sourceScope.localeCompare(b.sourceScope) || a.observedAt - b.observedAt || Number(a.plannedUnavailable === true) - Number(b.plannedUnavailable === true) || Number(a.closed) - Number(b.closed) || a.expiresAt - b.expiresAt);
}
export function legacyClosureSources(proofs) {
  const result = {};
  for (const p of proofs) { const scope = p.sourceScope === 'lineStatus' ? 'service' : 'station'; if (!result[scope] || p.observedAt >= result[scope].observedAt) result[scope] = p; }
  return result;
}
export function availabilityBoundaries(proofs, now) {
  return proofs.flatMap((p) => {
    if (!p.closed && p.plannedUnavailable !== true) return [];
    return [p.expiresAt, eligibilityCutoff(p), ...windows(p).flatMap((w) => [Math.max(w.validFrom, p.observedAt), Math.min(w.validUntil, p.expiresAt)])].filter((at) => at > now && at <= eligibilityCutoff(p));
  });
}
export function knownNonClosure(detail) {
  return typeof detail?.statusSeverityDescription === 'string' && ({ 10: 'good service', 9: 'minor delays', 6: 'severe delays', 7: 'reduced service' })[detail.statusSeverity] === detail.statusSeverityDescription.trim().toLowerCase();
}
export function qualifyAvailability(values, record, scope, observation, now, clock) {
  if (!observation || observation.expiresAt <= now || !Array.isArray(values)) return [];
  let periods = [], open = false;
  if (scope === 'lineStatus') {
    if (values.length !== 1 || values[0]?.id !== record.lineID || !Array.isArray(values[0].lineStatuses) || !values[0].lineStatuses.length) return [];
    const details = values[0].lineStatuses;
    for (const d of details) {
      if (![1, 2, 16].includes(d?.statusSeverity) || !['closed', 'suspended', 'not running'].includes(String(d.statusSeverityDescription || '').trim().toLowerCase())) continue;
      if (d.disruption?.affectedRoutes !== undefined && (!Array.isArray(d.disruption.affectedRoutes) || d.disruption.affectedRoutes.length)) continue;
      periods.push(...(Array.isArray(d.validityPeriods) ? d.validityPeriods.map((v) => ({ ...v, ...(d.concernedLines !== undefined ? { concernedLines: d.concernedLines } : {}) })) : []));
    }
    open = details.every(knownNonClosure);
  } else {
    periods = values.filter((d) => row(d) && (d.stationAtcoCode || d.atcoCode) === record.stationID && ['stationclosure', 'stopclosed', 'closed', 'closure'].includes(String(d.type || '').trim().toLowerCase()));
    open = values.length === 0;
  }
  const qualified = periods.flatMap((p) => {
    if (p.concernedLines !== undefined && (!Array.isArray(p.concernedLines) || !p.concernedLines.some((v) => v?.id === record.lineID && (v.direction === undefined || typeof v.direction === 'string' && !v.direction.trim())))) return [];
    const validFrom = clock(p.fromDate), validUntil = clock(p.toDate);
    return Number.isFinite(validFrom) && Number.isFinite(validUntil) && validFrom < validUntil && validFrom < observation.expiresAt + 600000 && now < validUntil ? [{ validFrom, validUntil }] : [];
  }).sort((a, b) => a.validFrom - b.validFrom);
  const base = { stationID: record.stationID, lineID: record.lineID, sourceScope: scope, ...observation, qualificationOrigin: 'server' };
  if (qualified.length > 32) return [{ ...base, closed: false, plannedUnavailable: true }];
  if (qualified.length) return [{ ...base, closed: true, validFrom: Math.min(...qualified.map((w) => w.validFrom)), validUntil: Math.max(...qualified.map((w) => w.validUntil)), closureWindows: qualified, expiresAt: Math.min(observation.expiresAt, Math.max(...qualified.map((w) => w.validUntil))) }];
  return open ? [{ ...base, closed: false }] : [];
}
export const wireAvailability = (proofs, toSwift) => proofs.map((p) => ({ stationID: p.stationID, lineID: p.lineID, sourceScope: p.sourceScope, closed: p.closed, observedAt: toSwift(p.observedAt), expiresAt: toSwift(p.expiresAt), ...(p.validFrom != null ? { validFrom: toSwift(p.validFrom), validUntil: toSwift(p.validUntil) } : {}), ...(p.closureWindows ? { closureWindows: p.closureWindows.map((w) => ({ validFrom: toSwift(w.validFrom), validUntil: toSwift(w.validUntil) })) } : {}), ...(p.plannedUnavailable === true ? { plannedUnavailable: true } : {}) }));
