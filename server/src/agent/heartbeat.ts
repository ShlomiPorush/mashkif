import { randomBytes } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent, heartbeat } from "../db/schema.js";
import type { AsnInfo } from "../geoip.js";
import type { HeartbeatInput } from "./parse.js";

export interface HeartbeatContext {
  agentId: string;
  /** Full public address the heartbeat came from. */
  address: string;
  siteKey: string;
  asn: AsnInfo | undefined;
  /** The reported cell after validation: null when unknown or outside the service area. */
  areaCell: string | null;
  /** The interval this response sends. */
  intervalSentSeconds: number;
  now: Date;
}

export interface HeartbeatReply {
  syncId: string;
  serverTime: Date;
  nextIntervalSeconds: number;
}

/**
 * The interval silence is judged by. Until the agent reports the interval
 * the server last sent, the larger of the two counts, so neither a lost
 * response nor a change in either direction makes the agent look silent.
 */
export function silenceInterval(reportedSeconds: number, sentSeconds: number): number {
  return reportedSeconds === sentSeconds ? sentSeconds : Math.max(reportedSeconds, sentSeconds);
}

/**
 * Stores a heartbeat and moves the agent to its site and values. A retry of
 * the same heartbeat (same boot ID and sequence) is stored once and gets the
 * original answer.
 */
export async function recordHeartbeat(
  db: Db,
  input: HeartbeatInput,
  context: HeartbeatContext,
): Promise<HeartbeatReply> {
  const { agentId, now } = context;
  return db.transaction(async (tx) => {
    const original = async () => {
      const [row] = await tx
        .select({
          syncId: heartbeat.syncId,
          receivedAt: heartbeat.receivedAt,
          intervalSentSeconds: heartbeat.intervalSentSeconds,
        })
        .from(heartbeat)
        .where(
          and(
            eq(heartbeat.agentId, agentId),
            eq(heartbeat.bootId, input.bootId),
            eq(heartbeat.sequence, input.sequence),
          ),
        );
      return row === undefined
        ? undefined
        : {
            syncId: row.syncId,
            serverTime: row.receivedAt,
            nextIntervalSeconds: row.intervalSentSeconds,
          };
    };
    const repeated = await original();
    if (repeated !== undefined) {
      return repeated;
    }

    const syncId = randomBytes(16).toString("base64url");
    const inserted = await tx
      .insert(heartbeat)
      .values({
        agentId,
        syncId,
        receivedAt: now,
        bootId: input.bootId,
        sequence: input.sequence,
        address: context.address,
        siteKey: context.siteKey,
        asn: context.asn?.asn ?? null,
        asOrganization: context.asn?.organization ?? null,
        areaCell: context.areaCell,
        infrastructure: input.infrastructure,
        intervalReportedSeconds: input.intervalSeconds,
        intervalSentSeconds: context.intervalSentSeconds,
        roundTripMs: input.roundTripMs,
        dnsMs: input.dnsMs,
        agentVersion: input.agentVersion ?? null,
      })
      .onConflictDoNothing({ target: [heartbeat.agentId, heartbeat.bootId, heartbeat.sequence] })
      .returning({ id: heartbeat.id });
    if (inserted.length === 0) {
      // The same heartbeat arrived twice at once; the other copy was stored.
      const other = await original();
      if (other === undefined) {
        throw new Error("a conflicting heartbeat is not readable");
      }
      return other;
    }

    // A heartbeat received earlier but committed later never moves the agent back.
    await tx
      .update(agent)
      .set({
        lastSeenAt: now,
        address: context.address,
        siteKey: context.siteKey,
        asn: context.asn?.asn ?? null,
        asOrganization: context.asn?.organization ?? null,
        reportedCell: context.areaCell,
        infrastructure: input.infrastructure,
        intervalReportedSeconds: input.intervalSeconds,
        intervalSentSeconds: context.intervalSentSeconds,
        silenceIntervalSeconds: silenceInterval(input.intervalSeconds, context.intervalSentSeconds),
        lastBootId: input.bootId,
        lastSequence: input.sequence,
        ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
      })
      .where(and(eq(agent.id, agentId), or(isNull(agent.lastSeenAt), lte(agent.lastSeenAt, now))));

    return { syncId, serverTime: now, nextIntervalSeconds: context.intervalSentSeconds };
  });
}
