import { promises as fs } from 'node:fs';
import path from 'node:path';

const EMPTY_STATE = Object.freeze({ version: 1, artifacts: {} });

function clone(value) {
  return structuredClone(value);
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 ||
      !value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) {
    throw new Error('Reference receiver state is invalid');
  }
  return { version: 1, artifacts: { ...value.artifacts } };
}

/** Small JSON store with serialized atomic rewrites; sufficient for the reference receiver. */
export class ReferenceReceiverStateStore {
  #statePath;
  #state = clone(EMPTY_STATE);
  #queue = Promise.resolve();

  constructor(statePath) {
    this.#statePath = statePath;
  }

  async open() {
    await fs.mkdir(path.dirname(this.#statePath), { recursive: true });
    try {
      this.#state = normalizeState(JSON.parse(await fs.readFile(this.#statePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
  }

  async read(reader) {
    await this.#queue;
    return reader(clone(this.#state));
  }

  transaction(mutator) {
    const run = this.#queue.then(async () => {
      const draft = clone(this.#state);
      const result = await mutator(draft);
      this.#state = normalizeState(draft);
      await this.#persist();
      return result;
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #persist() {
    const temp = `${this.#statePath}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.#statePath);
  }
}
