import { getActivePgPool } from './connection';
import { commitStoreFile } from './kv-store';
import { preparePgItem, syncTableSchema, tableSchemas } from './schema-sync';

export type Row = Record<string, any>;
export type Change = {table: string; row: Row; remove?: boolean};

export async function commitRows<T>(tables: readonly string[], plan: (data: Record<string, Row[]>) => {changes: Change[]; result: T}) {
  const pool = getActivePgPool();
  if (!pool) return commitStoreFile(data => {
    const {changes, result} = plan(data);
    for (const table of new Set(changes.map(c => c.table))) {
      const rows = new Map((data[table] || []).map((row: Row) => [String(row.id),row] as const));
      for (const change of changes.filter(c => c.table === table)) {
        if (change.remove) rows.delete(String(change.row.id));
        else rows.set(String(change.row.id),change.row);
      }
      data[table] = [...rows.values()];
    }
    return result;
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data: Record<string,Row[]> = {};
    for (const table of [...tables].sort()) {
      await client.query(`LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE`);
      data[table] = (await client.query(`SELECT * FROM "${table}"`)).rows;
    }
    const {changes, result} = plan(data);
    for (const {table,row,remove} of changes) {
      if (remove) { await client.query(`DELETE FROM "${table}" WHERE id=$1`,[row.id]); continue; }
      if (Object.keys(row).some(k => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))) throw new Error('نام فیلد نامعتبر است');
      await syncTableSchema(client,table,row);
      const {itemKeys,itemVals} = preparePgItem(table,row);
      const cols = itemKeys.map(k => '"' + k.replace(/"/g,'""') + '"');
      const values = cols.map((_,i) => '$' + (i+1));
      const updates = cols.map(c => c + '=EXCLUDED.' + c);
      await client.query(`INSERT INTO "${table}" (${cols}) VALUES (${values}) ON CONFLICT(id) DO UPDATE SET ${updates}`,itemVals);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    for (const table of tables) tableSchemas.delete(table);
    throw error;
  } finally { client.release(); }
}
