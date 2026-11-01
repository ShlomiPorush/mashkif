import type { components } from "@mashkif/contracts";
import { Hono } from "hono";
import { type AgentDeps, mountIngestRoutes } from "./agent/routes.js";

type AgentHealth = components["schemas"]["AgentHealth"];
type ProtocolError = components["schemas"]["ProtocolError"];
export type ProtocolErrorCode = ProtocolError["error"];

/** Request and response header that carries the agent protocol version. */
export const PROTOCOL_VERSION_HEADER = "Mashkif-Protocol-Version";

/** The protocol version this server speaks. Matches info.version in contracts/openapi.yaml. */
export const CURRENT_PROTOCOL_VERSION = 1;

/**
 * Versions the server accepts, oldest first. When the current version moves
 * to N, keep N-1 here: agents on managed endpoints update slowly.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

export type ProtocolNegotiation =
  | { ok: true; version: number }
  | { ok: false; error: ProtocolErrorCode };

const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

/** Validates the protocol version header sent by an agent. */
export function negotiateProtocolVersion(header: string | undefined): ProtocolNegotiation {
  if (header === undefined || header.trim() === "") {
    return { ok: false, error: "protocol_version_missing" };
  }
  const text = header.trim();
  if (!VERSION_PATTERN.test(text)) {
    return { ok: false, error: "protocol_version_invalid" };
  }
  const version = Number(text);
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return { ok: false, error: "protocol_version_unsupported" };
  }
  return { ok: true, version };
}

type AgentEnv = { Variables: { protocolVersion: number } };

/**
 * Routes under /api/agent: the agent protocol defined in
 * contracts/openapi.yaml. Without deps only the health operation exists.
 */
export function agentRoutes(deps?: AgentDeps): Hono<AgentEnv> {
  const agent = new Hono<AgentEnv>();

  agent.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const negotiation = negotiateProtocolVersion(c.req.header(PROTOCOL_VERSION_HEADER));
    if (!negotiation.ok) {
      c.header(PROTOCOL_VERSION_HEADER, String(CURRENT_PROTOCOL_VERSION));
      const body: ProtocolError = {
        error: negotiation.error,
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      };
      return c.json(body, 400);
    }
    c.set("protocolVersion", negotiation.version);
    c.header(PROTOCOL_VERSION_HEADER, String(negotiation.version));
    return next();
  });

  agent.get("/health", (c) => {
    const body: AgentHealth = { status: "ok", protocolVersion: c.get("protocolVersion") };
    return c.json(body, 200);
  });

  if (deps !== undefined) {
    mountIngestRoutes(agent, deps);
  }

  return agent;
}
