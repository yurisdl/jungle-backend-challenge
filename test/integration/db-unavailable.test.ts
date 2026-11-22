import { MikroORM } from '@mikro-orm/postgresql';
import { describe, expect, test } from 'bun:test';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { TransientInfrastructureError } from '../../src/application/errors';
import { translateDbError } from '../../src/infrastructure/persistence/db-errors';
import { ormOptions } from '../../src/infrastructure/persistence/orm';
import { testConfig } from '../support/harness';

/**
 * A database that is down does not always refuse the connection: a proxy or a
 * port forward (Docker Desktop does this) can accept the TCP connection and
 * never answer. The driver then gives up after DB_CONNECT_TIMEOUT_MS with a
 * bare "timeout expired", which must still mean "retry" (503), not 500.
 */
describe('database unreachable', () => {
  test('a connection that hangs until the connect timeout is a transient error', async () => {
    const sockets: Socket[] = [];
    const blackhole = createServer((socket) => sockets.push(socket)); // accepts, never answers
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const { port } = blackhole.address() as AddressInfo;
    const config = testConfig({ DATABASE_URL: `postgresql://wagering:wagering@127.0.0.1:${port}/wagering`, DB_CONNECT_TIMEOUT_MS: '300' });
    const orm = await MikroORM.init({ ...ormOptions(config), connect: false });
    try {
      const error = await orm.em.fork().execute('select 1').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as Error).message).toBe('timeout expired');
      const translated = translateDbError(error);
      expect(translated).toBeInstanceOf(TransientInfrastructureError);
      expect((translated as TransientInfrastructureError).reason).toBe('DATABASE_UNAVAILABLE');
    } finally {
      await orm.close(true).catch(() => undefined);
      sockets.forEach((s) => s.destroy());
      blackhole.close();
    }
  }, 20_000);
});
