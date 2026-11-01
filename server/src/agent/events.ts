import type { components } from "@mashkif/contracts";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent, agentEvent, heartbeat, type TimeUncertainReason } from "../db/schema.js";
import { type EventInput, parseEvent } from "./parse.js";

export type EventResult = components["schemas"]["EventResult"];

/** Events older than this do not refine history (the backfill window). */
export const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface Sync {
  receivedAt: Date;
  bootId: string;
}

export interface EventTime {
  occurredAt: Date | null;
  uncertain: TimeUncertainReason | null;
}

/**
 * The time of an event: the server time recorded for its sync ID plus the
 * monotonic time elapsed since. It is uncertain when the event has no sync
 * in its own boot (a reboot while offline), names an unknown sync, would be
 * later than the moment the server received it, or is older than the
 * backfill window. Uncertain events do not refine history.
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
  const occurredAt = new Date(sync.receivedAt.getTime() + event.elapsedMs);
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
 * state of an agent that has reported since.
 */
export async function recordEvents(
  db: Db,
  agentId: string,
  rawEvents: unknown[],
  droppedEvents: number,
  receivedAt: Date,
): Promise<EventResult[]> {
  const parsed = rawEvents.map(parseEvent);
  const syncIds = [
    ...new Set(
      parsed.flatMap((item) => (item.ok && item.event.syncId !== null ? [item.event.syncId] : [])),
    ),
  ];

  return db.transaction(async (tx) => {
    const syncs = new Map<string, Sync>();
    if (syncIds.length > 0) {
      const rows = await tx
        .select({
          syncId: heartbeat.syncId,
          receivedAt: heartbeat.receivedAt,
          bootId: heartbeat.bootId,
        })
        .from(heartbeat)
        .where(and(eq(heartbeat.agentId, agentId), inArray(heartbeat.syncId, syncIds)));
      for (const row of rows) {
        syncs.set(row.syncId, { receivedAt: row.receivedAt, bootId: row.bootId });
      }
    }

    const results: (EventResult | undefined)[] = [];
    const rows: (typeof agentEvent.$inferInsert)[] = [];
    const pending: { index: number; event: EventInput; time: EventTime }[] = [];
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
      seen.add(event.id);
      const sync = event.syncId === null ? undefined : syncs.get(event.syncId);
      const time = eventTime(event, sync, receivedAt);
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
        agentTime: event.agentTime,
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
    if (droppedEvents > 0) {
      await tx
        .update(agent)
        .set({ droppedEvents: sql`${agent.droppedEvents} + ${droppedEvents}` })
        .where(eq(agent.id, agentId));
    }
    return results as EventResult[];
  });
}
