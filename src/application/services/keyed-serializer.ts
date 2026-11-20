/**
 * In-process FIFO serialisation per key (wallet id).
 *
 * This is a bulkhead, NOT a correctness mechanism: the guarantee is the
 * PostgreSQL row lock, which also covers other instances. Without it, N
 * concurrent requests for one hot wallet would hold N pool connections
 * while they wait on the same row lock, starving every other wallet served
 * by this instance. With it, each instance keeps at most one connection
 * waiting per wallet.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  get activeKeys(): number {
    return this.tails.size;
  }
}
