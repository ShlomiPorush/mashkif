import { createHash } from "node:crypto";

/** SHA-256 of a secret token, for the agent token and enrollment keys. Only the hash is stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
