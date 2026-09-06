import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// One process owns each file. A mutation becomes visible only after its atomic
// replacement succeeds; a failed operation never poisons the sequencing tail.
export class TransactionalJsonStore {
  #state;
  #normalize;
  #loaded = false;
  #loading = null;
  #transactions = Promise.resolve();

  constructor(filePath, initialState, normalize) {
    this.filePath = filePath;
    this.#state = structuredClone(initialState);
    this.#normalize = normalize;
  }

  get state() {
    return this.snapshot((state) => state);
  }

  // Select before cloning so a per-record read does not copy the whole queue.
  snapshot(select) {
    return structuredClone(select(this.#state));
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#loading) {
      this.#loading = (async () => {
        try {
          const raw = await fs.readFile(this.filePath, 'utf8');
          this.#state = this.#normalize(JSON.parse(raw));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        this.#loaded = true;
      })().finally(() => { this.#loading = null; });
    }
    await this.#loading;
  }

  transaction(mutate) {
    const operation = this.#transactions.then(async () => {
      await this.load();
      const next = structuredClone(this.#state);
      // Domain methods return { changed: false } for a true no-op, and may
      // return a value without publishing references into committed state.
      const result = mutate(next) || {};
      const value = structuredClone(result.value);
      if (result.changed !== false) {
        // Detach newly supplied arrays/objects before yielding to filesystem I/O.
        const committed = structuredClone(next);
        await this.#persist(committed);
        this.#state = committed;
      }
      return value;
    });
    this.#transactions = operation.catch(() => {});
    return operation;
  }

  async #persist(next) {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600
      });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      // Clean even a partially written file. The unique name belongs only to
      // this transaction; never remove the current committed data file.
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
