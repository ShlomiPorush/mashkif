/** Runtime settings read from environment variables. */
export interface ServerConfig {
  /** PostgreSQL connection URL. Never log it: it contains the password. */
  databaseUrl: string;
  /** Path of the GeoLite2-ASN database file, mounted read-only by the operator. */
  geoipAsnPath: string;
  /** TCP port for HTTP. */
  port: number;
  /** Secret key material (at least 32 bytes). Never log it. Auth secrets are derived from it. */
  appKey: Buffer;
  /** Origin the browser uses for the web app, for example https://mashkif.co.il. */
  publicOrigin: string;
}

export const DEFAULT_PORT = 8080;

/** Minimum length of MASHKIF_APP_KEY after base64 decoding. */
export const APP_KEY_MIN_BYTES = 32;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Decodes the application key, or returns undefined when it is not usable. */
export function parseAppKey(text: string): Buffer | undefined {
  let key: Buffer;
  if (BASE64.test(text)) {
    key = Buffer.from(text, "base64");
  } else if (BASE64URL.test(text)) {
    key = Buffer.from(text, "base64url");
  } else {
    return undefined;
  }
  if (key.length < APP_KEY_MIN_BYTES || new Set(key).size < 8) {
    return undefined;
  }
  return key;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates the public URL and returns its origin. HTTPS is required, except
 * for a loopback host in local development: browsers treat loopback as a
 * secure context, so Secure cookies and passkeys still work there.
 */
export function parsePublicUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.pathname !== "/") {
    return undefined;
  }
  if (url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  return undefined;
}

/**
 * Whether passkeys can work with this origin. Browsers refuse an IP address
 * as the WebAuthn relying-party ID, so passkeys need a host name.
 */
export function passkeysSupported(publicOrigin: string): boolean {
  const host = new URL(publicOrigin).hostname;
  return !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !host.startsWith("[");
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

  // The key and its length are never part of the message.
  const appKeyText = env.MASHKIF_APP_KEY?.trim() ?? "";
  const appKey = appKeyText === "" ? undefined : parseAppKey(appKeyText);
  if (appKeyText === "") {
    problems.push("MASHKIF_APP_KEY is required (generate one with: openssl rand -base64 32)");
  } else if (appKey === undefined) {
    problems.push(
      `MASHKIF_APP_KEY must be at least ${APP_KEY_MIN_BYTES} random bytes in base64 (generate one with: openssl rand -base64 32)`,
    );
  }

  const publicUrlText = env.MASHKIF_PUBLIC_URL?.trim() ?? "";
  const publicOrigin = publicUrlText === "" ? undefined : parsePublicUrl(publicUrlText);
  if (publicUrlText === "") {
    problems.push("MASHKIF_PUBLIC_URL is required (for example https://mashkif.co.il)");
  } else if (publicOrigin === undefined) {
    problems.push(
      "MASHKIF_PUBLIC_URL must be an https:// origin without a path (http:// only for localhost or 127.0.0.1)",
    );
  }

  if (problems.length > 0 || appKey === undefined || publicOrigin === undefined) {
    throw new ConfigError(problems.join("; "));
  }
  return { databaseUrl, geoipAsnPath, port, appKey, publicOrigin };
}
