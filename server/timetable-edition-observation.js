import { randomUUID } from 'node:crypto';
import { TIMETABLE_PUBLICATION_URL } from './station-board-seed.js';
import { timetableHTTPObservation } from './station-board-timetable.js';

export const OBSERVATION_PATH = '/api/timetable-publication-observation/v1';

export class TimetableEditionObservation {
  #last = null;
  #valid = false;

  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async refresh(signal) {
    try {
      const url = new URL(TIMETABLE_PUBLICATION_URL);
      url.searchParams.set('tb085', randomUUID());
      const options = { method: 'HEAD', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        headers: { 'User-Agent': 'TubeBoard timetable service', 'Cache-Control': 'no-cache' } };
      let response = await this.fetchImpl(url, options);
      if (response.status === 200 && !response.headers.has('age')) response = await this.fetchImpl(url, options);
      const sha = response.headers.get('x-amz-meta-sha256');
      const clock = timetableHTTPObservation({ date: response.headers.get('date'), age: response.headers.get('age') },
        this.now(), { official: true });
      if (response.status !== 200 || !clock || sha?.length !== 64 || !/^[a-f0-9]{64}$/.test(sha)) {
        throw new Error('Publication edition unavailable');
      }
      if (this.#last && clock.observedAt <= this.#last.observedAt &&
          (clock.observedAt !== this.#last.observedAt || sha !== this.#last.sha || !this.#valid)) {
        throw new Error('Publication observation clock conflict');
      }
      this.#last = { ...clock, sha };
      this.#valid = true;
    } catch (error) {
      this.#valid = false;
      throw error;
    }
  }

  current() {
    const now = this.now();
    if (!this.#valid || now < this.#last.observedAt || now >= this.#last.expiresAt) return null;
    return { schemaVersion: 1, source: TIMETABLE_PUBLICATION_URL, publicationSHA256: this.#last.sha,
      observedAt: new Date(this.#last.observedAt).toISOString(), expiresAt: new Date(this.#last.expiresAt).toISOString() };
  }
}

export function handleEditionObservation(request, response, url, observation, sendJson) {
  if (url.pathname !== OBSERVATION_PATH) return false;
  const head = request.method === 'HEAD';
  if (request.url !== OBSERVATION_PATH) {
    sendJson(response, 400, { error: 'Unexpected request target' }, 'no-store', head);
  } else if (!head && request.method !== 'GET') {
    response.setHeader('allow', 'GET, HEAD');
    sendJson(response, 405, { error: 'Method not allowed' }, 'no-store');
  } else {
    const body = observation.current();
    sendJson(response, body ? 200 : 503, body ?? { error: 'Publication edition unavailable' }, 'no-store', head);
  }
  return true;
}
