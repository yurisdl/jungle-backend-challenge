import fc from 'fast-check';

/**
 * Generators for random wager histories. An operation may reference an
 * earlier or a later operation of the same history (out-of-order delivery),
 * or an id that never arrives (a "ghost").
 */
export interface GeneratedOp {
  index: number;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  /** index of the referenced op, -1 for a ghost, undefined for none */
  ref?: number;
  /** when set, the amount is copied from the reference (a well-formed reversal) */
  matchRefAmount: boolean;
  round: 'r1' | 'r2';
}

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 99 }))
  .map(([units, cents]) => `${units}.${String(cents).padStart(2, '0')}`)
  .filter((a) => a !== '0.00');

const opArb = (index: number, size: number): fc.Arbitrary<GeneratedOp> =>
  fc
    .record({
      kind: fc.constantFrom('BET', 'BET', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK') as fc.Arbitrary<GeneratedOp['kind']>,
      amount: amountArb,
      refPick: fc.integer({ min: -1, max: size - 1 }),
      matchRefAmount: fc.boolean(),
      round: fc.constantFrom('r1', 'r1', 'r1', 'r2') as fc.Arbitrary<'r1' | 'r2'>,
      withOptionalRef: fc.boolean(),
    })
    .map(({ kind, amount, refPick, matchRefAmount, round, withOptionalRef }) => {
      const needsRef = kind === 'REFUND' || kind === 'ROLLBACK';
      const mayRef = kind === 'WIN' || kind === 'LOSS';
      const ref = needsRef || (mayRef && withOptionalRef) ? (refPick === index ? -1 : refPick) : undefined;
      return { index, kind, amount: kind === 'LOSS' && !matchRefAmount ? '0.00' : amount, ref, matchRefAmount, round };
    });

export const historyArb = (minSize: number, maxSize: number) =>
  fc.integer({ min: minSize, max: maxSize }).chain((size) =>
    fc.tuple(...Array.from({ length: size }, (_, i) => opArb(i, size))).map((ops) => resolveAmounts(ops)),
  );

/** Reversals that "match" copy the amount of their reference so that they can succeed. */
function resolveAmounts(ops: GeneratedOp[]): GeneratedOp[] {
  return ops.map((op) => {
    if (op.ref !== undefined && op.ref >= 0 && op.matchRefAmount && (op.kind === 'REFUND' || op.kind === 'ROLLBACK')) {
      const target = ops[op.ref]!;
      return { ...op, amount: target.amount === '0.00' ? '1.00' : target.amount };
    }
    return op;
  });
}

/** A delivery plan: every op at least once, some duplicated, in random order. */
export const deliveryArb = (size: number) =>
  fc
    .subarray(Array.from({ length: size }, (_, i) => i))
    .chain((dups) => {
      const all = [...Array.from({ length: size }, (_, i) => i), ...dups];
      return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length });
    });
