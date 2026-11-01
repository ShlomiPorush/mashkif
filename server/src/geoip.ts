import { readFile, stat } from "node:fs/promises";
import { type AsnResponse, Reader } from "maxmind";
import { describeSafely } from "./errors.js";

export interface AsnInfo {
  asn: number;
  organization: string | null;
}

export interface GeoipStatus {
  /** ok: a database is loaded. unavailable: none could be read yet. */
  state: "ok" | "unavailable";
  /** Build date of the loaded database. */
  buildDate: string | null;
  /** The loaded database is older than STALE_AFTER_DAYS. */
  stale: boolean;
}

/** ASN lookups for the agent ingest. */
export interface AsnLookup {
  /** The ASN and organization of a public address, or undefined when unknown. */
  lookup(address: string): AsnInfo | undefined;
  status(now?: Date): GeoipStatus;
}

/** GeoLite2-ASN is rebuilt twice a week; older than this counts as stale. */
export const STALE_AFTER_DAYS = 14;

/** How often the file is checked for a replacement. */
export const GEOIP_CHECK_INTERVAL_MS = 60_000;

/**
 * Reads the GeoLite2-ASN database that the operator mounts read-only
 * (MASHKIF_GEOIP_ASN_PATH) with the `maxmind` reader. The file is maintained
 * outside Mashkif, so it is checked every minute and loaded again when it
 * changes. A missing or unreadable file never stops the server: lookups
 * answer "unknown" until a valid database is there, and a broken
 * replacement keeps the last good one.
 */
export class GeoLiteAsn implements AsnLookup {
  #reader: Reader<AsnResponse> | undefined;
  #buildDate: Date | undefined;
  #loadedMtimeMs: number | undefined;
  #failedMtimeMs: number | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** Loads the file when it is new or changed. Never throws. */
  async refresh(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch (error) {
      if (this.#failedMtimeMs !== -1) {
        this.log(`GeoLite2-ASN is not readable: ${describeSafely(error)}`);
        this.#failedMtimeMs = -1;
      }
      return;
    }
    if (mtimeMs === this.#loadedMtimeMs || mtimeMs === this.#failedMtimeMs) {
      return;
    }
    try {
      const reader = new Reader<AsnResponse>(await readFile(this.path));
      if (!reader.metadata.databaseType.includes("ASN")) {
        throw new Error(`database type ${reader.metadata.databaseType} is not an ASN database`);
      }
      this.#reader = reader;
      this.#buildDate = reader.metadata.buildEpoch;
      this.#loadedMtimeMs = mtimeMs;
      this.#failedMtimeMs = undefined;
      console.log(`GeoLite2-ASN loaded, built ${this.#buildDate.toISOString()}`);
    } catch (error) {
      this.#failedMtimeMs = mtimeMs;
      this.log(
        `GeoLite2-ASN could not be loaded${this.#reader === undefined ? "" : "; the previous database stays in use"}: ${describeSafely(error)}`,
      );
    }
  }

  /** Loads the file now and checks for changes every interval. */
  start(intervalMs = GEOIP_CHECK_INTERVAL_MS): Promise<void> {
    this.#timer = setInterval(() => void this.refresh(), intervalMs);
    this.#timer.unref();
    return this.refresh();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  lookup(address: string): AsnInfo | undefined {
    if (this.#reader === undefined) {
      return undefined;
    }
    try {
      const found = this.#reader.get(address);
      if (found === null || typeof found.autonomous_system_number !== "number") {
        return undefined;
      }
      const organization = found.autonomous_system_organization;
      return {
        asn: found.autonomous_system_number,
        organization: typeof organization === "string" && organization !== "" ? organization : null,
      };
    } catch {
      return undefined;
    }
  }

  status(now = new Date()): GeoipStatus {
    if (this.#reader === undefined || this.#buildDate === undefined) {
      return { state: "unavailable", buildDate: null, stale: false };
    }
    const ageMs = now.getTime() - this.#buildDate.getTime();
    return {
      state: "ok",
      buildDate: this.#buildDate.toISOString(),
      stale: ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    };
  }
}

/** A lookup that knows nothing, for tests and an app without GeoIP. */
export const NO_ASN: AsnLookup = {
  lookup: () => undefined,
  status: () => ({ state: "unavailable", buildDate: null, stale: false }),
};
