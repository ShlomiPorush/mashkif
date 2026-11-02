import type { components } from "@mashkif/contracts";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Db } from "../db/client.js";
import { agent, type TrustTier } from "../db/schema.js";
import { describeSafely } from "../errors.js";
import { classifyAreaCell } from "../geo/area.js";
import { siteKeyOf } from "../geo/site.js";
import type { AsnLookup } from "../geoip.js";
import { boundedBody } from "../http/bounded-body.js";
import { MemoryRateLimitStore, type RateLimitRule } from "../http/rate-limit.js";
import {
  type ClientAddressResolver,
  normalizeAddress,
  peerAddress,
} from "../http/request-guards.js";
import { hashToken } from "../http/token-hash.js";
import { readSettings } from "../settings.js";
import { recordEvents } from "./events.js";
import { recordHeartbeat } from "./heartbeat.js";
import { parseEventsRequest, parseHeartbeat, parseRegister, TOKEN_PATTERN } from "./parse.js";
import { type RegisterHooks, registerAgent } from "./register.js";
import { addressBlocked, type WriteRefusal } from "./write-guard.js";

type Schemas = components["schemas"];
export type AgentErrorCode = Schemas["AgentErrorCode"];

/** Largest agent request body (contracts/openapi.yaml). */
export const AGENT_BODY_LIMIT_BYTES = 64 * 1024;
/** Time an agent has to send the whole body. */
export const AGENT_BODY_TIMEOUT_MS = 10_000;
/** Most events in one request. */
export const MAX_EVENTS_PER_REQUEST = 500;

/** Window of the per-site register limit (its count is the setting registerPerSitePer10Min). */
export const REGISTER_SITE_WINDOW_SECONDS = 600;
/** Window of the global register limit (its count is the setting registerGlobalPerHour). */
export const REGISTER_GLOBAL_WINDOW_SECONDS = 3600;
/** Heartbeats per agent: the shortest interval is 30 seconds, plus retries. */
export const HEARTBEAT_RATE_LIMIT: RateLimitRule = { window: 60, max: 10 };
/** Events requests per agent: a backlog of batches after a long time offline. */
export const EVENTS_RATE_LIMIT: RateLimitRule = { window: 60, max: 30 };
/**
 * Heartbeat and events requests per client address, counted before the
 * token is looked up: generous enough for an office of agents behind one
 * address.
 */
export const ADDRESS_RATE_LIMIT: RateLimitRule = { window: 60, max: 1200 };
/**
 * What a missing, malformed, or unknown token costs against the address
 * limit: 20 of them use up an address's minute, after which requests from
 * that address get 429 without reaching the database.
 */
export const INVALID_TOKEN_COST = 60;

export interface AgentDeps {
  db: Db;
  asn: AsnLookup;
  /** Limits of authenticated agents (by agent ID) and of unknown tokens (by address). */
  rateLimits: MemoryRateLimitStore;
  /** Limits of registration, by address; a store of its own by default. */
  registerRateLimits?: MemoryRateLimitStore;
  /** Defaults to the TCP peer address. */
  clientAddress?: ClientAddressResolver;
  /** The server clock; tests replace it. */
  now?: () => Date;
  bodyTimeoutMs?: number;
  testHooks?: RegisterHooks & {
    /** Runs after authentication, before the write transaction. */
    beforeWrite?: () => Promise<void>;
  };
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

/**
 * A refused agent write. A missing agent row is 401 token_invalid, so the
 * agent registers again; only an explicit revoke is agent_revoked (O14).
 */
function refuseWrite(c: Context, error: WriteRefusal) {
  return error === "agent_missing" ? refuse(c, 401, "token_invalid") : refuse(c, 403, error);
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

async function limited(
  store: MemoryRateLimitStore,
  c: Context,
  key: string,
  rule: RateLimitRule,
): Promise<Response | undefined> {
  const decision = await store.consume(key, rule);
  if (decision.allowed) {
    return undefined;
  }
  c.header("Retry-After", String(decision.retryAfter ?? rule.window));
  return refuse(c, 429, "rate_limited");
}

function clientAddress(deps: AgentDeps, c: Context): string | undefined {
  const address = normalizeAddress((deps.clientAddress ?? peerAddress)(c));
  return address !== undefined && siteKeyOf(address) !== undefined ? address : undefined;
}

type Authenticated = { agentId: string; address: string };

/**
 * The client address and its limit, the bearer token, and the agent's limit.
 * The address limit comes before the token lookup, so a flood of bogus
 * tokens stops reaching the database; a missing or unknown token costs
 * INVALID_TOKEN_COST. Limiter entries exist only per address and per agent.
 * The agent's state and the blocked ranges are checked again inside the
 * write transaction.
 */
async function authenticate(
  deps: AgentDeps,
  c: Context,
  scope: string,
  rule: RateLimitRule,
): Promise<Response | Authenticated> {
  const address = clientAddress(deps, c);
  if (address === undefined) {
    console.error(`agent request without a usable client address: ${c.req.path}`);
    return refuse(c, 500, "internal_error");
  }
  const match = /^Bearer\s+(\S+)$/.exec(c.req.header("authorization") ?? "");
  const token = match?.[1];
  const addressKey = `agent:address:${address}`;
  const throttled = await limited(deps.rateLimits, c, addressKey, ADDRESS_RATE_LIMIT);
  if (throttled !== undefined) {
    return throttled;
  }
  const [row] =
    token === undefined || !TOKEN_PATTERN.test(token)
      ? []
      : await deps.db
          .select({ id: agent.id, revokedAt: agent.revokedAt, trustTier: agent.trustTier })
          .from(agent)
          .where(eq(agent.tokenHash, hashToken(token)));
  if (row === undefined) {
    await deps.rateLimits.consume(addressKey, ADDRESS_RATE_LIMIT, INVALID_TOKEN_COST - 1);
    return refuse(c, 401, "token_invalid");
  }
  const refusal = await limited(deps.rateLimits, c, `agent:${scope}:${row.id}`, rule);
  if (refusal !== undefined) {
    return refusal;
  }
  if (row.revokedAt !== null) {
    return refuse(c, 403, "agent_revoked");
  }
  if (row.trustTier === "blocked") {
    return refuse(c, 403, "agent_blocked");
  }
  return { agentId: row.id, address };
}

/** The register, heartbeat, and events operations of contracts/openapi.yaml. */
export function mountIngestRoutes(app: Hono<AgentEnv>, deps: AgentDeps): void {
  const now = deps.now ?? (() => new Date());
  const registerLimits = deps.registerRateLimits ?? new MemoryRateLimitStore();
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
    const settings = await readSettings(deps.db);
    // Per site (an IPv4 address or an IPv6 /64), before any database work, so
    // the addresses of one /64 share one budget.
    const site = siteKeyOf(address) as string;
    const refusal = await limited(registerLimits, c, `register:site:${site}`, {
      window: REGISTER_SITE_WINDOW_SECONDS,
      max: settings.registerPerSitePer10Min,
    });
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
    const outcome = await registerAgent(
      deps.db,
      parsed.value,
      address,
      at,
      {
        open: settings.registrationOpen,
        tier: settings.newAgentTier as TrustTier,
        admit: async () => {
          const decision = await registerLimits.consume("register:global", {
            window: REGISTER_GLOBAL_WINDOW_SECONDS,
            max: settings.registerGlobalPerHour,
          });
          return decision.allowed
            ? undefined
            : (decision.retryAfter ?? REGISTER_GLOBAL_WINDOW_SECONDS);
        },
      },
      deps.testHooks,
    );
    if (!outcome.ok) {
      if (outcome.error === "rate_limited") {
        c.header("Retry-After", String(outcome.retryAfter ?? REGISTER_GLOBAL_WINDOW_SECONDS));
        return refuse(c, 429, "rate_limited");
      }
      return refuse(c, outcome.error === "install_id_conflict" ? 409 : 403, outcome.error);
    }
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
    await deps.testHooks?.beforeWrite?.();
    const reply = await recordHeartbeat(deps.db, input, {
      agentId: auth.agentId,
      address: auth.address,
      siteKey: siteKeyOf(auth.address) as string,
      asn: deps.asn.lookup(auth.address),
      areaCell,
      intervalSentSeconds: settings.heartbeatIntervalSeconds,
      now: now(),
    });
    if (!reply.ok) {
      return refuseWrite(c, reply.error);
    }
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
    const settings = await readSettings(deps.db);
    await deps.testHooks?.beforeWrite?.();
    const recorded = await recordEvents(
      deps.db,
      auth.agentId,
      auth.address,
      parsed.value.events,
      parsed.value.droppedEvents,
      now(),
      {
        perAgentHour: settings.eventsPerAgentHour,
        perLowAgentHour: settings.eventsPerLowAgentHour,
      },
    );
    if (!recorded.ok) {
      return refuseWrite(c, recorded.error);
    }
    const body: Schemas["EventsResponse"] =
      recorded.retryAfterSeconds === undefined
        ? { results: recorded.results }
        : { results: recorded.results, retryAfterSeconds: recorded.retryAfterSeconds };
    return c.json(body, 200);
  });

  app.onError((error, c) => {
    console.error(`agent request failed: ${c.req.method} ${c.req.path}: ${describeSafely(error)}`);
    return refuse(c, 500, "internal_error");
  });
}
