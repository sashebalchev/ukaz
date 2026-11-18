import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { manifestText } from "../src/approvals.ts";
import { loadCards, readCardFiles } from "../src/cards.ts";
import { manifestOf, MAX_CARDS, readRequest, RequestError, requestText } from "../src/request.ts";
import type { RequestCard } from "../src/request.ts";
import { GOOD, withWorld, writeCard } from "./support.ts";

function card(id: string, frontMatter: string[] = ["grade: prose"], files: RequestCard["files"] = []): RequestCard {
  const text = `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n# ${id} The law of ${id}\n`;
  return { id, retire: false, card: Buffer.from(text), files };
}

function refusal(cards: RequestCard[]): string {
  try {
    readRequest(requestText(cards));
  } catch (error) {
    if (error instanceof RequestError) return error.message;
    throw error;
  }
  return "it was accepted";
}

test(
  "a request carries the bytes, and its reader computes the same hashes as the laws command",
  withWorld((world) => {
    writeCard(world, "A-02", [...GOOD, "frozen: [checks/a02.txt]", "figure: figures/A-02.spec.json"], "# A-02 With a picture\n");
    writeCard(world, "A-01", GOOD, "# A-01 Plain\n");
    mkdirSync(join(world.repo, "checks"));
    mkdirSync(join(world.repo, "figures"));
    writeFileSync(join(world.repo, "checks", "a02.txt"), "a check\n");
    writeFileSync(join(world.repo, "figures", "A-02.spec.json"), "{}\n");
    writeFileSync(join(world.repo, "figures", "A-02.txt"), "a picture\n");

    const sent = ["A-02", "A-01"].map((id) => {
      const { cardBytes, files } = readCardFiles(world.repo, id);
      return { id, retire: false, card: cardBytes, files };
    });
    const read = readRequest(requestText(sent));
    const local = loadCards(world.repo).map((loaded) => (loaded.ok ? { id: loaded.id, hash: loaded.hash, title: loaded.card.title } : null));
    assert.deepEqual(read.map(({ id, hash, title }) => ({ id, hash, title })), local, "sorted by id, with the hashes of the laws command");
    assert.deepEqual(read[1]?.files.map((file) => file.path), ["checks/a02.txt", "figures/A-02.spec.json", "figures/A-02.txt"]);

    // The rendered picture is hashed when it is sent, and may be left out when it does not exist.
    const withoutPicture = sent.map((one) => ({ ...one, files: one.files.filter((file) => file.path !== "figures/A-02.txt") }));
    assert.notEqual(readRequest(requestText(withoutPicture))[1]?.hash, read[1]?.hash);

    // A card to retire has no hash. Its manifest line says "retired", as approvals.ts writes it.
    const retiring = readRequest(requestText([{ ...sent[1], files: [], retire: true } as RequestCard, sent[0] as RequestCard]));
    assert.deepEqual(retiring.map((line) => line.hash), [null, read[1]?.hash]);
    const time = "2026-11-18T09:15:00.123Z";
    assert.equal(manifestOf(time, retiring), manifestText(time, retiring));
    assert.equal(manifestOf(time, retiring), `signed: ${time}\nA-01 retired\nA-02 ${read[1]?.hash}\n`);
  }),
);

test("a request that is not exact is refused, with the reason", () => {
  const megabyte = new Uint8Array(1024 * 1024);
  const frozen = (path: string): string[] => ["grade: chosen", `frozen: [${path}]`];
  assert.equal(readRequest(requestText([card("A-01", frozen("a.txt"), [{ path: "a.txt", bytes: megabyte }])])).length, 1, "exactly 1 MB is accepted");

  assert.match(refusal([card("A-01", frozen("a.txt"), [{ path: "a.txt", bytes: new Uint8Array(1024 * 1024 + 1) }])]), /larger than 1 MB/);
  assert.match(refusal([card("A-01", frozen("a.txt"))]), /a\.txt was not sent/);
  assert.match(refusal([card("A-01", ["grade: prose"], [{ path: "a.txt", bytes: megabyte }])]), /the card does not name it/);
  assert.match(refusal([card("A-01"), card("A-01")]), /A-01 is in the request twice/);
  assert.match(refusal([{ ...card("A-01"), id: "A-02" }]), /A-02 is not a valid card: id "A-01" does not match/);
  assert.match(refusal([{ ...card("A-01"), card: Buffer.from("no front matter\n") }]), /not a valid card/);
  assert.match(refusal([{ ...card("A-01", frozen("a.txt"), [{ path: "a.txt", bytes: megabyte }]), retire: true }]), /comes without other files/);
  assert.match(refusal([]), /names no card/);
  assert.match(refusal(Array.from({ length: MAX_CARDS + 1 }, (_, n) => card(`A-${n}`))), /more than 100 cards/);

  // Nine cards with nearly one megabyte each are more than the files of a request may hold together.
  const large = new Uint8Array(950_000);
  const nine = Array.from({ length: 9 }, (_, n) => card(`A-0${n}`, frozen("a.txt"), [{ path: "a.txt", bytes: large }]));
  assert.match(refusal(nine), /larger than 8 MB together/);
  assert.match(refusal([...nine, ...nine.map((one) => ({ ...one, id: `B${one.id}` }))]), /the request is too large/);

  const good = JSON.parse(requestText([card("A-01")])) as { cards: Record<string, unknown>[] };
  const bad: unknown[] = [
    [],
    { cards: good.cards, more: 1 },
    { cards: "A-01" },
    { cards: [{ ...good.cards[0], card: undefined }] },
    { cards: [{ ...good.cards[0], card: `${String(good.cards[0]?.["card"])}\n` }] },
    { cards: [{ ...good.cards[0], files: [{ path: "a.txt" }] }] },
    { cards: [{ ...good.cards[0], files: [{ path: 7, bytes: "" }] }] },
    { cards: [{ ...good.cards[0], id: 7 }] },
    { cards: [[]] },
  ];
  for (const value of bad) assert.throws(() => readRequest(JSON.stringify(value)), RequestError, JSON.stringify(value).slice(0, 100));
  assert.throws(() => readRequest("{"), RequestError);
});
