/** A refusal or failure from the admin API, with the server's stable error code. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "AdminApiError";
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/admin${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new AdminApiError(0, "network");
  }
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = (data as { error?: unknown }).error;
    throw new AdminApiError(response.status, typeof code === "string" ? code : "unexpected");
  }
  return data as T;
}

export const adminApi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
};

export type TrustTier = "trusted" | "normal" | "suspicious" | "blocked";
export type Infrastructure =
  | "unknown"
  | "bezeq"
  | "hot"
  | "ibc"
  | "partner_fiber"
  | "cellcom_fiber"
  | "other";

export interface AgentSummary {
  id: string;
  label: string | null;
  trustTier: TrustTier;
  agentVersion: string;
  osVersion: string | null;
  registeredAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  address: string | null;
  siteKey: string | null;
  asn: number | null;
  asOrganization: string | null;
  providerName: string | null;
  reportedCell: string | null;
  assignedCell: string | null;
  infrastructure: Infrastructure;
  silenceIntervalSeconds: number | null;
  lastEventKind: string | null;
  lastEventAt: string | null;
  droppedEvents: number | string;
}

export interface EnrollmentKeySummary {
  id: number;
  label: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  agentId: string | null;
  status: "active" | "used" | "expired" | "revoked";
}

export interface BlockedRange {
  id: number;
  range: string;
  note: string;
  createdAt: string;
  createdBy: string;
}

export interface Provider {
  id: number;
  name: string;
  asns: number[];
}

export type SettingApply = "now" | "restart" | "next_email";

/** The settings as the server shows them; the SMTP password only as set or not. */
export interface AdminSettings {
  heartbeatIntervalSeconds: number;
  retentionDays: number;
  publicUrl: string;
  trustedOrigins: string[];
  trustedProxies: string[];
  sessionHours: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPasswordSet: boolean;
  smtpFrom: string;
  /** Settings an environment variable sets; the panel shows them locked. */
  locked: string[];
  apply: Record<string, SettingApply>;
  /** The environment variable that may set each setting. */
  env: Record<string, string>;
  geoip?: { state: "ok" | "unavailable"; buildDate: string | null; stale: boolean };
}

/** The admin's Better Auth session: none, without TOTP yet (enrollment), or with TOTP (full). */
export type SessionInfo =
  | { state: "none" }
  | { state: "enrollment" | "full"; username: string; email: string };
