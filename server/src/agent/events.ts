import type { components } from "@mashkif/contracts";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  agent,
  agentBoot,
  agentEvent,
  syncAnchor,
  type TimeUncertainReason,
} from "../db/schema.js";
import { confirmAnchors, touchBoot } from "./boots.js";
import { type DroppedEvents, type EventInput, parseEvent } from "./parse.js";
import { guardAgentWrite, type WriteRefusal } from "./write-guard.js";

export type EventResult = components["schemas"]["EventResult"];

/** Events older than this do not refine history (the backfill window). */
export const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface Sync {
  serverTime: Date;
  bootId: string;
}

type ValidTime = { occurredAt: Date | null; uncertain: TimeUncertainReason | null };
export type EventTime = ValidTime | { invalid: true };

/**
 * The time of an event: the server time recorded for its sync ID plus the
 * monotonic time elapsed since. It is uncertain when the event has no sync
 * in its own boot (a reboot while offline), names an unknown sync, would be
 * later than the moment the server received it, or is older than the
 * backfill window. Uncertain events do not refine history. A time that is
 * not a valid date makes the event invalid on its own.
 */
export function eventTime(event: EventInput, sync: Sync | undefined, receivedAt: Date): EventTime {
  if (event.syncId === null || event.elapsedMs === null) {
    return { occurredAt: null, uncertain: "no_sync" };
  }
  if (sync === undefined) {
    return { occurredAt: null, uncertain: "sync_unknown" };
  }
  if (sync.bootId !== event.bootId) {
    // The elapsed time was measured on another boot's monotonic clock.
    return { occurredAt: null, uncertain: "other_boot" };
  }
  const occurredAt = new Date(sync.serverTime.getTime() + event.elapsedMs);
  if (!Number.isFinite(occurredAt.getTime())) {
    // Not a real time; the parser bounds elapsedMs, this guards the date itself.
    return { invalid: true };
  }
  if (occurredAt.getTime() > receivedAt.getTime()) {
    return { occurredAt, uncertain: "in_future" };
  }
  if (receivedAt.getTime() - occurredAt.getTime() > BACKFILL_WINDOW_MS) {
    return { occurredAt, uncertain: "too_old" };
  }
  return { occurredAt, uncertain: null };
}

/**
 * Stores a batch of events, each judged on its own, and answers one result
 * per event in request order. The latest event with a certain time becomes
 * the agent's current state only when it is later than both the agent's
 * latest heartbeat and its current event, so a late event never changes the
 * state of an agent that has reported since. The transaction first checks,
 * under the agent row lock, that the agent may still write.
 */
export async function recordEvents(
  db: Db,
  agentId: string,
  address: string,
  rawEvents: unknown[],
  droppedEvents: DroppedEvents | undefined,
  receivedAt: Date,
): Promise<{ ok: true; results: EventResult[] } | { ok: false; error: WriteRefusal }> {
  const parsed = rawEvents.map(parseEvent);
  const syncIds = [
    ...new Set(
      parsed.flatMap((item) => (item.ok && item.event.syncId !== null ? [item.event.syncId] : [])),
    ),
  ];

  return db.transaction(async (tx) => {
    const refusal = await guardAgentWrite(tx, agentId, address);
    if (refusal !== undefined) {
      return { ok: false as const, error: refusal };
    }
    // The agent holds these sync IDs: retention must keep them.
    await confirmAnchors(tx, agentId, syncIds);
    const syncs = new Map<string, Sync>();
    if (syncIds.length > 0) {
      const rows = await tx
        .select({
          syncId: syncAnchor.syncId,
          serverTime: syncAnchor.serverTime,
          bootId: syncAnchor.bootId,
        })
        .from(syncAnchor)
        .where(and(eq(syncAnchor.agentId, agentId), inArray(syncAnchor.syncId, syncIds)));
      for (const row of rows) {
        syncs.set(row.syncId, { serverTime: row.serverTime, bootId: row.bootId });
      }
    }

    const results: (EventResult | undefined)[] = [];
    const rows: (typeof agentEvent.$inferInsert)[] = [];
    const pending: { index: number; event: EventInput; time: ValidTime }[] = [];
    const seen = new Set<string>();
    parsed.forEach((item, index) => {
      if (!item.ok) {
        results[index] = { id: item.id, status: "rejected", error: item.error };
        return;
      }
      const { event } = item;
      if (seen.has(event.id)) {
        results[index] = { id: event.id, status: "duplicate" };
        return;
      }
      const sync = event.syncId === null ? undefined : syncs.get(event.syncId);
      const time = eventTime(event, sync, receivedAt);
      if ("invalid" in time) {
        results[index] = { id: event.id, status: "rejected", error: "event_invalid" };
        return;
      }
      seen.add(event.id);
      pending.push({ index, event, time });
      rows.push({
        agentId,
        eventId: event.id,
        kind: event.kind,
        bootId: event.bootId,
        syncId: event.syncId,
        elapsedMs: event.elapsedMs,
        occurredAt: time.occurredAt,
        timeUncertain: time.uncertain !== null,
        uncertainReason: time.uncertain,
        receivedAt,
      });
    });

    const inserted = new Set<string>();
    if (rows.length > 0) {
      const stored = await tx
        .insert(agentEvent)
        .values(rows)
        .onConflictDoNothing({ target: [agentEvent.agentId, agentEvent.eventId] })
        .returning({ eventId: agentEvent.eventId });
      for (const row of stored) {
        inserted.add(row.eventId);
      }
    }

    let latest: { kind: EventInput["kind"]; at: Date } | undefined;
    for (const { index, event, time } of pending) {
      if (!inserted.has(event.id)) {
        results[index] = { id: event.id, status: "duplicate" };
        continue;
      }
      results[index] = { id: event.id, status: "accepted", timeUncertain: time.uncertain !== null };
      if (time.uncertain === null && time.occurredAt !== null) {
        if (latest === undefined || time.occurredAt > latest.at) {
          latest = { kind: event.kind, at: time.occurredAt };
        }
      }
    }

    if (latest !== undefined) {
      await tx
        .update(agent)
        .set({ lastEventKind: latest.kind, lastEventAt: latest.at })
        .where(
          and(
            eq(agent.id, agentId),
            or(isNull(agent.lastSeenAt), lt(agent.lastSeenAt, latest.at)),
            or(isNull(agent.lastEventAt), lt(agent.lastEventAt, latest.at)),
          ),
        );
    }
    if (droppedEvents !== undefined) {
      // A cumulative count per boot: the largest one seen counts, so a retry counts once.
      await touchBoot(tx, agentId, droppedEvents.bootId, receivedAt);
      await tx
        .update(agentBoot)
        .set({ droppedEvents: sql`greatest(${agentBoot.droppedEvents}, ${droppedEvents.count})` })
        .where(and(eq(agentBoot.agentId, agentId), eq(agentBoot.bootId, droppedEvents.bootId)));
    }
    return { ok: true as const, results: results as EventResult[] };
  });
}
