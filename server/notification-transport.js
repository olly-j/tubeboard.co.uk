import http2 from 'node:http2';

// Absolute per-request bounds include connection, headers and the whole body.
// Fifteen seconds leaves room within the existing 60/90-second worker cadence;
// timed-out work follows the existing retry policy rather than adding fan-out.
export const NOTIFICATION_REQUEST_TIMEOUT_MS = 15_000;

function transportError(message) {
  return Object.assign(new Error(message), { retryable: true, backoffMs: 120_000 });
}

async function withDeadline(operation, {
  signal,
  timeoutMs = NOTIFICATION_REQUEST_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  let rejectAbort;
  const cancelled = new Promise((resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const timer = schedule(() => controller.abort(transportError('Notification request deadline exceeded')), timeoutMs);
  timer?.unref?.();
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      cancelled
    ]);
  } finally {
    cancel(timer);
    signal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export function fetchJsonResponse(url, fetchImpl = fetch, options = {}) {
  return withDeadline(async (signal) => {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      // Non-success bodies are not used; release the connection promptly.
      if (response.body?.cancel) void response.body.cancel().catch(() => {});
      return { ok: false, status: response.status, value: null };
    }
    const value = await response.json();
    signal.throwIfAborted();
    return { ok: true, status: response.status, value };
  }, options);
}

export function sendApnsRequest(host, headers, payload, { connect = http2.connect, ...options } = {}) {
  return withDeadline((signal) => new Promise((resolve, reject) => {
    let client;
    let request;
    let finished = false;
    let status = 0;
    let body = '';
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', aborted);
      // Each APNs session belongs to exactly one request. Destroy it on every
      // completion path, including failed connection and incomplete response.
      request?.destroy();
      client?.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const aborted = () => finish(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      signal.throwIfAborted();
      client = connect(`https://${host}`);
      client.on('error', () => finish(transportError('APNs connection failed')));
      client.on('close', () => finish(transportError('APNs connection closed before completion')));
      request = client.request(headers);
      request.setEncoding('utf8');
      request.on('response', (responseHeaders) => { status = Number(responseHeaders[':status'] || 0); });
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => finish(null, { status, body }));
      request.on('error', () => finish(transportError('APNs request failed')));
      request.on('aborted', () => finish(transportError('APNs response aborted')));
      request.on('close', () => finish(transportError('APNs response closed before completion')));
      request.end(JSON.stringify(payload));
    } catch (error) {
      finish(error);
    }
  }), options);
}
