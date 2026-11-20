import 'reflect-metadata';
import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppContainer } from './container';
import type { AppConfig } from './infrastructure/config/app-config';
import { errorFields } from './infrastructure/observability/logger';
import { OperationsController, ProviderAuthGuard, WageringController, WalletsController } from './interfaces/http/controllers';
import { HttpErrorFilter } from './interfaces/http/error-mapping';

const CORRELATION = /^[A-Za-z0-9._:\-]{1,128}$/;

function buildModule(container: AppContainer) {
  @Module({
    controllers: [WalletsController, WageringController, OperationsController],
    providers: [
      { provide: AppContainer, useValue: container },
      ProviderAuthGuard,
      { provide: APP_FILTER, useClass: HttpErrorFilter },
    ],
  })
  class HttpModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer
        .apply((req: Request, res: Response, next: NextFunction) => {
          const incoming = req.header('x-correlation-id');
          const correlationId = incoming && CORRELATION.test(incoming) ? incoming : container.ids.next();
          res.setHeader('x-correlation-id', correlationId);
          next();
        })
        .forRoutes('*');
    }
  }
  return HttpModule;
}

export interface RunningApp {
  container: AppContainer;
  http?: INestApplication;
  port?: number;
  stop(): Promise<void>;
}

/**
 * Boots one instance with the roles from config: HTTP API and/or the
 * background workers. Several instances can (and should) run side by side.
 */
export async function startApplication(config: AppConfig): Promise<RunningApp> {
  const container = await AppContainer.create(config);
  const log = container.logger;
  await container.queues.resolve().catch((error) => {
    log.warn({ ...errorFields(error) }, 'SQS not reachable at startup; workers will keep retrying');
  });

  let http: INestApplication | undefined;
  let port: number | undefined;
  if (config.roles.includes('api')) {
    http = await NestFactory.create(buildModule(container), { logger: ['error', 'warn'], bodyParser: true });
    await http.listen(config.port, '0.0.0.0');
    const address = http.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : config.port;
  }
  container.startWorkers();
  log.info({ roles: config.roles, port }, 'instance started');

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      log.info({}, 'shutting down');
      // 1. stop taking new queue work and finish in-flight messages
      await container.stopWorkers();
      // 2. drain HTTP connections
      await http?.close();
      // 3. release pools
      await container.close();
      log.info({}, 'shutdown complete');
    })();
    return stopping;
  };
  return { container, http, port, stop };
}
