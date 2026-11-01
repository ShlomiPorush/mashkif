import { isIPv4 } from "node:net";

/**
 * Writes a tiny MaxMind DB (MMDB format 2.0) for tests, so GeoIP tests need
 * no downloaded database: an IPv6 tree with 24-bit records, IPv4 networks
 * under ::/96, and GeoLite2-ASN style records.
 * Format: https://maxmind.github.io/MaxMind-DB/
 */

type Value =
  | string
  | { uint16: number }
  | { uint32: number }
  | { uint64: number }
  | Value[]
  | Entry;
type Entry = { [key: string]: Value };

function control(type: number, size: number): number[] {
  const bytes: number[] = [];
  let sizeBits = size;
  const extra: number[] = [];
  if (size >= 29) {
    sizeBits = 29;
    extra.push(size - 29);
  }
  if (type <= 7) {
    bytes.push((type << 5) | sizeBits);
  } else {
    bytes.push(sizeBits, type - 7);
  }
  return [...bytes, ...extra];
}

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  let rest = BigInt(value);
  while (rest > 0n) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return bytes;
}

function encode(value: Value): number[] {
  if (typeof value === "string") {
    const bytes = [...Buffer.from(value, "utf8")];
    return [...control(2, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) {
    return [...control(11, value.length), ...value.flatMap(encode)];
  }
  if ("uint16" in value && typeof value.uint16 === "number") {
    const bytes = unsigned(value.uint16);
    return [...control(5, bytes.length), ...bytes];
  }
  if ("uint32" in value && typeof value.uint32 === "number") {
    const bytes = unsigned(value.uint32);
    return [...control(6, bytes.length), ...bytes];
  }
  if ("uint64" in value && typeof value.uint64 === "number") {
    const bytes = unsigned(value.uint64);
    return [...control(9, bytes.length), ...bytes];
  }
  const entries = Object.entries(value as Entry);
  return [
    ...control(7, entries.length),
    ...entries.flatMap(([key, item]) => [...encode(key), ...encode(item)]),
  ];
}

function bitsOf(network: string): number[] {
  const [address = "", prefixText] = network.split("/");
  const bits: number[] = [];
  if (isIPv4(address)) {
    bits.push(...new Array(96).fill(0));
    for (const part of address.split(".")) {
      const byte = Number(part);
      for (let bit = 7; bit >= 0; bit--) {
        bits.push((byte >> bit) & 1);
      }
    }
    return bits.slice(0, 96 + Number(prefixText ?? 32));
  }
  const [head = "", tail] = address.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [
    ...front,
    ...new Array(tail === undefined ? 0 : 8 - front.length - back.length).fill("0"),
    ...back,
  ];
  for (const group of groups) {
    const word = Number.parseInt(group, 16);
    for (let bit = 15; bit >= 0; bit--) {
      bits.push((word >> bit) & 1);
    }
  }
  return bits.slice(0, Number(prefixText ?? 128));
}

interface TreeNode {
  children: [TreeNode | number | undefined, TreeNode | number | undefined];
}

export interface AsnRecord {
  network: string;
  asn: number;
  organization: string;
}

/** An MMDB file of database type GeoLite2-ASN holding the given networks. */
export function writeAsnDatabase(records: AsnRecord[], buildEpochSeconds: number): Buffer {
  const data: number[] = [];
  const root: TreeNode = { children: [undefined, undefined] };
  for (const record of records) {
    const offset = data.length;
    data.push(
      ...encode({
        autonomous_system_number: { uint32: record.asn },
        autonomous_system_organization: record.organization,
      }),
    );
    const bits = bitsOf(record.network);
    let node = root;
    bits.forEach((bit, index) => {
      const side = bit as 0 | 1;
      if (index === bits.length - 1) {
        node.children[side] = offset;
        return;
      }
      let next = node.children[side];
      if (typeof next !== "object") {
        next = { children: [undefined, undefined] };
        node.children[side] = next;
      }
      node = next;
    });
  }

  const nodes: TreeNode[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift() as TreeNode;
    nodes.push(node);
    for (const child of node.children) {
      if (typeof child === "object") {
        queue.push(child);
      }
    }
  }
  const count = nodes.length;
  const tree: number[] = [];
  for (const node of nodes) {
    for (const child of node.children) {
      let record = count; // empty
      if (typeof child === "object") {
        record = nodes.indexOf(child);
      } else if (typeof child === "number") {
        record = count + 16 + child;
      }
      tree.push((record >> 16) & 0xff, (record >> 8) & 0xff, record & 0xff);
    }
  }

  const metadata = encode({
    node_count: { uint32: count },
    record_size: { uint16: 24 },
    ip_version: { uint16: 6 },
    database_type: "GeoLite2-ASN",
    languages: ["en"],
    binary_format_major_version: { uint16: 2 },
    binary_format_minor_version: { uint16: 0 },
    build_epoch: { uint64: buildEpochSeconds },
    description: { en: "Mashkif test database" },
  });
  return Buffer.from([
    ...tree,
    ...new Array(16).fill(0),
    ...data,
    0xab,
    0xcd,
    0xef,
    ...Buffer.from("MaxMind.com", "ascii"),
    ...metadata,
  ]);
}
