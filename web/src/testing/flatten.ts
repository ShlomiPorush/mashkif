type Tree = { [key: string]: string | Tree };

/** Flattens a locale tree into dotted keys and their values. */
export function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") {
      entries.set(path, value);
    } else {
      for (const [nested, text] of flatten(value, path)) {
        entries.set(nested, text);
      }
    }
  }
  return entries;
}
