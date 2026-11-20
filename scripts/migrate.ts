import { loadConfig } from '../src/infrastructure/config/app-config';
import { createOrm } from '../src/infrastructure/persistence/orm';

async function main() {
  const direction = process.argv[2] ?? 'up';
  const orm = await createOrm(loadConfig());
  try {
    const migrator = orm.getMigrator();
    if (direction === 'up') {
      const applied = await migrator.up();
      console.log(JSON.stringify({ msg: 'migrations applied', applied: applied.map((m) => m.name) }));
    } else if (direction === 'down') {
      const reverted = await migrator.down();
      console.log(JSON.stringify({ msg: 'migration reverted', reverted: reverted.map((m) => m.name) }));
    } else if (direction === 'reset') {
      await migrator.down({ to: 0 });
      const applied = await migrator.up();
      console.log(JSON.stringify({ msg: 'schema reset', applied: applied.map((m) => m.name) }));
    } else {
      throw new Error(`unknown direction ${direction} (use up | down | reset)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
