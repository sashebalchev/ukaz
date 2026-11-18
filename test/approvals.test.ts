import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { manifestText, parseManifest, readApprovals } from "../src/approvals.ts";
import { chooseSignersPath, DEFAULT_SIGNERS } from "../src/verify.ts";
import { GOOD, signCards, withWorld, writeCard } from "./support.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const TIME = "2026-11-18T09:15:00.123Z";

test("a manifest is the time it was signed, then one sorted line per card", () => {
  const entries = [
    { id: "T-02", hash: HASH_B },
    { id: "T-03", hash: null },
    { id: "T-01", hash: HASH_A },
  ];
  const text = manifestText(TIME, entries);
  assert.equal(text, `signed: ${TIME}\nT-01 ${HASH_A}\nT-02 ${HASH_B}\nT-03 retired\n`);
  assert.deepEqual(parseManifest(text), {
    time: TIME,
    entries: [
      { id: "T-01", hash: HASH_A },
      { id: "T-02", hash: HASH_B },
      { id: "T-03", hash: null },
    ],
  });
});

test("a manifest in any other shape is rejected", () => {
  const head = `signed: ${TIME}\n`;
  const bad = [
    "",
    head,
    `T-01 ${HASH_A}\n`,
    `signed: 2026-11-18 09:15\nT-01 ${HASH_A}\n`,
    `# signed: ${TIME}\nT-01 ${HASH_A}\n`,
    `${head}T-01 ${HASH_A}`,
    `${head}T-02 ${HASH_B}\nT-01 ${HASH_A}\n`,
    `${head}T-01 ${HASH_A}\nT-01 ${HASH_B}\n`,
    `${head}T-01 ${HASH_A}\nT-01 retired\n`,
    `${head}T-01 ${HASH_A.slice(1)}\n`,
    `${head}T-01 ${HASH_A.toUpperCase()}\n`,
    `${head}T-01  ${HASH_A}\n`,
    `${head}T-01 ${HASH_A} extra\n`,
    `${head}T-01 Retired\n`,
    `${head}T-01 ${HASH_A}\n\n`,
    `${head}../T-01 ${HASH_A}\n`,
    `${head}T-01 ${HASH_A}\n${head}`,
  ];
  for (const text of bad) assert.throws(() => parseManifest(text), undefined, JSON.stringify(text));
});

test("the signers file is the flag, else LAWS_SIGNERS, else the file in /etc", () => {
  assert.equal(DEFAULT_SIGNERS, "/etc/laws/allowed_signers");
  assert.equal(chooseSignersPath("/a/flag", "/a/variable"), "/a/flag");
  assert.equal(chooseSignersPath(null, "/a/variable"), "/a/variable");
  assert.equal(chooseSignersPath(null, undefined), DEFAULT_SIGNERS);
  assert.equal(chooseSignersPath(null, ""), DEFAULT_SIGNERS);
});

test(
  "manifests without a good signature are ignored, with a note that says why",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    assert.equal(signCards(world).exitCode, 0);
    const folder = join(world.repo, "laws", "approvals");
    writeFileSync(join(folder, "unsigned.manifest"), `signed: ${TIME}\nA-01 ${HASH_A}\n`);
    writeFileSync(join(folder, "garbled.manifest"), "approve everything\n");
    writeFileSync(join(folder, "garbled.manifest.sig"), "not a signature\n");
    writeFileSync(join(folder, "forged.manifest"), `signed: ${TIME}\nA-01 ${HASH_B}\nA-02 retired\n`);
    writeFileSync(join(folder, "forged.manifest.sig"), "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n");
    mkdirSync(join(folder, "a-folder.manifest.d"));

    const approvals = readApprovals(world.repo, world.signers);
    assert.deepEqual([...approvals.live.keys()], ["A-01"], "only the signed manifest counts");
    assert.equal(approvals.live.get("A-01")?.size, 1);
    assert.deepEqual([...approvals.retired], []);
    assert.equal(approvals.notes.length, 3);
    assert.match(approvals.notes.join("\n"), /unsigned\.manifest is ignored: it has no \.sig file/);
    assert.match(approvals.notes.join("\n"), /garbled\.manifest is ignored: its first line is not "signed: <UTC time>"/);
    assert.match(approvals.notes.join("\n"), /forged\.manifest is ignored: its signing key is not in/);
  }),
);
