import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

// A software authenticator that builds WebAuthn responses by hand, so tests
// can choose the flags a real authenticator would set: user presence (UP),
// user verification (UV), and attested credential data (AT).

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [key: string]: Cbor };

function cborHead(major: number, value: number): Buffer {
  if (value < 24) {
    return Buffer.from([(major << 5) | value]);
  }
  if (value < 0x100) {
    return Buffer.from([(major << 5) | 24, value]);
  }
  if (value < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(value, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(value, 1);
  return head;
}

/** Minimal CBOR encoder (RFC 8949) for attestation objects and COSE keys. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

export interface Ceremony {
  origin: string;
  rpId: string;
  /** The challenge from the options the server generated (base64url). */
  challenge: string;
  userVerified: boolean;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #counter = 0;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  #clientData(type: string, ceremony: Ceremony): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge: ceremony.challenge,
        origin: ceremony.origin,
        crossOrigin: false,
      }),
    );
  }

  #flags(ceremony: Ceremony, extra = 0): number {
    return FLAG_UP | extra | (ceremony.userVerified ? FLAG_UV : 0);
  }

  /** A RegistrationResponseJSON with attestation "none". */
  register(ceremony: Ceremony) {
    const jwk = this.#publicKey.export({ format: "jwk" });
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      sha256(ceremony.rpId),
      Buffer.from([this.#flags(ceremony, FLAG_AT)]),
      counter,
      Buffer.alloc(16), // AAGUID: none
      idLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.#clientData("webauthn.create", ceremony)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** An AuthenticationResponseJSON signed with this credential. */
  authenticate(ceremony: Ceremony) {
    this.#counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([
      sha256(ceremony.rpId),
      Buffer.from([this.#flags(ceremony)]),
      counter,
    ]);
    const clientData = this.#clientData("webauthn.get", ceremony);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientData)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
