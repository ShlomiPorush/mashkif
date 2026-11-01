import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";

/**
 * One PostgreSQL advisory lock serializes every change of the admin's
 * credentials and every sign-in step that creates a session: setup,
 * reset-admin, and those auth routes. So a request that read the old state
 * cannot finish after a reset and undo it.
 */
const ADMIN_LOCK = sql`hashtext('mashkif:admin-credentials')`;

/** How long a request waits for the lock before it gives up. */
export const ADMIN_LOCK_WAIT_MS = 15_000;

export class AdminLockBusyError extends Error {
  override name = "AdminLockBusyError";
}

/** Takes the lock until the transaction ends. */
export async function lockAdminInTransaction(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK})`);
}

// The server is one process. Requests queue here first, so only the holder
// uses a pool connection for the database lock, which it then shares only
// with the CLI. Waiting in the database would hold a connection per waiter
// and could leave the holder without one.
let queue: Promise<void> = Promise.resolve();

/**
 * Runs fn while holding the lock, after the requests queued before it.
 * Throws AdminLockBusyError after waitMs in the queue or for the database lock.
 */
export async function withAdminLock<T>(
  db: Db,
  fn: () => Promise<T>,
  waitMs = ADMIN_LOCK_WAIT_MS,
): Promise<T> {
  const previous = queue;
  let release = () => {};
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timer: NodeJS.Timeout | undefined;
  const turn = await Promise.race([
    previous.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!turn) {
    // Keep the queue in order: this place is handed on once it comes up.
    void previous.then(release);
    throw new AdminLockBusyError("the admin lock is busy");
  }
  try {
    // Bounded too: a connection that arrives after the wait is handed back.
    const reserving = db.$client.reserve();
    let reserveTimer: NodeJS.Timeout | undefined;
    const connection = await Promise.race([
      reserving,
      new Promise<undefined>((resolve) => {
        reserveTimer = setTimeout(() => resolve(undefined), waitMs);
      }),
    ]);
    clearTimeout(reserveTimer);
    if (connection === undefined) {
      void reserving.then(
        (late) => late.release(),
        () => {},
      );
      throw new AdminLockBusyError("no database connection for the admin lock");
    }
    try {
      await connection`select set_config('lock_timeout', ${`${waitMs}ms`}, false)`;
      try {
        await connection`select pg_advisory_lock(hashtext('mashkif:admin-credentials'))`;
      } catch (error) {
        throw (error as { code?: unknown }).code === "55P03"
          ? new AdminLockBusyError("the admin lock is busy")
          : error;
      }
      try {
        return await fn();
      } finally {
        await connection`select pg_advisory_unlock(hashtext('mashkif:admin-credentials'))`;
      }
    } finally {
      await connection`select set_config('lock_timeout', '0', false)`.catch(() => {});
      connection.release();
    }
  } finally {
    release();
  }
}
