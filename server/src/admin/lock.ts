import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";

/**
 * One PostgreSQL advisory lock serializes every change of the admin's
 * credentials: setup, reset-admin, and the credential-changing auth routes.
 * So a request that passed its session check cannot finish after a reset and
 * undo it.
 */
const ADMIN_LOCK = sql`hashtext('mashkif:admin-credentials')`;

/** Takes the lock until the transaction ends. */
export async function lockAdminInTransaction(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK})`);
}

/** Runs fn while holding the lock on a dedicated connection. */
export async function withAdminLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const connection = await db.$client.reserve();
  try {
    await connection`select pg_advisory_lock(hashtext('mashkif:admin-credentials'))`;
    try {
      return await fn();
    } finally {
      await connection`select pg_advisory_unlock(hashtext('mashkif:admin-credentials'))`;
    }
  } finally {
    connection.release();
  }
}
