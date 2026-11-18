import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { manifestText, parseManifest, readApprovals } from "../src/approvals.ts";
import { chooseSignersPath, DEFAULT_SIGNERS } from "../src/verify.ts";
import { signCards, withWorld, writeCard } from "./support.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("a manifest is one sorted line per card", () => {
  const text = manifestText([
    { id: "T-02", hash: HASH_B },
    { id: "T-01", hash: HASH_A },
  ]);
  assert.equal(text, `T-01 ${HASH_A}\nT-02 ${HASH_B}\n`);
  assert.deepEqual(parseManifest(text), [
    { id: "T-01", hash: HASH_A },
    { id: "T-02", hash: HASH_B },
  ]);
});

test("a manifest in any other shape is rejected", () => {
  const bad = [
    "",
    `T-01 ${HASH_A}`,
    `T-02 ${HASH_B}\nT-01 ${HASH_A}\n`,
    `T-01 ${HASH_A}\nT-01 ${HASH_B}\n`,
    `T-01 ${HASH_A.slice(1)}\n`,
    `T-01 ${HASH_A.toUpperCase()}\n`,
    `T-01  ${HASH_A}\n`,
    `T-01 ${HASH_A} extra\n`,
    `T-01 ${HASH_A}\n\n`,
    `../T-01 ${HASH_A}\n`,
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
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: false"]);
    assert.equal(signCards(world).exitCode, 0);
    const folder = join(world.repo, "laws", "approvals");
    writeFileSync(join(folder, "unsigned.manifest"), `A-01 ${HASH_A}\n`);
    writeFileSync(join(folder, "garbled.manifest"), "approve everything\n");
    writeFileSync(join(folder, "garbled.manifest.sig"), "not a signature\n");
    writeFileSync(join(folder, "forged.manifest"), `A-01 ${HASH_B}\n`);
    writeFileSync(join(folder, "forged.manifest.sig"), "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n");
    mkdirSync(join(folder, "a-folder.manifest.d"));

    const approvals = readApprovals(world.repo, world.signers);
    assert.equal(approvals.lines.size, 1, "only the signed manifest counts");
    assert.deepEqual([...approvals.ids], ["A-01"]);
    assert.equal(approvals.notes.length, 3);
    assert.match(approvals.notes.join("\n"), /unsigned\.manifest is ignored: it has no \.sig file/);
    assert.match(approvals.notes.join("\n"), /garbled\.manifest is ignored: "approve everything" is not "<id> <hash>"/);
    assert.match(approvals.notes.join("\n"), /forged\.manifest is ignored: its signing key is not in/);
  }),
);
