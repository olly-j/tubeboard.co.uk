// Notification workers preserve their existing cadence while coalescing all
// triggers during a cycle into at most one follow-up run.
export class SerialWorker {
  #active = null;
  #controller = null;
  #pending = false;
  #stopped = false;
  #started = false;
  #timers = new Map();

  constructor({ run, intervalMs, initialDelayMs, onError = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
    this.run = run;
    this.intervalMs = intervalMs;
    this.initialDelayMs = initialDelayMs;
    this.onError = onError;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  start() {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#schedule('initial', this.initialDelayMs, () => this.trigger());
    this.#scheduleInterval();
  }

  trigger() {
    if (this.#stopped) return Promise.resolve();
    this.#pending = true;
    if (this.#active) return this.#active;
    this.#active = Promise.resolve().then(async () => {
      while (this.#pending && !this.#stopped) {
        this.#pending = false;
        this.#controller = new AbortController();
        try {
          await this.run(this.#controller.signal);
        } catch (error) {
          if (!this.#stopped) this.onError(error);
        } finally {
          this.#controller = null;
        }
      }
    }).finally(() => {
      this.#active = null;
      // A trigger can arrive between the last run settling and this cleanup.
      if (this.#pending && !this.#stopped) return this.trigger();
    });
    return this.#active;
  }

  scheduleRerun(key, delayMs) {
    const timerKey = `rollover:${key}`;
    this.#clear(timerKey);
    if (delayMs !== null) this.#schedule(timerKey, delayMs, () => this.trigger());
  }

  async stop() {
    this.#stopped = true;
    this.#pending = false;
    for (const key of this.#timers.keys()) this.#clear(key);
    this.#controller?.abort(new DOMException('Worker stopped', 'AbortError'));
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
      void callback();
    }, delayMs);
    this.#timers.set(key, timer);
    timer?.unref?.();
  }

  #clear(key) {
    const timer = this.#timers.get(key);
    if (timer !== undefined) this.cancel(timer);
    this.#timers.delete(key);
  }
}
