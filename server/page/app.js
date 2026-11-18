// The signing page. It shows the cards of one request in full, lets the person accept or reject each
// one, and then asks the phone's passkey to sign the list that the server built from the accepted cards.
// Every address here is relative, so the page works under any path that a proxy gives it.

import { assertionBody, decisionSummary, formatBytes, fromBase64url, hiddenCharacters, requestIdFrom, signLabel } from "./pure.js";

const main = document.getElementById("main");
const bar = document.getElementById("bar");
const count = document.getElementById("count");
const signButton = document.getElementById("sign");

// Makes one element. Text goes in as text, never as HTML.
function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function show(...elements) {
  main.replaceChildren(...elements);
}

// Talks to the server. With a body it posts JSON. An answer that says no becomes an error.
async function api(path, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error ?? `the server answered ${response.status}`);
  return answer;
}

function when(time) {
  return new Date(time).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// With no request named: the list of what is waiting.
async function showWaiting() {
  const { requests } = await api("api/requests");
  const blocks = requests.map((request) => {
    const link = make("a", "request");
    link.href = `?r=${request.id}`;
    link.append(make("strong", "", request.cards.length === 1 ? "1 card" : `${request.cards.length} cards`));
    for (const card of request.cards) link.append(make("div", "", `${card.retire ? "retire " : ""}${card.id}  ${card.title}`));
    link.append(make("div", "quiet", `sent ${when(request.created)}, waits until ${when(request.expires)}`));
    return link;
  });
  const register = make("a", "", "Make a passkey for this server");
  register.href = "register.html";
  const none = make("p", "", "Nothing is waiting. Run laws sign --phone on the laptop.");
  show(make("h2", "", "Waiting for you"), ...(blocks.length > 0 ? blocks : [none]), make("p", "quiet"), register);
}

// One card, in full: its text, its figure, and the names of the files that are hashed with it.
function showCard(card, decisions, changed) {
  const section = make("section", "card");
  const kind = make("span", card.retire ? "kind retire" : "kind", card.retire ? "retire" : "approve");
  const head = make("div");
  head.append(kind, make("span", "id", card.id));
  section.append(head, make("h2", "", card.title));
  if (card.retire) {
    section.append(make("p", "warn", "Accepting this ends the law. Only its id is signed. The text below is what the laptop sent, to show which law it is."));
  } else {
    section.append(make("p", "hash", `hash ${card.hash}`));
  }

  const hidden = hiddenCharacters(card.text) + (card.figure ? hiddenCharacters(card.figure.text) : 0);
  if (hidden > 0) {
    section.append(make("p", "warn", `Careful: this text has ${hidden} character(s) that show nothing or turn the reading direction around. It may not read the way it is written.`));
  }
  section.append(make("pre", "", card.text));
  if (card.figure) {
    section.append(make("h3", "", `Figure ${card.figure.path}`), make("pre", "figure", card.figure.text));
  }
  if (card.files.length > 0) {
    const files = make("ul", "files");
    for (const file of card.files) {
      const item = make("li");
      item.append(make("span", "path", file.path), make("span", "size", formatBytes(file.bytes)));
      files.append(item);
    }
    section.append(make("h3", "", "Hashed with this card"), files);
  }

  const choice = make("div", "choice");
  const accept = make("button", "accept", "Accept");
  const reject = make("button", "reject", "Reject");
  const decide = (decision) => {
    decisions.set(card.id, decision);
    accept.setAttribute("aria-pressed", String(decision === "accept"));
    reject.setAttribute("aria-pressed", String(decision === "reject"));
    accept.textContent = decision === "accept" ? "Accepted" : "Accept";
    reject.textContent = decision === "reject" ? "Rejected" : "Reject";
    section.classList.toggle("accepted", decision === "accept");
    section.classList.toggle("rejected", decision === "reject");
    changed();
  };
  for (const [button, decision] of [[accept, "accept"], [reject, "reject"]]) {
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => decide(decision));
  }
  choice.append(accept, reject);
  section.append(choice);
  return section;
}

async function showRequest(id) {
  const request = await api(`api/requests/${id}`);
  if (request.state !== "waiting") {
    const signed = request.by === "laptop" ? "This request was approved from the laptop, with the finger." : "This request was signed on the phone.";
    const said = request.state === "signed" ? signed : "This request was rejected.";
    const fetched = make("p", "quiet", request.state === "signed" ? "The laptop fetches the signature by itself." : "");
    show(make("h2", "", said), fetched, ...(request.manifest ? [make("pre", "", request.manifest)] : []));
    return;
  }

  const decisions = new Map();
  const list = make("section", "block");
  const listText = make("pre", "", "");
  const listNote = make("p", "quiet", "");
  list.append(make("h3", "", "What your passkey will sign"), listNote, listText);
  const problem = make("p", "problem", "");

  let offer = null; // the list that the server built from the accepted cards, with its challenge
  let turn = 0; // only the answer to the newest question counts
  let action = "none";

  const setBar = (text, label, enabled, rejecting = false) => {
    count.textContent = text;
    signButton.textContent = label;
    signButton.disabled = !enabled;
    signButton.classList.toggle("reject", rejecting);
  };

  // Called after every decision. When every card is decided, the server is asked for the list.
  const changed = async () => {
    const summary = decisionSummary(request.cards, decisions);
    const mine = ++turn;
    offer = null;
    action = "none";
    problem.textContent = "";
    listText.textContent = "";
    const counted = `${summary.accepted.length} accepted, ${summary.rejected} rejected, ${summary.undecided} to decide`;
    if (!summary.complete) {
      listNote.textContent = "Accept or reject every card first.";
      return setBar(counted, signLabel(summary.accepted.length), false);
    }
    if (summary.accepted.length === 0) {
      listNote.textContent = "Nothing. You rejected every card.";
      action = "reject";
      return setBar(counted, "Reject all and close", true, true);
    }
    listNote.textContent = "Asking the server for the list…";
    setBar(counted, signLabel(summary.accepted.length), false);
    try {
      const answer = await api(`api/requests/${id}/options`, { accept: summary.accepted });
      if (mine !== turn) return;
      offer = answer;
      action = "sign";
      listNote.textContent = "Exactly this text, and nothing else:";
      listText.textContent = answer.manifest;
      setBar(counted, signLabel(summary.accepted.length), true);
    } catch (error) {
      if (mine !== turn) return;
      listNote.textContent = "";
      problem.textContent = `No list to sign: ${error.message}.`;
    }
  };

  const finish = (title, ...more) => {
    bar.hidden = true;
    show(make("h2", "", title), ...more);
    window.scrollTo(0, 0);
  };

  // The passkey is asked inside the tap itself, with nothing awaited before it: phones want that.
  signButton.addEventListener("click", () => {
    problem.textContent = "";
    if (action === "reject") {
      signButton.disabled = true;
      api(`api/requests/${id}/reject`, {})
        .then(() => finish("Rejected. Nothing was signed."))
        .catch((error) => {
          problem.textContent = `Not rejected: ${error.message}.`;
          signButton.disabled = false;
        });
      return;
    }
    if (action !== "sign" || offer === null) return;
    if (!navigator.credentials || !window.PublicKeyCredential) {
      problem.textContent = "This browser offers no passkeys here. Open the page over https.";
      return;
    }
    const signed = offer;
    signButton.disabled = true;
    count.textContent = "Waiting for your passkey…";
    navigator.credentials
      .get({
        publicKey: {
          challenge: fromBase64url(signed.challenge),
          rpId: signed.rpId,
          userVerification: "required",
          allowCredentials: [],
          timeout: 120000,
        },
      })
      .then((credential) => api(`api/requests/${id}/assertion`, assertionBody(credential)))
      .then((answer) => {
        const checked =
          answer.checked === "accepted"
            ? make("p", "good", "The server compared the signature with its copy of the signers file: it fits.")
            : make("p", "quiet", "The server did not check the signature. The laptop does.");
        finish(
          "Signed.",
          make("pre", "", signed.manifest),
          checked,
          make("p", "", "The laptop fetches the signature now and checks it. Read the list that laws sign prints there: it names every card that became approved."),
        );
      })
      .catch((error) => {
        problem.textContent = `Not signed: ${error.message}.`;
        changed();
      });
  });

  const title = request.cards.length === 1 ? "1 card to read" : `${request.cards.length} cards to read`;
  const until = make("p", "quiet", `Sent ${when(request.created)}. Waits until ${when(request.expires)}.`);
  show(make("h2", "", title), until, ...request.cards.map((card) => showCard(card, decisions, changed)), list, problem);
  bar.hidden = false;
  changed();
}

const id = requestIdFrom(location.search);
(id === null ? showWaiting() : showRequest(id)).catch((error) => {
  bar.hidden = true;
  const back = make("a", "", "See what is waiting");
  back.href = "./";
  show(make("p", "problem", `${error.message}.`), back);
});
