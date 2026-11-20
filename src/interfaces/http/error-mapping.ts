import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvariantViolationError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UnknownWalletError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { AppContainer } from '../../container';
import { DomainError } from '../../domain';
import { errorFields } from '../../infrastructure/observability/logger';

/**
 * One status per situation, identical on every endpoint:
 *
 * | situation                                   | status |
 * |---------------------------------------------|--------|
 * | invalid payload / header / cursor           | 400    |
 * | resource (path or body wallet) not found    | 404    |
 * | idempotency conflict / duplicate resource   | 409    |
 * | business rejection (persisted, REJECTED)    | 422    |
 * | accepted, pending reference                 | 202    |
 * | transient infrastructure failure            | 503 (+ Retry-After) |
 * | permanent internal failure                  | 500    |
 */
export function statusFor(error: unknown): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof ResourceNotFoundError || error instanceof UnknownWalletError) return 404;
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof WalletAlreadyExistsError
  )
    return 409;
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) return 503;
  if (error instanceof InvariantViolationError) return 500;
  if (error instanceof DomainError) return 400;
  if (error instanceof HttpException) return error.getStatus();
  return 500;
}

export function errorBody(error: unknown, status: number) {
  const retryable = status === 503;
  if (error instanceof ApplicationError || error instanceof DomainError) {
    const details = error instanceof ApplicationError ? error.details : undefined;
    return { error: { code: error.code, message: error.message, retryable, ...(details ? { details } : {}) } };
  }
  if (error instanceof HttpException && status < 500) {
    const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    return { error: { code, message: error.message, retryable: false } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'unexpected error', retryable: false } };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(AppContainer) private readonly container: AppContainer) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const status = statusFor(error);
    if (status === 503) res.setHeader('Retry-After', '1');
    const log = { correlationId: res.getHeader('x-correlation-id'), method: req.method, path: req.route?.path ?? req.path, status, ...errorFields(error) };
    if (status >= 500) this.container.logger.error(log, 'request failed');
    else this.container.logger.info(log, 'request refused');
    res.status(status).json(errorBody(error, status));
  }
}
