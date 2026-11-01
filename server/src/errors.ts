/** Errors from database queries. Their message and properties carry SQL parameters. */
const QUERY_ERRORS = new Set(["DrizzleQueryError", "PostgresError"]);

function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Describes an error for a log line. A database error is reduced to its name
 * and PostgreSQL SQLSTATE code: its message holds query parameters such as
 * password hashes and session tokens. Other errors keep their message.
 */
export function describeSafely(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const fromQuery =
    QUERY_ERRORS.has(error.name) ||
    QUERY_ERRORS.has((error.cause as Error | undefined)?.name ?? "") ||
    "query" in error ||
    "params" in error;
  if (!fromQuery) {
    return `${error.name}: ${error.message}`;
  }
  return describeWithoutMessage(error);
}

/** An error's name and PostgreSQL SQLSTATE code, never its message. */
export function describeWithoutMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const code = sqlState(error);
  // DrizzleQueryError keeps the name "Error"; its class names it.
  const name = error.name === "Error" ? error.constructor.name : error.name;
  return code === undefined ? name : `${name} (SQLSTATE ${code})`;
}
