// laws sign --notify: the phone address and the list go to a command of the owner's choice, on its standard input.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GOOD, laws, lawsRaw, withWorld, writeCard } from "./support.ts";

test(
  "the notify command gets the address and the list, and signing still works",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    const sink = join(world.folder, "message.txt");
    const run = laws(world, ["sign", "--server", world.server, "--phone", "--notify", `cat > '${sink}'`]);
    assert.equal(run.exitCode, 0, run.printed);
    assert.match(run.printed, /A message with this address was sent\./);
    const message = readFileSync(sink, "utf8");
    assert.match(message, /laws: sign on your phone/);
    assert.ok(message.includes(`${world.server}?r=`), "the address of the request is in the message");
    assert.match(message, /sign +A-01 +[0-9a-f]{64} /, "the list to compare is in the message");
    assert.match(lawsRaw(["status", "--repo", world.repo, "--signers", world.signers]).printed, /A-01 +chosen +approved/);
  }),
);

test(
  "a notify command that fails only costs a note",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    const run = laws(world, ["sign", "--server", world.server, "--phone", "--notify", "exit 3"]);
    assert.equal(run.exitCode, 0, run.printed);
    assert.match(run.printed, /The notify command did not work \(exit 3\); use the address above\./);
    assert.match(run.printed, /open this address there:/);
  }),
);

test(
  "LAWS_NOTIFY works like the flag, and with neither nothing is sent",
  withWorld((world) => {
    writeCard(world, "A-01", GOOD);
    writeCard(world, "A-02", GOOD);
    const sink = join(world.folder, "env-message.txt");
    const words = ["sign", "A-01", "--server", world.server, "--phone", "--repo", world.repo, "--signers", world.signers];
    const viaEnv = lawsRaw(words, { LAWS_NOTIFY: `cat > '${sink}'` });
    assert.equal(viaEnv.exitCode, 0, viaEnv.printed);
    assert.ok(existsSync(sink));
    const plain = laws(world, ["sign", "A-02", "--server", world.server, "--phone"]);
    assert.equal(plain.exitCode, 0, plain.printed);
    assert.ok(!plain.printed.includes("A message with this address was sent"));
  }),
);
