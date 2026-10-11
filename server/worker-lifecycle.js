// Notification workers preserve their existing cadence while coalescing all
// triggers during a cycle into at most one follow-up run.
export class SerialWorker {
  #active = null;
  #controller = null;
  #pending = false;
  #pendingCacheOnly = true;
  #stopped = false;
  #started = false;
  #timers = new Map();
  #running = 0;
  #maximum = 0;
  #cyclesStarted = 0;
  #cyclesCompleted = 0;
  #aborted = 0;

  constructor({ run, intervalMs, initialDelayMs, onError = () => {}, onObserve = null, schedule = setTimeout, cancel = clearTimeout }) {
    this.run = run;
    this.intervalMs = intervalMs;
    this.initialDelayMs = initialDelayMs;
    this.onError = onError;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onObserve = onObserve;
  }

  start() {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#observe('started');
    this.#schedule('initial', this.initialDelayMs, () => this.trigger());
    this.#scheduleInterval();
  }

  trigger({ cacheOnly = false } = {}) {
    if (this.#stopped) return Promise.resolve();
    this.#pending = true;
    this.#pendingCacheOnly &&= cacheOnly;
    if (this.#active) { this.#observe('pending'); return this.#active; }
    this.#active = Promise.resolve().then(async () => {
      while (this.#pending && !this.#stopped) {
        this.#pending = false;
        const cacheOnly = this.#pendingCacheOnly;
        this.#pendingCacheOnly = true;
        this.#controller = new AbortController();
        this.#maximum = Math.max(this.#maximum, ++this.#running);
        this.#cyclesStarted += 1; this.#observe('cycle-start');
        try {
          await this.run(this.#controller.signal, { cacheOnly });
        } catch (error) {
          if (!this.#stopped) this.onError(error);
        } finally {
          if (this.#controller.signal.aborted) this.#aborted += 1;
          this.#running -= 1; this.#cyclesCompleted += 1;
          this.#controller = null;
          this.#observe('cycle-complete');
        }
      }
    }).finally(() => {
      this.#active = null;
      this.#observe('idle');
      // A trigger can arrive between the last run settling and this cleanup.
      if (this.#pending && !this.#stopped) return this.trigger({ cacheOnly: this.#pendingCacheOnly });
    });
    return this.#active;
  }

  scheduleRerun(key, delayMs, options = {}) {
    const timerKey = `rollover:${key}`;
    this.#clear(timerKey);
    if (delayMs !== null) this.#schedule(timerKey, delayMs, () => this.trigger(options));
  }

  async stop() {
    this.#stopped = true;
    this.#pending = false;
    for (const key of this.#timers.keys()) this.#clear(key);
    this.#controller?.abort(new DOMException('Worker stopped', 'AbortError'));
    this.#observe('stop');
    await this.#active;
  }

  #scheduleInterval() {
    this.#schedule('interval', this.intervalMs, () => {
      this.#scheduleInterval();
      return this.trigger();
    });
  }

  #schedule(key, delayMs, callback) {
    if (this.#stopped) return;
    this.#clear(key);
    const timer = this.schedule(() => {
      this.#timers.delete(key);
      this.#observe('timer');
      void callback();
    }, delayMs);
    this.#timers.set(key, timer);
    timer?.unref?.();
    this.#observe('timer');
  }

  #clear(key) {
    const timer = this.#timers.get(key);
    if (timer !== undefined) this.cancel(timer);
    this.#timers.delete(key);
    if (timer !== undefined) this.#observe('timer');
  }

  #observe(event) {
    if (!this.onObserve) return;
    try {
      const result = this.onObserve(event, { running: this.#running, maximum: this.#maximum,
        cyclesStarted: this.#cyclesStarted, cyclesCompleted: this.#cyclesCompleted, aborted: this.#aborted,
        timers: this.#timers.size, active: this.#active !== null, pending: this.#pending,
        stopped: this.#stopped, started: this.#started,
        cancellationRequested: this.#controller?.signal.aborted === true });
      if (result?.then) void Promise.resolve(result).catch(() => {});
    } catch { /* Observation cannot own worker errors or progress. */ }
  }
}
