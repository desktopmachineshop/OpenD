import type { Db } from './db.js';

export async function audit(
  db: Db,
  actor: string,
  action: string,
  detail: object = {},
): Promise<void> {
  await db.query('insert into audit_log (actor, action, detail) values ($1, $2, $3)', [
    actor,
    action,
    JSON.stringify(detail),
  ]);
}

export async function listAudit(
  db: Db,
  limit = 100,
): Promise<{ at: Date; actor: string; action: string; detail: unknown }[]> {
  const { rows } = await db.query(
    'select at, actor, action, detail from audit_log order by id desc limit $1',
    [limit],
  );
  return rows;
}
