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
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
};

export type SessionInfo =
  | { state: "none"; ended?: "idle" | "max_age" | "invalid" }
  | {
      state: "enrollment" | "full";
      username: string;
      method: "password" | "totp" | "passkey";
      maxAgeAt: string;
      idleAt: string;
    };

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  ipAddress: string | null;
  details: Record<string, unknown> | null;
}
