import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { sleep } from '../../src/infrastructure/workers/polling-worker';

describe('sleep', () => {
  test('idle ticks leave no abort listener behind', async () => {
    const abort = new AbortController();
    for (let i = 0; i < 50; i++) await sleep(1, abort.signal);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  test('aborting wakes it up early', async () => {
    const abort = new AbortController();
    const started = performance.now();
    const pending = sleep(10_000, abort.signal);
    abort.abort();
    await pending;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  test('an already aborted signal returns at once', async () => {
    const abort = new AbortController();
    abort.abort();
    const started = performance.now();
    await sleep(10_000, abort.signal);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
