/** Runtime settings read from environment variables. */
export interface ServerConfig {
  /** PostgreSQL connection URL. Never log it: it contains the password. */
  databaseUrl: string;
  /** Path of the GeoLite2-ASN database file, mounted read-only by the operator. */
  geoipAsnPath: string;
  /** TCP port for HTTP. */
  port: number;
}

export const DEFAULT_PORT = 8080;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads and validates the server settings. Throws ConfigError naming every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") {
    problems.push("DATABASE_URL is required");
  } else if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must start with postgres:// or postgresql://");
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

  if (problems.length > 0) {
    throw new ConfigError(problems.join("; "));
  }
  return { databaseUrl, geoipAsnPath, port };
}
