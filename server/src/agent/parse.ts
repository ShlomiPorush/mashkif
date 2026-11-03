import type { components } from "@mashkif/contracts";
import { EVENT_KINDS, type EventKind, INFRASTRUCTURES, type Infrastructure } from "../db/schema.js";

/**
 * Request parsing for the agent API, following contracts/openapi.yaml.
 * Unknown fields are ignored, so an agent that sends a newer optional field
 * is still accepted.
 */

type Schemas = components["schemas"];
export type RegisterRequest = Schemas["RegisterRequest"];
export type HeartbeatInput = Omit<Schemas["HeartbeatRequest"], "infrastructure"> & {
  infrastructure: Infrastructure;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const OS_VERSION = /^[0-9A-Za-z .+_()-]{0,64}$/;
const SYNC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORD = /^[a-z_]{1,32}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Longest monotonic time an event may report since its sync: 400 days. An
 * agent may stay in one boot, offline, for a long time; anything longer is
 * not a real measurement and would not make a valid date.
 */
export const MAX_ELAPSED_MS = 400 * 24 * 60 * 60 * 1000;

export const TOKEN_PATTERN = TOKEN;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function int(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function nullableInt(value: unknown, min: number, max: number): value is number | null {
  return value === null || int(value, min, max);
}

export function parseRegister(body: unknown): Parsed<RegisterRequest> {
  const fields = object(body);
  if (fields === undefined) {
    return { ok: false, field: "body" };
  }
  const { token, agentVersion, osVersion } = fields;
  const installId = uuid(fields.installId);
  if (installId === undefined) {
    return { ok: false, field: "installId" };
  }
  if (typeof token !== "string" || !TOKEN.test(token)) {
    return { ok: false, field: "token" };
  }
  if (typeof agentVersion !== "string" || !VERSION.test(agentVersion)) {
    return { ok: false, field: "agentVersion" };
  }
  if (osVersion !== undefined && (typeof osVersion !== "string" || !OS_VERSION.test(osVersion))) {
    return { ok: false, field: "osVersion" };
  }
  return {
    ok: true,
    value: {
      installId,
      token,
      agentVersion,
      ...(osVersion === undefined || osVersion === "" ? {} : { osVersion }),
    },
  };
}

export function parseHeartbeat(body: unknown): Parsed<HeartbeatInput> {
  const fields = object(body);
  if (fields === undefined) {
    return { ok: false, field: "body" };
  }
  const { sequence, areaCell, infrastructure, intervalSeconds, roundTripMs, dnsMs, agentVersion } =
    fields;
  if (!int(sequence, 0, MAX_SAFE)) {
    return { ok: false, field: "sequence" };
  }
  const bootId = uuid(fields.bootId);
  if (bootId === undefined) {
    return { ok: false, field: "bootId" };
  }
  if (areaCell !== null && typeof areaCell !== "string") {
    return { ok: false, field: "areaCell" };
  }
  if (typeof infrastructure !== "string" || !WORD.test(infrastructure)) {
    return { ok: false, field: "infrastructure" };
  }
  if (!int(intervalSeconds, 1, 3600)) {
    return { ok: false, field: "intervalSeconds" };
  }
  if (!nullableInt(roundTripMs, 0, 600_000)) {
    return { ok: false, field: "roundTripMs" };
  }
  if (!nullableInt(dnsMs, 0, 600_000)) {
    return { ok: false, field: "dnsMs" };
  }
  if (
    agentVersion !== undefined &&
    (typeof agentVersion !== "string" || !VERSION.test(agentVersion))
  ) {
    return { ok: false, field: "agentVersion" };
  }
  return {
    ok: true,
    value: {
      sequence,
      bootId,
      areaCell,
      // A choice added by a newer agent counts as unknown until the server knows it.
      infrastructure: (INFRASTRUCTURES as readonly string[]).includes(infrastructure)
        ? (infrastructure as Infrastructure)
        : "unknown",
      intervalSeconds,
      roundTripMs,
      dnsMs,
      ...(agentVersion === undefined ? {} : { agentVersion }),
    },
  };
}

export interface EventInput {
  id: string;
  kind: EventKind;
  bootId: string;
  syncId: string | null;
  elapsedMs: number | null;
}

export type EventParse =
  | { ok: true; event: EventInput }
  | { ok: false; id: string | null; error: "event_invalid" | "event_kind_unknown" };

/** Parses one event on its own, so one bad event never blocks its batch. */
export function parseEvent(value: unknown): EventParse {
  const fields = object(value);
  const id = uuid(fields?.id) ?? null;
  if (fields === undefined || id === null) {
    return { ok: false, id, error: "event_invalid" };
  }
  const bootId = uuid(fields.bootId);
  const { kind, syncId, elapsedMs } = fields;
  if (bootId === undefined) {
    return { ok: false, id, error: "event_invalid" };
  }
  if (typeof kind !== "string" || !WORD.test(kind)) {
    return { ok: false, id, error: "event_invalid" };
  }
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, id, error: "event_kind_unknown" };
  }
  const withSync =
    typeof syncId === "string" && SYNC_ID.test(syncId) && int(elapsedMs, 0, MAX_ELAPSED_MS);
  const withoutSync = syncId === null && elapsedMs === null;
  if (!withSync && !withoutSync) {
    return { ok: false, id, error: "event_invalid" };
  }
  return {
    ok: true,
    event: {
      id,
      kind: kind as EventKind,
      bootId,
      syncId: withSync ? syncId : null,
      elapsedMs: withSync ? elapsedMs : null,
    },
  };
}

/** Events dropped in one boot so far, as the agent counts them. */
export interface DroppedEvents {
  bootId: string;
  count: number;
}

/** The events array and the dropped-events count of an events request. */
export function parseEventsRequest(
  body: unknown,
): Parsed<{ events: unknown[]; droppedEvents: DroppedEvents | undefined }> {
  const fields = object(body);
  if (fields === undefined || !Array.isArray(fields.events)) {
    return { ok: false, field: "events" };
  }
  let droppedEvents: DroppedEvents | undefined;
  if (fields.droppedEvents !== undefined) {
    const dropped = object(fields.droppedEvents);
    const bootId = uuid(dropped?.bootId);
    if (dropped === undefined || bootId === undefined || !int(dropped.count, 0, 1_000_000_000)) {
      return { ok: false, field: "droppedEvents" };
    }
    droppedEvents = { bootId, count: dropped.count };
  }
  return { ok: true, value: { events: fields.events, droppedEvents } };
}
