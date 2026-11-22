import { Migration } from '@mikro-orm/migrations';

/**
 * The outbox publisher claims work per aggregate (the oldest unpublished
 * event of each wallet) and reads each aggregate's pending events in order.
 * This partial index serves both lookups and stays as small as the backlog.
 */
export class Migration20261122000001_outbox_aggregate_order extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index outbox_pending_by_aggregate_idx
        on outbox_messages (aggregate_id, occurred_at, id)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists outbox_pending_by_aggregate_idx;');
  }
}
