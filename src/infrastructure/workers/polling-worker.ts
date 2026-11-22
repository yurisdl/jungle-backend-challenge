import type { AppLogger } from '../../application/ports';
import { errorFields } from '../observability/logger';

/** Waits `ms`, or less if `signal` aborts. Leaves no listener behind either way. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Loop skeleton for background workers: runs `tick` until stopped, sleeps
 * when there was nothing to do, survives errors with a pause.
 * `stop()` waits for the current tick to finish (graceful shutdown).
 */
export abstract class PollingWorker {
  private running = false;
  private loop?: Promise<void>;
  private readonly abort = new AbortController();

  protected constructor(
    protected readonly name: string,
    protected readonly logger: AppLogger,
    private readonly idleDelayMs: number,
  ) {}

  /** Returns the amount of work done; 0 ⇒ sleep before the next tick. */
  protected abstract tick(): Promise<number>;

  get isRunning(): boolean {
    return this.running;
  }

  protected get stopSignal(): AbortSignal {
    return this.abort.signal;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const done = await this.tick();
        if (done === 0 && this.running) await sleep(this.idleDelayMs, this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ worker: this.name, ...errorFields(error) }, 'worker tick failed');
        await sleep(Math.max(this.idleDelayMs, 1_000), this.abort.signal);
      }
    }
  }
}
