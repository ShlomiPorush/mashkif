import type { components } from "@mashkif/contracts";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { hashToken } from "../admin/setup.js";
import { MemoryRateLimitStore, type RateLimitRule } from "../auth/rate-limit.js";
import type { Db } from "../db/client.js";
import { agent } from "../db/schema.js";
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
import { addressBlocked } from "./write-guard.js";

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
/** Heartbeats per agent: the shortest interval is 30 seconds, plus retries. */
export const HEARTBEAT_RATE_LIMIT: RateLimitRule = { window: 60, max: 10 };
/** Events requests per agent: a backlog of batches after a long time offline. */
export const EVENTS_RATE_LIMIT: RateLimitRule = { window: 60, max: 30 };
/** Requests with a missing, malformed, or unknown token, per client address. */
export const UNKNOWN_TOKEN_RATE_LIMIT: RateLimitRule = { window: 60, max: 20 };

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
 * The client address, the bearer token, and the agent's rate limit. The
 * token is looked up first, so limiter entries exist only per agent and, for
 * missing or unknown tokens, per client address. The agent's state and the
 * blocked ranges are checked again inside the write transaction.
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
  const [row] =
    token === undefined || !TOKEN_PATTERN.test(token)
      ? []
      : await deps.db
          .select({ id: agent.id, revokedAt: agent.revokedAt, trustTier: agent.trustTier })
          .from(agent)
          .where(eq(agent.tokenHash, hashToken(token)));
  if (row === undefined) {
    const refusal = await limited(
      deps.rateLimits,
      c,
      `agent:unknown:${address}`,
      UNKNOWN_TOKEN_RATE_LIMIT,
    );
    return refusal ?? refuse(c, 401, "token_invalid");
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
    const refusal = await limited(registerLimits, c, `register:${address}`, REGISTER_RATE_LIMIT);
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
      return refuse(c, 403, reply.error);
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
    await deps.testHooks?.beforeWrite?.();
    const recorded = await recordEvents(
      deps.db,
      auth.agentId,
      auth.address,
      parsed.value.events,
      parsed.value.droppedEvents,
      now(),
    );
    if (!recorded.ok) {
      return refuse(c, 403, recorded.error);
    }
    const body: Schemas["EventsResponse"] = { results: recorded.results };
    return c.json(body, 200);
  });

  app.onError((error, c) => {
    console.error(`agent request failed: ${c.req.method} ${c.req.path}: ${describeSafely(error)}`);
    return refuse(c, 500, "internal_error");
  });
}
