import { createHash } from "node:crypto";

export type FrozenFile = { path: string; bytes: Uint8Array };

const FORMAT = "laws card hash v0";

// The hash of a card: sha256 over the card file and every frozen file, in path order.
// Each part goes in as an 8-byte length followed by its bytes. Without the lengths, moving a byte
// from the end of one part to the start of the next would give the same stream and the same hash.
export function hashCard(cardBytes: Uint8Array, frozen: FrozenFile[]): string {
  const sorted = [...frozen].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  const add = (part: Uint8Array): void => {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(part.length));
    hash.update(length);
    hash.update(part);
  };

  add(new TextEncoder().encode(FORMAT));
  add(cardBytes);
  let previous: string | null = null;
  for (const file of sorted) {
    if (file.path === previous) throw new Error(`frozen file listed twice: ${file.path}`);
    previous = file.path;
    add(new TextEncoder().encode(file.path));
    add(file.bytes);
  }
  return hash.digest("hex");
}
