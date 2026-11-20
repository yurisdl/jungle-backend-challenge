import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively (UTF-16 code unit order),
 * no whitespace, `undefined` members dropped, arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Business fields that identify a wager request. Transport metadata never enters the hash. */
export interface WagerHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** already normalised to 2 decimal places */
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** payloadHash = SHA-256 (hex) of the canonical JSON of the business fields. */
export function wagerPayloadHash(input: WagerHashInput): string {
  const subset: WagerHashInput = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId || undefined,
  };
  return sha256Hex(canonicalJson(subset));
}
