import {
  Body,
  type CanActivate,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseWagerCommand } from '../../application/services/wager-command';
import { AppContainer } from '../../container';
import { WagerTransactionStatus } from '../../domain';

/**
 * Authentication extension point (see ARCHITECTURE.md §Authentication).
 * Deliberately a no-op: the intended design validates an OIDC
 * client-credentials JWT issued by Keycloak per provider and checks that
 * `providerId` in the body matches the token's `azp`/client claim.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

export function correlationIdOf(req: Request): string {
  return (req.res?.getHeader('x-correlation-id') as string | undefined) ?? 'unknown';
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(@Inject(AppContainer) private readonly c: AppContainer) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Request) {
    return this.c.createWallet.execute(body, correlationIdOf(req));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.c.walletQueries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.c.walletQueries.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Req() req: Request) {
    return this.c.walletQueries.reconcile(walletId, correlationIdOf(req));
  }
}

const STATUS_BY_OUTCOME: Record<string, (replay: boolean) => number> = {
  [WagerTransactionStatus.Processed]: (replay) => (replay ? 200 : 201),
  [WagerTransactionStatus.PendingReference]: () => 202,
  [WagerTransactionStatus.Rejected]: () => 422,
  [WagerTransactionStatus.Failed]: () => 500,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(@Inject(AppContainer) private readonly c: AppContainer) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseWagerCommand(body, idempotencyKey);
    const result = await this.c.submitWager.execute(command, { source: 'http', correlationId: correlationIdOf(req) });
    if (result.type !== 'result') throw new Error('unreachable: HTTP requests have no inbox');
    const view = result.view;
    res.status(STATUS_BY_OUTCOME[view.status]?.(view.idempotentReplay) ?? 200);
    if (view.idempotentReplay) res.setHeader('Idempotent-Replay', 'true');
    return view;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.c.transactionQueries.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.c.transactionQueries.byExternalId(providerId, externalTransactionId);
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Health endpoints are public by design (no guard). */
@Controller()
export class OperationsController {
  constructor(@Inject(AppContainer) private readonly c: AppContainer) {}

  @Get('health/live')
  live() {
    return { status: 'up', instanceId: this.c.config.instanceId };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await withTimeout(fn(), 2_000);
        return 'up' as const;
      } catch {
        return 'down' as const;
      }
    };
    const [postgres, sqs] = await Promise.all([
      check(() => this.c.orm.em.fork({ useContext: false }).execute('select 1')),
      check(() => this.c.queues.ping()),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'up' : 'down', checks: { postgres, sqs } };
  }

  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', this.c.metrics.registry.contentType);
    res.send(await this.c.metrics.registry.metrics());
  }
}
