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
      problems.push("DATABASE_URL is not a valid URL");
    } else if (password === "" || password === ENV_EXAMPLE_PLACEHOLDER) {
      problems.push(
        "DATABASE_URL needs a database password other than the .env.example placeholder (generate one with: openssl rand -hex 32)",
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

/** The decoded password of a connection URL, or undefined when it does not parse. */
function databasePassword(databaseUrl: string): string | undefined {
  let password: string;
  try {
    password = new URL(databaseUrl).password;
  } catch {
    return undefined;
  }
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}
