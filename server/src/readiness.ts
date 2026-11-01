import { open } from "node:fs/promises";
import type { Sql } from "postgres";

export const READINESS_CHECKS = ["database", "geoip"] as const;
export type ReadinessCheckName = (typeof READINESS_CHECKS)[number];

/** A readiness check resolves when the dependency works and rejects otherwise. */
export type ReadinessCheck = () => Promise<void>;
export type ReadinessChecks = Record<ReadinessCheckName, ReadinessCheck>;

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<ReadinessCheckName, "ok" | "failed">;
  failing: ReadinessCheckName[];
}

export const DEFAULT_READINESS_TIMEOUT_MS = 3000;

class CheckTimeoutError extends Error {
  override name = "CheckTimeoutError";
}

function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CheckTimeoutError(`timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Runs every check in parallel, each bounded by the timeout. */
export async function runReadiness(
  checks: ReadinessChecks,
  timeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS,
  onFailure: (name: ReadinessCheckName, reason: string) => void = () => {},
): Promise<ReadinessReport> {
  const results = await Promise.allSettled(
    READINESS_CHECKS.map((name) => withTimeout(checks[name], timeoutMs)),
  );
  const report: ReadinessReport = {
    status: "ready",
    checks: { database: "ok", geoip: "ok" },
    failing: [],
  };
  results.forEach((result, index) => {
    const name = READINESS_CHECKS[index];
    if (name === undefined || result.status === "fulfilled") {
      return;
    }
    report.checks[name] = "failed";
    report.failing.push(name);
    onFailure(name, describe(result.reason));
  });
  if (report.failing.length > 0) {
    report.status = "not_ready";
  }
  return report;
}

/** PostgreSQL answers a query. */
export function databaseCheck(sql: Sql): ReadinessCheck {
  return async () => {
    await sql`select 1`;
  };
}

/** The file exists, is a regular file, and can be opened for reading. */
export function readableFileCheck(path: string): ReadinessCheck {
  return async () => {
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error("not a regular file");
      }
    } finally {
      await handle.close();
    }
  };
}
