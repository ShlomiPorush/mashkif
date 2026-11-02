import type { components } from "@mashkif/contracts";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent, agentEvent, syncAnchor, type TimeUncertainReason } from "../db/schema.js";
import { recordDroppedEvents } from "./boots.js";
import { type DroppedEvents, type EventInput, parseEvent } from "./parse.js";
import { guardAgentWrite, type WriteRefusal } from "./write-guard.js";

export type EventResult = components["schemas"]["EventResult"];

/** Events older than this do not refine history (the backfill window). */
export const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Length of an event budget window. */
export const EVENT_WINDOW_MS = 60 * 60 * 1000;

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

/** The hourly event budgets of the settings. */
export interface EventBudgets {
  perAgentHour: number;
  perLowAgentHour: number;
}

export type RecordedEvents =
  | { ok: true; results: EventResult[]; retryAfterSeconds?: number }
  | { ok: false; error: WriteRefusal };

/**
 * Stores a batch of events, each judged on its own, and answers one result
 * per event in request order. The latest event with a certain time becomes
 * the agent's current state only when it is later than both the agent's
 * latest heartbeat and its current event, so a late event never changes the
 * state of an agent that has reported since. The transaction first checks,
 * under the agent row lock, that the agent may still write.
 *
 * Event budget: an agent stores at most its budget of events per hour of
 * database time. The window and its count live on the agent row and change
 * only under its lock, so concurrent requests of one agent never store more
 * than the budget. The window moves only forward: a request with an earlier
 * clock reading, or a clock set back, counts against the stored window. An
 * event that is already stored is `duplicate`, an invalid one `rejected`;
 * neither costs budget. New events past the budget are `deferred`, are not
 * stored, and the response says when the budget renews. An ID repeated
 * within one request gets the result of its first occurrence.
 */
export async function recordEvents(
  db: Db,
  agentId: string,
  address: string,
  rawEvents: unknown[],
  droppedEvents: DroppedEvents | undefined,
  receivedAt: Date,
  budgets: EventBudgets,
): Promise<RecordedEvents> {
  const parsed = rawEvents.map(parseEvent);
  const syncIds = [
    ...new Set(
      parsed.flatMap((item) => (item.ok && item.event.syncId !== null ? [item.event.syncId] : [])),
    ),
  ];
  const eventIds = [...new Set(parsed.flatMap((item) => (item.ok ? [item.event.id] : [])))];

  return db.transaction(async (tx): Promise<RecordedEvents> => {
    const refusal = await guardAgentWrite(tx, agentId, address);
    if (refusal !== undefined) {
      return { ok: false, error: refusal };
    }

    // The window time is read after the lock, from the database clock.
    const [budgetRow] = await tx
      .select({
        nowMs: sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number),
        hourMs: sql<number>`(extract(epoch from date_trunc('hour', now())) * 1000)::float8`.mapWith(
          Number,
        ),
        windowStart: agent.eventWindowStart,
        windowCount: agent.eventWindowCount,
        trustTier: agent.trustTier,
      })
      .from(agent)
      .where(eq(agent.id, agentId));
    if (budgetRow === undefined) {
      return { ok: false, error: "agent_missing" };
    }
    let windowStart = budgetRow.windowStart;
    let windowCount = budgetRow.windowCount;
    if (windowStart === null || budgetRow.hourMs > windowStart.getTime()) {
      windowStart = new Date(budgetRow.hourMs);
      windowCount = 0;
    }
    const budget = budgetRow.trustTier === "low" ? budgets.perLowAgentHour : budgets.perAgentHour;
    let remaining = Math.max(0, budget - windowCount);

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

    // Already stored: the agent row lock keeps another request of this agent
    // from storing them between this read and the insert below.
    const stored = new Set<string>();
    if (eventIds.length > 0) {
      const rows = await tx
        .select({ eventId: agentEvent.eventId })
        .from(agentEvent)
        .where(and(eq(agentEvent.agentId, agentId), inArray(agentEvent.eventId, eventIds)));
      for (const row of rows) {
        stored.add(row.eventId);
      }
    }

    const results: EventResult[] = [];
    const first = new Map<string, EventResult>();
    const rows: (typeof agentEvent.$inferInsert)[] = [];
    const accepted: { event: EventInput; time: ValidTime }[] = [];
    let deferred = false;
    for (const item of parsed) {
      if (!item.ok) {
        results.push({ id: item.id, status: "rejected", error: item.error });
        continue;
      }
      const { event } = item;
      const earlier = first.get(event.id);
      if (earlier !== undefined) {
        // A repeat within this request: stored by its first occurrence, or not.
        results.push(
          earlier.status === "accepted" || earlier.status === "duplicate"
            ? { id: event.id, status: "duplicate" }
            : { ...earlier },
        );
        continue;
      }
      let result: EventResult;
      if (stored.has(event.id)) {
        result = { id: event.id, status: "duplicate" };
      } else {
        const sync = event.syncId === null ? undefined : syncs.get(event.syncId);
        const time = eventTime(event, sync, receivedAt);
        if ("invalid" in time) {
          result = { id: event.id, status: "rejected", error: "event_invalid" };
        } else if (remaining === 0) {
          result = { id: event.id, status: "deferred" };
          deferred = true;
        } else {
          remaining -= 1;
          result = { id: event.id, status: "accepted", timeUncertain: time.uncertain !== null };
          accepted.push({ event, time });
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
        }
      }
      first.set(event.id, result);
      results.push(result);
    }

    if (rows.length > 0) {
      await tx
        .insert(agentEvent)
        .values(rows)
        .onConflictDoNothing({ target: [agentEvent.agentId, agentEvent.eventId] });
    }
    await tx
      .update(agent)
      .set({ eventWindowStart: windowStart, eventWindowCount: windowCount + rows.length })
      .where(eq(agent.id, agentId));

    let latest: { kind: EventInput["kind"]; at: Date } | undefined;
    for (const { event, time } of accepted) {
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
      await recordDroppedEvents(tx, agentId, droppedEvents, receivedAt);
    }
    if (!deferred) {
      return { ok: true, results };
    }
    // From the stored window end, so a clock set back never gives 0 or less.
    const renewsInMs = windowStart.getTime() + EVENT_WINDOW_MS - budgetRow.nowMs;
    const retryAfterSeconds = Math.min(3600, Math.max(1, Math.ceil(renewsInMs / 1000)));
    return { ok: true, results, retryAfterSeconds };
  });
}
