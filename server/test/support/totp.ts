import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      throw new Error("invalid base32");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The secret of an otpauth:// URI, as an authenticator app reads it. */
export function secretFromUri(uri: string): Buffer {
  const secret = new URL(uri).searchParams.get("secret");
  if (secret === null) {
    throw new Error("the TOTP URI has no secret");
  }
  return base32Decode(secret);
}

/** A 6-digit RFC 6238 code (SHA-1, 30-second steps), like an authenticator app. */
export function totpCode(secret: Buffer, at = Date.now(), stepOffset = 0): string {
  const counter = Math.floor(at / 30_000) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}
