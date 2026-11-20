import { EXTERNAL_KINDS, InvalidMoneyError, Money, type MoneyProps, WagerTransactionKind } from '../../domain';
import { ValidationError } from '../errors';
import { wagerPayloadHash } from './payload-hash';

export interface WagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TEXT = /^[A-Za-z0-9._:\-]{1,128}$/;

type Issues = Record<string, string>;

function text(raw: Record<string, unknown>, field: string, issues: Issues, pattern = ID_TEXT): string {
  const value = raw[field];
  if (typeof value !== 'string' || !pattern.test(value)) {
    issues[field] = pattern === UUID ? 'must be a UUID' : 'must be a non-empty identifier (max 128 chars, [A-Za-z0-9._:-])';
    return '';
  }
  return value;
}

/**
 * Validates and normalises a wager request. Shared by the HTTP controller
 * and the SQS consumer, so both entry points accept exactly the same
 * contract and compute the same payload hash.
 */
export function parseWagerCommand(raw: unknown, idempotencyKey: unknown): WagerCommand {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new ValidationError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }
  if (idempotencyKey.length > 256) {
    throw new ValidationError('INVALID_PAYLOAD', 'Idempotency-Key is longer than 256 characters');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('INVALID_PAYLOAD', 'body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const issues: Issues = {};

  const providerId = text(body, 'providerId', issues);
  const externalTransactionId = text(body, 'externalTransactionId', issues);
  const playerId = text(body, 'playerId', issues, UUID);
  const walletId = text(body, 'walletId', issues, UUID);
  const roundId = text(body, 'roundId', issues);
  const gameId = text(body, 'gameId', issues);

  let kind = body.kind as WagerTransactionKind;
  if (kind === WagerTransactionKind.Opening) {
    throw new ValidationError('KIND_NOT_ALLOWED', 'OPENING is an internal transaction kind');
  }
  if (!EXTERNAL_KINDS.includes(kind)) {
    issues.kind = `must be one of ${EXTERNAL_KINDS.join(', ')}`;
    kind = WagerTransactionKind.Bet;
  }

  let money: MoneyProps = { amount: '0.00', currency: 'XXX' };
  try {
    const m = body.money as MoneyProps;
    money = Money.from(m).toJSON();
  } catch (err) {
    issues.money = err instanceof InvalidMoneyError ? err.message : 'invalid money';
  }

  let reference: string | undefined;
  if (body.referenceExternalTransactionId !== undefined && body.referenceExternalTransactionId !== null) {
    reference = text(body, 'referenceExternalTransactionId', issues);
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    issues.referenceExternalTransactionId = `required for ${kind}`;
  }
  if (kind === WagerTransactionKind.Bet && reference) {
    issues.referenceExternalTransactionId = 'BET cannot reference another transaction';
  }
  if (reference && reference === externalTransactionId) {
    issues.referenceExternalTransactionId = 'a transaction cannot reference itself';
  }
  if (!issues.money && kind !== WagerTransactionKind.Loss && Money.from(money).isZero()) {
    issues.money = `${kind} amount must be greater than zero`;
  }

  if (Object.keys(issues).length > 0) {
    throw new ValidationError('INVALID_PAYLOAD', 'invalid wager transaction payload', { issues });
  }

  return {
    idempotencyKey,
    providerId,
    externalTransactionId,
    playerId: playerId.toLowerCase(),
    walletId: walletId.toLowerCase(),
    roundId,
    gameId,
    kind,
    money,
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}

export function hashOf(command: WagerCommand): string {
  return wagerPayloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}
