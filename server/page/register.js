// The registration page. It asks the phone for a new passkey for this server and shows what the
// signers file on the laptop needs: the line, the fingerprint of the public key, and the make of the
// device that holds the key. It sends nothing to the server.

import { aaguidOf, flagsOf, isSignerName, signersLine, toHex } from "./pure.js";

const site = document.getElementById("site");
const nameInput = document.getElementById("name");
const createButton = document.getElementById("create");
const problem = document.getElementById("problem");
const result = document.getElementById("result");

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function block(title, text, note) {
  const section = make("section", "block");
  section.append(make("h3", "", title), make("pre", "", text));
  if (note) section.append(make("p", "quiet", note));
  return section;
}

async function showResult(info, name, credential) {
  const response = credential.response;
  // -7 is the number of ES256: a P-256 key that signs with SHA-256. laws accepts no other kind.
  if (response.getPublicKeyAlgorithm() !== -7) throw new Error("the new passkey is not of the ES256 kind");
  const publicKey = response.getPublicKey();
  const data = response.getAuthenticatorData();
  const flags = flagsOf(data);
  const line = signersLine(name, location.origin, info.rpId, credential.rawId, publicKey);
  const fingerprint = toHex(await crypto.subtle.digest("SHA-256", publicKey));
  const aaguid = aaguidOf(data);

  const lineBlock = block("1. The line for the signers file", line, "Add it as one line to the signers file on the laptop, for example /etc/laws/allowed_signers.");
  const copy = make("button", "", "Copy the line");
  copy.type = "button";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(`${line}\n`).then(
      () => (copy.textContent = "Copied"),
      () => (copy.textContent = "Could not copy. Select the line by hand."),
    );
  });
  lineBlock.append(copy);

  const notes = [];
  if (!flags.verified) notes.push(make("p", "warn", "The phone did not check a finger or the screen lock while it made this passkey. Signatures from it will only count if it does."));
  if (flags.backupEligible) {
    const copied = flags.backedUp ? "and it is copied already" : "it is not copied yet";
    notes.push(make("p", "warn", `This passkey can be copied to your other devices (${copied}). If one of them is the laptop, programs there may reach it.`));
  } else {
    notes.push(make("p", "good", "This passkey stays on this one device."));
  }

  result.replaceChildren(
    lineBlock,
    block("2. The fingerprint of the public key", fingerprint, "sha256 of the key, in hex. Compare it on the laptop after you copied the line."),
    block("3. The device that holds the key", aaguid ?? "not told", "The AAGUID names the make of the phone, key or app that keeps the passkey. All zeros means it did not say."),
    ...notes,
  );
}

async function start() {
  const response = await fetch("api/info");
  const info = await response.json();
  if (!response.ok) throw new Error(info.error ?? `the server answered ${response.status}`);
  site.textContent = `For the site ${info.rpId}, used at ${location.origin}.`;
  if (info.origin !== location.origin) {
    problem.textContent = `This page is open at ${location.origin}, and the server was started for ${info.origin}. The line will name the address of this page.`;
  }
  if (!navigator.credentials || !window.PublicKeyCredential) {
    throw new Error("this browser offers no passkeys here. Open the page over https");
  }
  createButton.disabled = false;

  // The passkey is asked inside the tap itself, with nothing awaited before it: phones want that.
  createButton.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!isSignerName(name)) {
      problem.textContent = "The name may use letters, digits and . _ @ - only.";
      return;
    }
    problem.textContent = "";
    createButton.disabled = true;
    navigator.credentials
      .create({
        publicKey: {
          rp: { id: info.rpId, name: "laws" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `laws approvals (${name})`, displayName: `laws approvals (${name})` },
          // Nobody checks this registration, so its challenge only has to be there.
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          attestation: "none",
          timeout: 120000,
        },
      })
      .then((credential) => showResult(info, name, credential))
      .catch((error) => {
        problem.textContent = `No passkey was made: ${error.message}.`;
      })
      .finally(() => {
        createButton.disabled = false;
      });
  });
}

start().catch((error) => {
  problem.textContent = `${error.message}.`;
});
