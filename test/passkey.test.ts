import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { openSigners } from "../src/approvals.ts";
import { LawsError } from "../src/cards.ts";
import {
  challengeFor,
  isPasskeyLine,
  keyFingerprint,
  parsePasskeyApproval,
  parsePasskeyLine,
  passkeyApprovalText,
  passkeyProblem,
  readPasskeyFields,
} from "../src/passkey.ts";
import { newPhone, passkeyLine, phoneSigns, withWorld } from "./support.ts";

const MANIFEST = `signed: 2026-11-18T09:15:00.123Z\nT-01 ${"a".repeat(64)}\n`;

test("the challenge of a manifest is the hash of a fixed first line and the manifest", () => {
  const expected = createHash("sha256").update(`laws manifest v1\n${MANIFEST}`).digest("base64url");
  assert.equal(challengeFor(Buffer.from(MANIFEST)), expected);
  assert.notEqual(challengeFor(Buffer.from(MANIFEST)), challengeFor(Buffer.from(`${MANIFEST} `)));
});

test("a passkey line is told from an SSH line by its second word, and is read exactly", () => {
  const phone = newPhone("https://pi.example.ts.net", "pi.example.ts.net");
  const line = passkeyLine(phone, "alex").trimEnd();
  assert.ok(isPasskeyLine(line));
  assert.ok(isPasskeyLine("alex passkey"));
  assert.ok(!isPasskeyLine('alex namespaces="laws" ssh-ed25519 AAAA passkey'));
  assert.ok(!isPasskeyLine("# alex passkey is on the next line"));
  assert.ok(!isPasskeyLine(""));

  const signer = parsePasskeyLine(line);
  assert.deepEqual(
    [signer.name, signer.origin, signer.rpId, signer.credentialId],
    ["alex", "https://pi.example.ts.net", "pi.example.ts.net", phone.credentialId.toString("base64url")],
  );
  const der = phone.publicKey.export({ format: "der", type: "spki" });
  assert.equal(keyFingerprint(signer), createHash("sha256").update(der).digest("hex"));

  // A port is part of the address. The site may be a parent of the host, and nothing else.
  assert.equal(parsePasskeyLine(line.replace('.ts.net"', '.ts.net:8443"')).origin, "https://pi.example.ts.net:8443");
  assert.equal(parsePasskeyLine(line.replace('rp="pi.example.ts.net"', 'rp="example.ts.net"')).rpId, "example.ts.net");
  assert.throws(() => parsePasskeyLine(line.replace('rp="pi.example.ts.net"', 'rp="i.example.ts.net"')), /not the host/);
  assert.throws(() => parsePasskeyLine(line.replace("https://", "http://")), /must be https/);
  assert.throws(() => parsePasskeyLine(`${line} `), /it is not: <name> passkey/);
});

test("a passkey answer verifies only for its own manifest, and the reason is said in plain words", () => {
  const phone = newPhone();
  const signers = [parsePasskeyLine(passkeyLine(phone).trimEnd())];
  const manifest = Buffer.from(MANIFEST);
  const text = passkeyApprovalText(readPasskeyFields(phoneSigns(phone, challengeFor(manifest))));
  assert.equal(passkeyProblem(manifest, text, signers, "/etc/signers"), null);
  assert.deepEqual(parsePasskeyApproval(text), readPasskeyFields(JSON.parse(text)));

  const other = Buffer.from(MANIFEST.replace("T-01", "T-02"));
  assert.match(passkeyProblem(other, text, signers, "/etc/signers") ?? "", /made for another list/);
  assert.match(passkeyProblem(manifest, text, [], "/etc/signers") ?? "", /its passkey is not in \/etc\/signers/);
  assert.match(passkeyProblem(manifest, text.trimEnd(), signers, "/etc/signers") ?? "", /not written the one way/);

  const unchecked = passkeyApprovalText(readPasskeyFields(phoneSigns(phone, challengeFor(manifest), false)));
  assert.match(passkeyProblem(manifest, unchecked, signers, "/etc/signers") ?? "", /did not check a finger or the screen lock/);

  const elsewhere = [parsePasskeyLine(passkeyLine({ ...phone, origin: "https://laws.example.test:8443" }).trimEnd())];
  assert.match(passkeyProblem(manifest, text, elsewhere, "/etc/signers") ?? "", /another web address than https:\/\/laws\.example\.test:8443/);

  // Two lines may name the same passkey, for example at two addresses. One that fits is enough.
  assert.equal(passkeyProblem(manifest, text, [...elsewhere, ...signers], "/etc/signers"), null);
});

test("the fields of a passkey answer are read strictly", () => {
  const good = phoneSigns(newPhone(), "challenge");
  assert.equal(readPasskeyFields(good).authenticatorData.length, 37);
  const bad: unknown[] = [
    null,
    "text",
    [good],
    { ...good, extra: "" },
    { ...good, signature: undefined },
    { ...good, signature: 7 },
    { ...good, signature: "" },
    { ...good, signature: `${good.signature}=` },
    { ...good, signature: good.signature.replace(/.$/, "+") },
    { ...good, signature: "A".repeat(200) },
    { ...good, credentialId: "A".repeat(2000) },
  ];
  for (const value of bad) assert.throws(() => readPasskeyFields(value), undefined, JSON.stringify(value));
});

test(
  "the signers file: SSH lines go to a private copy without the passkey lines, and the copy is removed",
  withWorld((world) => {
    const onlySsh = openSigners(world.signers);
    assert.equal(onlySsh.sshFile, world.signers, "a file without passkey lines is used as it is");
    assert.deepEqual(onlySsh.passkeys, []);
    onlySsh.close();

    const sshLine = readFileSync(world.signers, "utf8");
    const phone = newPhone();
    writeFileSync(world.signers, `# the laptop\n${sshLine}# the phone\n${passkeyLine(phone)}`);
    const mixed = openSigners(world.signers);
    assert.equal(mixed.file, world.signers);
    assert.notEqual(mixed.sshFile, world.signers);
    assert.equal(readFileSync(mixed.sshFile, "utf8"), `# the laptop\n${sshLine}# the phone\n\n`);
    assert.equal(mixed.passkeys.length, 1);
    assert.equal(mixed.passkeys[0]?.credentialId, phone.credentialId.toString("base64url"));
    mixed.close();
    assert.ok(!existsSync(dirname(mixed.sshFile)), "the private copy must be gone");

    writeFileSync(world.signers, `${sshLine}alex passkey origin="https://x.test"\n`);
    try {
      openSigners(world.signers);
      assert.fail("a broken passkey line was accepted");
    } catch (error) {
      if (!(error instanceof LawsError)) throw error; // it must be an error that the command prints as a plain message
      assert.match(error.message, /the signers file .* cannot be used: line 2 is not a good passkey line/);
    }
  }),
);
