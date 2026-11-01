import type { components } from "@mashkif/contracts";
import { eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { hashToken } from "../admin/setup.js";
import type { MemoryRateLimitStore, RateLimitRule } from "../auth/rate-limit.js";
import type { Db } from "../db/client.js";
import { agent, blockedRange } from "../db/schema.js";
import { describeSafely } from "../errors.js";
import { classifyAreaCell } from "../geo/area.js";
import { siteKeyOf } from "../geo/site.js";
import type { AsnLookup } from "../geoip.js";
import { boundedBody } from "../http/bounded-body.js";
import {
  type ClientAddressResolver,
  normalizeAddress,
  peerAddress,
} from "../http/request-guards.js";
import { readSettings } from "../settings.js";
import { recordEvents } from "./events.js";
import { recordHeartbeat } from "./heartbeat.js";
import { parseEventsRequest, parseHeartbeat, parseRegister, TOKEN_PATTERN } from "./parse.js";
import { type RegisterHooks, registerAgent } from "./register.js";

type Schemas = components["schemas"];
export type AgentErrorCode = Schemas["AgentErrorCode"];

/** Largest agent request body (contracts/openapi.yaml). */
export const AGENT_BODY_LIMIT_BYTES = 64 * 1024;
/** Time an agent has to send the whole body. */
export const AGENT_BODY_TIMEOUT_MS = 10_000;
/** Most events in one request. */
export const MAX_EVENTS_PER_REQUEST = 500;

/** Registrations per client address. A retry after a lost answer fits easily. */
export const REGISTER_RATE_LIMIT: RateLimitRule = { window: 600, max: 10 };
/** Heartbeats per token: the shortest interval is 30 seconds, plus retries. */
export const HEARTBEAT_RATE_LIMIT: RateLimitRule = { window: 60, max: 10 };
/** Events requests per token: a backlog of 500-event batches after a long time offline. */
export const EVENTS_RATE_LIMIT: RateLimitRule = { window: 60, max: 30 };

export interface AgentDeps {
  db: Db;
  asn: AsnLookup;
  rateLimits: MemoryRateLimitStore;
  /** Defaults to the TCP peer address. */
  clientAddress?: ClientAddressResolver;
  /** The server clock; tests replace it. */
  now?: () => Date;
  bodyTimeoutMs?: number;
  testHooks?: RegisterHooks;
}

type AgentEnv = { Variables: { protocolVersion: number } };

function refuse(
  c: Context,
  status: 400 | 401 | 403 | 409 | 413 | 429 | 500,
  error: AgentErrorCode,
  field?: string,
) {
  const body: Schemas["AgentError"] = field === undefined ? { error } : { error, field };
  return c.json(body, status);
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

async function limited(
  deps: AgentDeps,
  c: Context,
  key: string,
  rule: RateLimitRule,
): Promise<Response | undefined> {
  const decision = await deps.rateLimits.consume(key, rule);
  if (decision.allowed) {
    return undefined;
  }
  c.header("Retry-After", String(decision.retryAfter ?? rule.window));
  return refuse(c, 429, "rate_limited");
}

async function addressBlocked(db: Db, address: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(blockedRange)
    .where(sql`${address}::inet <<= ${blockedRange.range}`)
    .limit(1);
  return rows.length > 0;
}

function clientAddress(deps: AgentDeps, c: Context): string | undefined {
  const address = normalizeAddress((deps.clientAddress ?? peerAddress)(c));
  return address !== undefined && siteKeyOf(address) !== undefined ? address : undefined;
}

type Authenticated = { agentId: string; address: string };

/**
 * The bearer token, its rate limit, the agent's state, and the client
 * address, in that order. Returns the refusal, or the agent and address.
 */
async function authenticate(
  deps: AgentDeps,
  c: Context,
  scope: string,
  rule: RateLimitRule,
): Promise<Response | Authenticated> {
  const match = /^Bearer\s+(\S+)$/.exec(c.req.header("authorization") ?? "");
  const token = match?.[1];
  if (token === undefined || !TOKEN_PATTERN.test(token)) {
    return refuse(c, 401, "token_invalid");
  }
  const tokenHash = hashToken(token);
  const refusal = await limited(deps, c, `agent:${scope}:${tokenHash}`, rule);
  if (refusal !== undefined) {
    return refusal;
  }
  const [row] = await deps.db
    .select({ id: agent.id, revokedAt: agent.revokedAt, trustTier: agent.trustTier })
    .from(agent)
    .where(eq(agent.tokenHash, tokenHash));
  if (row === undefined) {
    return refuse(c, 401, "token_invalid");
  }
  if (row.revokedAt !== null) {
    return refuse(c, 403, "agent_revoked");
  }
  if (row.trustTier === "blocked") {
    return refuse(c, 403, "agent_blocked");
  }
  const address = clientAddress(deps, c);
  if (address === undefined) {
    console.error(`agent request without a usable client address: ${c.req.path}`);
    return refuse(c, 500, "internal_error");
  }
  if (await addressBlocked(deps.db, address)) {
    return refuse(c, 403, "address_blocked");
  }
  return { agentId: row.id, address };
}

/** The register, heartbeat, and events operations of contracts/openapi.yaml. */
export function mountIngestRoutes(app: Hono<AgentEnv>, deps: AgentDeps): void {
  const now = deps.now ?? (() => new Date());
  const limit = boundedBody(AGENT_BODY_LIMIT_BYTES, deps.bodyTimeoutMs ?? AGENT_BODY_TIMEOUT_MS);
  app.use("/register", limit);
  app.use("/heartbeat", limit);
  app.use("/events", limit);

  app.post("/register", async (c) => {
    const address = clientAddress(deps, c);
    if (address === undefined) {
      console.error("agent registration without a usable client address");
      return refuse(c, 500, "internal_error");
    }
    const refusal = await limited(deps, c, `agent:register:${address}`, REGISTER_RATE_LIMIT);
    if (refusal !== undefined) {
      return refusal;
    }
    if (await addressBlocked(deps.db, address)) {
      return refuse(c, 403, "address_blocked");
    }
    const parsed = parseRegister(await readJson(c));
    if (!parsed.ok) {
      return refuse(c, 400, "request_invalid", parsed.field);
    }
    const at = now();
    const outcome = await registerAgent(deps.db, parsed.value, address, at, deps.testHooks);
    if (!outcome.ok) {
      return refuse(c, outcome.error === "install_id_conflict" ? 409 : 403, outcome.error);
    }
    const settings = await readSettings(deps.db);
    const body: Schemas["RegisterResponse"] = {
      agentId: outcome.agentId,
      heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
      serverTime: at.toISOString(),
    };
    return c.json(body, outcome.created ? 201 : 200);
  });

  app.post("/heartbeat", async (c) => {
    const auth = await authenticate(deps, c, "heartbeat", HEARTBEAT_RATE_LIMIT);
    if (auth instanceof Response) {
      return auth;
    }
    const parsed = parseHeartbeat(await readJson(c));
    if (!parsed.ok) {
      return refuse(c, 400, "request_invalid", parsed.field);
    }
    const input = parsed.value;
    let areaCell: string | null = null;
    if (input.areaCell !== null) {
      const area = classifyAreaCell(input.areaCell);
      if (area === "invalid") {
        return refuse(c, 400, "request_invalid", "areaCell");
      }
      areaCell = area === "inside" ? input.areaCell : null;
    }
    const settings = await readSettings(deps.db);
    const reply = await recordHeartbeat(deps.db, input, {
      agentId: auth.agentId,
      address: auth.address,
      siteKey: siteKeyOf(auth.address) as string,
      asn: deps.asn.lookup(auth.address),
      areaCell,
      intervalSentSeconds: settings.heartbeatIntervalSeconds,
      now: now(),
    });
    const body: Schemas["HeartbeatResponse"] = {
      syncId: reply.syncId,
      serverTime: reply.serverTime.toISOString(),
      nextIntervalSeconds: reply.nextIntervalSeconds,
    };
    return c.json(body, 200);
  });

  app.post("/events", async (c) => {
    const auth = await authenticate(deps, c, "events", EVENTS_RATE_LIMIT);
    if (auth instanceof Response) {
      return auth;
    }
    const parsed = parseEventsRequest(await readJson(c));
    if (!parsed.ok) {
      return refuse(c, 400, "request_invalid", parsed.field);
    }
    if (parsed.value.events.length > MAX_EVENTS_PER_REQUEST) {
      return refuse(c, 413, "too_many_events");
    }
    const results = await recordEvents(
      deps.db,
      auth.agentId,
      parsed.value.events,
      parsed.value.droppedEvents,
      now(),
    );
    const body: Schemas["EventsResponse"] = { results };
    return c.json(body, 200);
  });

  app.onError((error, c) => {
    console.error(`agent request failed: ${c.req.method} ${c.req.path}: ${describeSafely(error)}`);
    return refuse(c, 500, "internal_error");
  });
}
