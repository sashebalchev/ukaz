import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../src/cards.ts";
import { GOOD, laws, lawsRaw, retireCards, signCards, withWorld, writeCard } from "./support.ts";
import type { World } from "./support.ts";

// The words of the status line of one card: id, grade, state, and the title as the rest.
function statusOf(world: World, id: string): string[] {
  const line = laws(world, ["status"]).printed.split("\n").find((candidate) => candidate.startsWith(`${id} `));
  return line?.split(/\s+/) ?? [];
}

function approvals(world: World): string[] {
  const folder = join(world.repo, "laws", "approvals");
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

test(
  "status: waiting, then approved, then changed",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD, "# A-01 Start only when ready\n");
    writeCard(world, "A-02", ["grade: prose"], "Words.\n\n# A-02 Be kind\n");
    assert.deepEqual(statusOf(world, "A-01"), ["A-01", "chosen", "waiting", "Start", "only", "when", "ready"]);
    assert.deepEqual(statusOf(world, "A-02"), ["A-02", "prose", "waiting", "Be", "kind"]);

    assert.equal(signCards(world).exitCode, 0);
    assert.equal(statusOf(world, "A-01")[2], "approved");
    assert.equal(statusOf(world, "A-02")[2], "approved");

    appendFileSync(join(world.repo, "laws", "A-02.md"), "x");
    assert.equal(statusOf(world, "A-01")[2], "approved");
    assert.equal(statusOf(world, "A-02")[2], "changed");
    assert.equal(laws(world, ["status"]).exitCode, 0, "status only reports");
  }),
);

test(
  "status without a signers file shows unverified and says why",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    assert.equal(signCards(world).exitCode, 0);
    const missing = join(world.folder, "no-such-file");
    const { exitCode, printed } = lawsRaw(["status", "--repo", world.repo, "--signers", missing]);
    assert.equal(exitCode, 0);
    assert.match(printed, /^A-01 +chosen +unverified /m);
    assert.match(printed, /unverified: no signers file at .*no-such-file/);

    const inside = join(world.repo, "signers");
    writeFileSync(inside, readFileSync(world.signers));
    const refused = lawsRaw(["status", "--repo", world.repo], { LAWS_SIGNERS: inside });
    assert.match(refused.printed, /^A-01 +chosen +unverified /m);
    assert.match(refused.printed, /inside the repository/);
  }),
);

test(
  "status shows a broken card with what is wrong",
  withWorld((world) => {
    writeCard(world, "A-01", [...GOOD, "frozen: [missing.txt]"]);
    writeCard(world, "A-02", [...GOOD, "mood: good"]);
    writeCard(world, "A-03", [...GOOD, "figure: figures/A-03.spec.json"]);
    const { printed } = laws(world, ["status"]);
    assert.match(printed, /^A-01 .* broken .*missing\.txt is missing or cannot be read/m);
    assert.match(printed, /^A-02 .* broken .*unknown key "mood"/m);
    assert.match(printed, /^A-03 .* broken .*figures\/A-03\.spec\.json is missing or cannot be read/m);
    assert.equal(laws(world, ["gate"]).exitCode, 1);
  }),
);

test(
  "show prints the card, and the figure text if it is rendered",
  withWorld((world) => {
    writeCard(world, "A-01", [...GOOD, "figure: figures/A-01.spec.json"], "# A-01 Two ports\n\n**Law.** Two ports.\n");
    const plain = laws(world, ["show", "A-01"]);
    assert.equal(plain.exitCode, 0);
    assert.equal(plain.printed, `${readFileSync(join(world.repo, "laws", "A-01.md"), "utf8")}`);

    mkdirSync(join(world.repo, "figures"));
    writeFileSync(join(world.repo, "figures", "A-01.spec.json"), "{}\n");
    writeFileSync(join(world.repo, "figures", "A-01.txt"), "tcp 22\nudp 41641\n");
    const withFigure = laws(world, ["show", "A-01"]);
    assert.match(withFigure.printed, /\*\*Law\.\*\* Two ports\.\n\ntcp 22\nudp 41641\n$/);
    assert.doesNotMatch(withFigure.printed, /\{\}/, "the spec itself is not printed");

    assert.equal(laws(world, ["show", "A-09"]).exitCode, 1);
    assert.equal(laws(world, ["show", "../A-01"]).exitCode, 1);
    assert.equal(laws(world, ["show"]).exitCode, 1);
  }),
);

test(
  "the figure is signed with the card: laws and the approver agree on the hash, and a redrawn picture needs a new signature",
  withWorld((world) => {
    writeCard(world, "A-01", [...GOOD, "figure: figures/A-01.spec.json"]);
    mkdirSync(join(world.repo, "figures"));
    writeFileSync(join(world.repo, "figures", "A-01.spec.json"), "{}\n");
    writeFileSync(join(world.repo, "figures", "A-01.txt"), "tcp 22\nudp 41641\n");
    const signed = signCards(world);
    assert.equal(signed.exitCode, 0, signed.printed);
    assert.equal(statusOf(world, "A-01")[2], "approved");
    writeFileSync(join(world.repo, "figures", "A-01.txt"), "tcp 22\ntcp 8101\n");
    assert.equal(statusOf(world, "A-01")[2], "changed");
  }),
);

test(
  "verify and gate give the same answer, each in its own words",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    const waiting = laws(world, ["verify"]);
    assert.equal(waiting.exitCode, 1);
    assert.match(waiting.printed, /^not verified\n +A-01: waiting: never approved\n$/);
    assert.match(laws(world, ["gate"]).printed, /^closed\n +A-01: waiting: never approved\n$/);

    assert.equal(signCards(world).exitCode, 0);
    assert.deepEqual(laws(world, ["verify"]), { exitCode: 0, printed: "verified: every card is approved as it is now\n" });
    assert.deepEqual(laws(world, ["gate"]), { exitCode: 0, printed: "open\n" });

    appendFileSync(join(world.repo, "laws", "A-01.md"), "x");
    assert.match(laws(world, ["verify"]).printed, /A-01: changed since it was approved/);
  }),
);

test(
  "sign: the given cards only, then the rest, then nothing",
  withWorld((world) => {
    for (const id of ["A-01", "A-02", "A-03"]) writeCard(world, id, GOOD);
    const one = signCards(world, ["A-02"]);
    assert.equal(one.exitCode, 0, one.printed);
    assert.match(one.printed, /sign +A-02 +[0-9a-f]{64} +A law/, "laws prints the list that the server computed: id, hash and title");
    assert.deepEqual(["A-01", "A-02", "A-03"].map((id) => statusOf(world, id)[2]), ["waiting", "approved", "waiting"]);

    const rest = signCards(world);
    assert.equal(rest.exitCode, 0, rest.printed);
    assert.doesNotMatch(readFileSync(world.log, "utf8").split("\n")[1] ?? "", /A-02/, "an approved card is not signed again");
    assert.equal(laws(world, ["gate"]).printed, "open\n");
    assert.equal(approvals(world).length, 4, "two batches, each a manifest and a signature");
    for (const name of approvals(world)) assert.match(name, /^\d{8}T\d{6}\.\d{3}Z\.manifest(\.sig)?$/);
    const manifest = readFileSync(join(world.repo, "laws", "approvals", approvals(world)[0] ?? ""), "utf8");
    assert.equal((approvals(world)[0] ?? "").slice(0, 20), manifest.slice(8, 32).replace(/[-:]/g, ""), "the name is the signed time");

    const nothing = signCards(world);
    assert.equal(nothing.exitCode, 0);
    assert.match(nothing.printed, /nothing to sign/);
    assert.equal(approvals(world).length, 4);
  }),
);

test(
  "sign: one toothless card stops the whole batch, and an unknown card is an error",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    writeCard(world, "A-02", ["grade: chosen", "check: true", "bite: true", "bite-says: anything"]);
    const refused = signCards(world);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.printed, /A-02 +TOOTHLESS/);
    assert.deepEqual(approvals(world), []);
    assert.ok(!existsSync(world.log), "nothing was offered to the approver");

    assert.equal(signCards(world, ["A-09"]).exitCode, 1);
    assert.equal(signCards(world, ["A-01"]).exitCode, 0, "the good card can still be signed by name");
  }),
);

test(
  "sign: the server can come from LAWS_SIGNER, and no signer is an error that says what to do",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    const none = lawsRaw(["sign", "--repo", world.repo, "--signers", world.signers]);
    assert.equal(none.exitCode, 1);
    assert.match(none.printed, /no signer: pass --server <address>, or set LAWS_SIGNER=server:<address>/);
    assert.deepEqual(approvals(world), []);

    const fromVariable = lawsRaw(["sign", "--phone", "--repo", world.repo, "--signers", world.signers], {
      LAWS_SIGNER: `server:${world.server}`,
    });
    assert.equal(fromVariable.exitCode, 0, fromVariable.printed);
    assert.equal(statusOf(world, "A-01")[2], "approved");
  }),
);

test(
  "sign: the scratch folder is removed afterwards, whether the signing worked or not",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    const scratch = join(world.folder, "tmp");
    mkdirSync(scratch);
    const environment = { TMPDIR: scratch };
    const signed = lawsRaw(["sign", "--server", world.server, "--phone", "--repo", world.repo, "--signers", world.signers], environment);
    assert.equal(signed.exitCode, 0, signed.printed);
    assert.deepEqual(readdirSync(scratch), [], "a scratch folder was left behind after a signing");

    // A signature that is not accepted: the stranger's key is not in the signers file.
    writeCard(world, "A-02", GOOD);
    const stranger = join(world.folder, "stranger-key");
    assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", stranger]).status, 0);
    const otherSigners = join(world.folder, "other_signers");
    writeFileSync(otherSigners, `owner ${readFileSync(`${stranger}.pub`, "utf8")}`);
    const refused = lawsRaw(["sign", "--server", world.server, "--phone", "--repo", world.repo, "--signers", otherSigners], environment);
    assert.equal(refused.exitCode, 1);
    assert.deepEqual(readdirSync(scratch), [], "a scratch folder was left behind after a refused signing");
  }),
);

test(
  "sign: a signature dated before the newest one here is not stored",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    writeCard(world, "A-02", GOOD);
    // An approval of A-01 by the right key, dated far in the future.
    const card = loadCards(world.repo)[0];
    assert.ok(card?.ok);
    const future = join(world.repo, "laws", "approvals", "future.manifest");
    mkdirSync(join(world.repo, "laws", "approvals"));
    writeFileSync(future, `signed: 2999-01-01T00:00:00.000Z\nA-01 ${card?.ok ? card.hash : ""}\n`);
    assert.equal(spawnSync("ssh-keygen", ["-Y", "sign", "-f", world.key, "-n", "laws", future]).status, 0);
    assert.equal(statusOf(world, "A-01")[2], "approved");

    const refused = signCards(world);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.printed, /not later than the newest one here/);
    assert.equal(approvals(world).length, 2, "nothing was stored");
  }),
);

test(
  "retire: a signed retirement lets the file go, and the card does not come back by itself",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    writeCard(world, "A-02", GOOD, "# A-02 Old rule\n");
    const card = readFileSync(join(world.repo, "laws", "A-02.md"));
    assert.equal(signCards(world).exitCode, 0);

    // Deleted without a retirement: missing.
    rmSync(join(world.repo, "laws", "A-02.md"));
    assert.deepEqual(statusOf(world, "A-02").slice(0, 3), ["A-02", "-", "missing"]);
    assert.match(laws(world, ["gate"]).printed, /^closed\n +A-02: missing: a signed approval names it/);
    assert.equal(laws(world, ["verify"]).exitCode, 1);
    assert.equal(retireCards(world, ["A-02"]).exitCode, 1, "a card that is gone cannot be retired");

    // Restored and retired: the signer shows it, and the file may go.
    writeFileSync(join(world.repo, "laws", "A-02.md"), card);
    const retired = retireCards(world, ["A-02"]);
    assert.equal(retired.exitCode, 0, retired.printed);
    assert.match(retired.printed, /^ *retire +A-02 +Old rule$/m, "laws prints what it asks to retire, with the title");
    assert.match(readFileSync(world.log, "utf8"), / signed A-02=retired\n$/, "the approver was asked to retire A-02 and nothing else");
    assert.equal(statusOf(world, "A-02")[2], "retired");
    assert.match(laws(world, ["gate"]).printed, /^closed\n +A-02: retired, but laws\/A-02\.md is still there/);
    assert.match(signCards(world).printed, /nothing to sign/, "a retired card is not signed again unless it is named");

    rmSync(join(world.repo, "laws", "A-02.md"));
    assert.equal(laws(world, ["gate"]).printed, "open\n");
    assert.deepEqual(statusOf(world, "A-02").slice(0, 3), ["A-02", "-", "retired"]);

    // The same file comes back: it needs a new signature, by name.
    writeFileSync(join(world.repo, "laws", "A-02.md"), card);
    assert.equal(laws(world, ["gate"]).exitCode, 1);
    assert.equal(signCards(world, ["A-02"]).exitCode, 0);
    assert.equal(statusOf(world, "A-02")[2], "approved");
    assert.equal(laws(world, ["gate"]).printed, "open\n");

    // The old retirement does not cover the new approval.
    rmSync(join(world.repo, "laws", "A-02.md"));
    assert.equal(statusOf(world, "A-02")[2], "missing");
    assert.equal(laws(world, ["gate"]).exitCode, 1);
    assert.equal(lawsRaw(["retire", "--server", world.server, "--phone", "--repo", world.repo, "--signers", world.signers]).exitCode, 1);
  }),
);

test(
  "bite: every bite must fail by itself, and say what the card says",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    writeCard(world, "A-02", ["grade: prose"]);
    const good = laws(world, ["bite"]);
    assert.equal(good.exitCode, 0, good.printed);
    assert.match(good.printed, /^A-01 +bites$/m);
    assert.match(good.printed, /^A-02 +prose, no bite$/m);
    assert.match(good.printed, /EVERY LAW BITES\n$/);

    const says = "bite-says: the blocked case was caught";
    writeCard(world, "A-03", ["grade: chosen", "check: true", "bite: echo the blocked case was caught", says]);
    writeCard(world, "A-04", ["grade: chosen", "check: true"]);
    writeCard(world, "A-05", ["grade: chosen", "check: true", "bite: no-such-program-anywhere", says]);
    writeCard(world, "A-06", ["grade: chosen", "check: true", "bite: sleep 30", "timeout: 1", says]);
    writeCard(world, "A-07", ["grade: chosen", "check: true", "bite: echo the blocked case was caught; exit 1"]);
    writeCard(world, "A-08", ["grade: chosen", "check: true", "bite: echo the blocked case was caught; sleep 30 & exit 1", says]);
    const bad = laws(world, ["bite"]);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.printed, /^A-01 +bites$/m);
    assert.match(bad.printed, /^A-03 +TOOTHLESS +the bite passed/m);
    assert.match(bad.printed, /^A-04 +TOOTHLESS +no bite,/m);
    assert.match(bad.printed, /^A-05 +TOOTHLESS +the bite failed \(exit 127\) without printing "the blocked case was caught"/m);
    assert.match(bad.printed, /^A-06 +TOOTHLESS +the bite did not finish within 1 s/m);
    assert.match(bad.printed, /^A-07 +TOOTHLESS +no bite-says/m);
    assert.match(bad.printed, /^A-08 +TOOTHLESS +the bite left a process running/m);
    assert.match(bad.printed, /SOME LAWS ARE TOOTHLESS\n$/);
  }),
);

test(
  "wrong words on the command line are errors that show the usage",
  withWorld((world) => {
    for (const words of [[], ["dance"], ["status", "--fast"], ["status", "--repo"], ["status", "extra"]]) {
      const { exitCode, printed } = lawsRaw(words);
      assert.equal(exitCode, 1, JSON.stringify(words));
      assert.match(printed, /laws/);
    }
    const elsewhere = lawsRaw(["check", "--repo", world.folder]);
    assert.equal(elsewhere.exitCode, 1);
    assert.match(elsewhere.printed, /no laws\/ folder in .*Run from a repository root, or pass --repo/);
    assert.match(lawsRaw(["gate", "--repo", world.folder, "--signers", world.signers]).printed, /^closed\n/);
  }),
);
