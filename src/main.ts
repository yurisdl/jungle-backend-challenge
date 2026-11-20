import { startApplication } from './app';
import { loadConfig } from './infrastructure/config/app-config';

async function main() {
  const app = await startApplication(loadConfig());
  const shutdown = (signal: string) => {
    app.container.logger.info({ signal }, 'signal received');
    const force = setTimeout(() => process.exit(1), 25_000);
    app
      .stop()
      .then(() => {
        clearTimeout(force);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'startup failed', err: String(error) })}\n`);
  process.exit(1);
});
