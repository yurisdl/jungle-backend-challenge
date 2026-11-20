/**
 * Test-only fault injection. Production configs leave FAULT_INJECTION
 * empty, so every call is a no-op. Integration tests use it to kill a
 * process at a precise point (e.g. after the SQL commit, before the SQS ack).
 */
export type FaultPoint = 'crash-after-commit' | 'crash-after-publish' | 'fail-publish';

export class FaultInjector {
  constructor(private readonly points: readonly string[]) {}

  isActive(point: FaultPoint): boolean {
    return this.points.includes(point);
  }

  /** Simulates an abrupt process death (no graceful shutdown, no ack). */
  crashIfActive(point: FaultPoint): void {
    if (this.isActive(point)) {
      process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'fault injected', point })}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
