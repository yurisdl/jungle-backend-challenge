import pino from 'pino';
import type { AppLogger } from '../../application/ports';

/** Fields that must never reach the logs (financial payloads, credentials). */
const REDACT = [
  'money',
  'balance',
  'payload',
  'body',
  'initialBalance',
  'req.headers.authorization',
  'headers.authorization',
  '*.money',
  '*.balance',
  '*.payload',
];

export class PinoAppLogger implements AppLogger {
  private readonly logger: pino.Logger;

  constructor(level: string, base: Record<string, unknown> = {}) {
    this.logger = pino({
      level,
      base: { service: 'wagering-processor', ...base },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT, censor: '[redacted]' },
      formatters: { level: (label) => ({ level: label }) },
    });
  }

  debug(fields: Record<string, unknown>, message: string): void {
    this.logger.debug(fields, message);
  }
  info(fields: Record<string, unknown>, message: string): void {
    this.logger.info(fields, message);
  }
  warn(fields: Record<string, unknown>, message: string): void {
    this.logger.warn(fields, message);
  }
  error(fields: Record<string, unknown>, message: string): void {
    this.logger.error(fields, message);
  }
}

/** Serialises an error for logs without dumping request payloads. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown; reason?: unknown; kind?: unknown };
    return { error: { type: e.name, message: e.message, code: e.code, reason: e.reason, kind: e.kind } };
  }
  return { error: { message: String(error) } };
}
