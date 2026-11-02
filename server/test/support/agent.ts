import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { enrollmentKey } from "../../src/db/schema.js";
import { hashToken } from "../../src/http/token-hash.js";
import type { TestDatabase } from "./database.js";
import { type Browser, enrollTotp, type Harness, ORIGIN, setUpAdmin } from "./harness.js";

/** Creates an enrollment key directly in the database; returns the secret. */
export async function insertKey(
  database: TestDatabase,
  options: { expiresAt?: Date; revokedAt?: Date; label?: string } = {},
): Promise<string> {
  const secret = randomBytes(24).toString("base64url");
  await database.db.insert(enrollmentKey).values({
    label: options.label ?? "test PC",
    keyHash: hashToken(secret),
    createdBy: "shlomi",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: options.revokedAt ?? null,
  });
  return secret;
}

export interface HeartbeatBody {
  sequence: number;
  bootId: string;
  areaCell: string | null;
  infrastructure: string;
  intervalSeconds: number;
  roundTripMs: number | null;
  dnsMs: number | null;
  agentVersion?: string;
}

export interface EventBody {
  id: string;
  kind: string;
  bootId: string;
  syncId: string | null;
  elapsedMs: number | null;
}

export interface AgentReply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

/** An agent talking to the app in-process, as the Windows agent would. */
export class TestAgent {
  token = randomBytes(32).toString("base64url");
  installId = randomUUID();
  bootId = randomUUID();
  sequence = 0;
  agentId: string | undefined;
  /** The sync ID of the last heartbeat response received. */
  syncId: string | null = null;
  interval = 60;

  constructor(
    private readonly harness: Harness,
    /** The TCP peer address of this agent's requests. */
    public address = "203.0.113.5",
  ) {}

  async post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<AgentReply> {
    const response = await this.harness.app.request(`${ORIGIN}/api/agent${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mashkif-protocol-version": "1",
        "x-test-client": this.address,
        authorization: `Bearer ${this.token}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return {
      status: response.status,
      body: parsed as Record<string, unknown>,
      headers: response.headers,
    };
  }

  register(key: string, overrides: Record<string, unknown> = {}) {
    return this.post("/register", {
      enrollmentKey: key,
      installId: this.installId,
      token: this.token,
      agentVersion: "0.1.0",
      osVersion: "10.0.26100",
      ...overrides,
    });
  }

  /** Registers with a fresh key and checks it worked. */
  async enroll(database: TestDatabase): Promise<this> {
    const reply = await this.register(await insertKey(database));
    expect(reply.status).toBe(201);
    this.agentId = String(reply.body.agentId);
    return this;
  }

  heartbeatBody(overrides: Partial<HeartbeatBody> = {}): HeartbeatBody {
    return {
      sequence: this.sequence,
      bootId: this.bootId,
      areaCell: null,
      infrastructure: "unknown",
      intervalSeconds: this.interval,
      roundTripMs: 40,
      dnsMs: 5,
      ...overrides,
    };
  }

  /** Sends the next heartbeat; when the answer arrives, takes its sync ID and interval. */
  async heartbeat(
    overrides: Partial<HeartbeatBody> = {},
    { lose = false } = {},
  ): Promise<AgentReply> {
    this.sequence += 1;
    const reply = await this.post("/heartbeat", this.heartbeatBody(overrides));
    if (reply.status === 200 && !lose) {
      this.syncId = String(reply.body.syncId);
      this.interval = Number(reply.body.nextIntervalSeconds);
    }
    return reply;
  }

  /** An event after `elapsedMs` since the last sync received in this boot. */
  event(kind: string, elapsedMs: number | null, overrides: Partial<EventBody> = {}): EventBody {
    return {
      id: randomUUID(),
      kind,
      bootId: this.bootId,
      syncId: elapsedMs === null ? null : this.syncId,
      elapsedMs,
      ...overrides,
    };
  }

  events(events: unknown[], droppedEvents?: { bootId: string; count: number }) {
    return this.post(
      "/events",
      droppedEvents === undefined ? { events } : { events, droppedEvents },
    );
  }

  /** A reboot: a new boot ID, and no sync in this boot yet. */
  reboot(): void {
    this.bootId = randomUUID();
    this.syncId = null;
  }
}

/** The admin with a full session (password plus TOTP). */
export async function fullAdmin(harness: Harness): Promise<Browser> {
  const browser = await setUpAdmin(harness);
  await enrollTotp(browser);
  expect(await browser.sessionState()).toBe("full");
  return browser;
}
