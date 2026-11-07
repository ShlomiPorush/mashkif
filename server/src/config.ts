import { settingEnvProblems } from "./settings.js";

/**
 * Values the server needs before it can read its settings from the database.
 * They come only from the environment; every other setting lives in the
 * admin panel (src/settings.ts), where an environment variable may override it.
 */
export interface ServerConfig {
  /** PostgreSQL connection URL. Never log it: it contains the password. */
  databaseUrl: string;
  /** Path of the GeoLite2-ASN database file, mounted read-only by the operator. */
  geoipAsnPath: string;
  /** TCP port for HTTP. */
  port: number;
  /** BETTER_AUTH_SECRET, passed to Better Auth as is. Never log it. */
  authSecret: string;
}

export const DEFAULT_PORT = 8080;

/** Minimum length of BETTER_AUTH_SECRET, as Better Auth recommends. */
export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * The placeholder that .env.example puts in every secret. The server refuses
 * it as the database password; a test checks that .env.example still uses it,
 * and scripts/local.sh reads it from there.
 */
export const ENV_EXAMPLE_PLACEHOLDER = "change-me";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Reads and validates the environment-only values and every environment
 * override of a setting. Throws ConfigError naming every problem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") {
    problems.push("DATABASE_URL is required");
  } else if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must start with postgres:// or postgresql://");
  } else {
    // Neither the URL nor the password is ever part of the message.
    const password = databasePassword(databaseUrl);
    if (password === undefined) {
      problems.push("DATABASE_URL is not a URL the PostgreSQL client can read");
    } else if (password === "" || password === ENV_EXAMPLE_PLACEHOLDER) {
      problems.push(
        "DATABASE_URL needs a database password other than the .env.example placeholder (generate one with: openssl rand -hex 32)",
      );
    } else if (/[\r\n]/.test(password)) {
      // The db container refuses the same, because initdb --pwfile keeps only
      // the first line of a password.
      problems.push(
        "DATABASE_URL has a database password with a line break (generate one with: openssl rand -hex 32)",
      );
    }
  }

  const geoipAsnPath = env.MASHKIF_GEOIP_ASN_PATH?.trim() ?? "";
  if (geoipAsnPath === "") {
    problems.push("MASHKIF_GEOIP_ASN_PATH is required");
  }

  const portText = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be a whole number from 1 to 65535");
  }

  // The secret and its length are never part of the message.
  const authSecret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (authSecret === "") {
    problems.push("BETTER_AUTH_SECRET is required (generate one with: openssl rand -base64 32)");
  } else if (authSecret.length < AUTH_SECRET_MIN_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} random characters (generate one with: openssl rand -base64 32)`,
    );
  }

  problems.push(...settingEnvProblems(env));

  if (problems.length > 0) {
    throw new ConfigError(problems.join("; "));
  }
  return { databaseUrl, geoipAsnPath, port, authSecret };
}

/**
 * The password that postgres.js sends for a connection URL, "" when the URL
 * has none, or undefined when postgres.js could not parse it. postgres.js does
 * not document a way to read its parsed options, so this repeats the steps of
 * parseUrl in postgres 3.4.9 (src/index.js:537-550): it cuts the hosts out of
 * the authority, keeps the first one so that several hosts parse, and takes
 * the password from the WHATWG URL parser, which also strips tabs, newlines,
 * and leading or trailing control characters. server/test/config.test.ts
 * compares the result with the driver's own parsing.
 */
function databasePassword(databaseUrl: string): string | undefined {
  try {
    let host = databaseUrl.slice(databaseUrl.indexOf("://") + 3).split(/[?/]/)[0] ?? "";
    host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
    const url = new URL(databaseUrl.replace(host, host.split(",")[0] ?? ""));
    return decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
}
