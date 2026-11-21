
import { loadPgPoolForStore, isPgActive, getActivePgPool } from './connection';
import { ensurePostgresTables } from './schema-sync';

export async function migrateSqliteToPostgres() {
   // Legacy. Now a no-op.
}

export async function initDB() {
  await loadPgPoolForStore('default');
  if (isPgActive() && getActivePgPool()) {
    await ensurePostgresTables();
  }
}
