# laws

Law cards for software that agents write.

A law is one sentence that must always hold, with a blocked case, an allowed case and a machine check.
You approve a law by signing it. `laws` keeps that approval tied to the exact text of the law and of its check,
so an agent can neither fake an approval nor change a law that you approved without you seeing it.

This is version 0. The tool's own laws are the eleven cards in `laws/`, and its tests are their checks.

## A card

A card is the file `laws/<ID>.md`: a front matter block, then Markdown. The first heading is the title.

```markdown
---
id: D-03
grade: generated
check: pytest tests/laws/test_d03.py
bite: pytest tests/laws/test_d03_bite.py
bite-says: a shot started with an empty scale
frozen: [tests/laws/test_d03.py, tests/laws/test_d03_bite.py]
scope: [src/dialin/cups.py]
timeout: 120
figure: figures/D-03.spec.json
---
# D-03 A shot starts only when the machine is ready

**Law.** ...  **Why.** ...  **Blocked.** ...  **Allowed.** ...
```

| Key | Meaning |
|---|---|
| `id` | Must equal the file name. Letters, digits and `-`. |
| `grade` | How strong the check is: `every-case`, `bounded`, `generated`, `chosen` or `prose`. |
| `check` | A shell command, run in the repository root. Exit 0 means the law holds. |
| `bite` | A shell command that must fail: the blocked case run for real, against code broken on purpose. |
| `bite-says` | A text that the failing bite prints, usually its assertion message. A bite that fails without it, for example because its file name is misspelled, does not count. |
| `frozen` | Files whose content is part of the law. Changing one byte of them voids the approval. |
| `scope` | The files the law is about. For the reader only. |
| `timeout` | Seconds allowed for the check and for the bite. Default 60. |
| `figure` | A figure spec `NAME.spec.json`. `laws show` prints `NAME.txt` if it lies next to it. Both files are part of the law, like frozen files. |

Only `id` and `grade` are required by the parser. A card above `prose` grade without a `check` fails
`laws check`, and without a `bite` and its `bite-says` it cannot be signed.

The parser is strict. It rejects unknown keys, duplicate keys, empty values, blank lines and comments in the
front matter, an id that does not match the file name, and paths that are absolute, contain `..` or are spelled
in a roundabout way (`./a`, `a//b`). It also rejects control characters anywhere in the card, because the
signer shows the title on a terminal. Values are taken literally: no quotes, no multi-line values. Lists are
written on one line as `[a, b]`. Every `laws/*.md` file is a card.

## Commands

Run them in a repository root, or pass `--repo <path>`.

| Command | What it does |
|---|---|
| `laws status` | One line per card: id, grade, state, title. |
| `laws show <id>` | Prints the card, and its figure as text if it is rendered. |
| `laws check` | Runs every check. One line per card, then `ALL LAWS HOLD`, or the failing cards with their last lines of output and `SOME LAWS FAIL` (exit 1). |
| `laws bite` | Runs every bite. A bite counts only if it exits with a failure and prints the card's `bite-says`. Otherwise the card is `TOOTHLESS` (exit 1). |
| `laws gate` | Prints `open` if every card is approved as it is now and no approved card is missing, else `closed` and why (exit 1). |
| `laws verify` | The same test as the gate, worded for CI. |
| `laws sign [<id>...]` | Asks for a signature that approves the given cards, or all that are waiting or changed. |
| `laws retire <id>...` | Asks for a signature that retires the given cards. Afterwards their files can be removed. |

The states that `laws status` shows:

| State | Meaning | Gate |
|---|---|---|
| `approved` | A signed manifest lists the card as it is now. | open |
| `waiting` | Nobody approved it. | closed |
| `changed` | It was approved, and the card, a frozen file or its figure changed since. | closed |
| `broken` | The card, a frozen file or the figure cannot be read. | closed |
| `missing` | A signed approval names the card and its file is gone. | closed |
| `retired` | The newest signed line for the card retires it. | open once the file is removed |

Each check and each bite runs in its own process group, with the card's time limit and with a marker of its own
in its environment (`LAWS_RUN_<random>=1`). When it ends or is stopped, `laws` kills the group, looks through
`/proc/*/environ` for processes that carry the marker, kills those too, and waits until all are gone. A check
that returns and leaves a process running fails, also when the process detached itself into its own session.

A repository with no cards fails `check`, `bite`, `gate` and `verify`: nothing was checked.

## How approval works

1. **The hash.** A card's hash is the sha256 of the card file, of every frozen file, of the figure file and of
   the figure's rendered text if there is one. Each file goes in with its path, and each part is prefixed with
   its length. A missing frozen file or figure is an error.
2. **The manifest.** A signed batch is `laws/approvals/<name>.manifest` plus the proof that you approved it.
   They are committed with the cards. A manifest looks like this:

   ```
   signed: 2026-11-18T09:15:00.123Z
   T-01 14a27a861431c292118968a11be5981f88e48f8071a2a2eb23c48c0a74e87177
   T-03 retired
   ```

   The first line is the time it was signed. It orders the batches: a retirement ends every approval of that
   card signed up to then, and an approval counts only if it is later than the card's last retirement.
   The file name is not signed and means nothing.
3. **The proof.** One of two files next to the manifest. One good proof is enough.
   - `<name>.manifest.sig`: an SSH signature over exactly the bytes of the manifest
     (`ssh-keygen -Y sign -n laws`). The laptop key makes it.
   - `<name>.passkey.json`: a passkey signature from the phone over the hash of those bytes. See
     "A phone approval" below.
4. **The signers file.** `laws` accepts a signature only from a key in the signers file. It takes the file from
   `--signers <file>`, else from `LAWS_SIGNERS`, else `/etc/laws/allowed_signers`. A path inside the
   repository is refused, and there is no fallback. The file has two kinds of lines:

   ```
   alex namespaces="laws" ssh-ed25519 AAAA...
   alex passkey origin="https://pi.example.ts.net" rp="pi.example.ts.net" id=<credential id> <public key>
   ```

   The first is an SSH key, in the form that `ssh-keygen` knows as "allowed signers". The second names a
   passkey: see "The signers file: a passkey line" below.
5. **Signing.** `laws` holds no key and cannot sign. `laws sign` runs every picked card's bite and refuses the
   batch if one is toothless. Then it asks for the signature, in one of the ways below, and stores what comes
   back only if the manifest is the list it asked for, its time is later than the newest manifest already
   there, and the signature verifies against the signers file.
6. **Retiring.** A card that was approved cannot just be deleted: the gate closes with `missing`. Run
   `laws retire <id>` while the card is still there, approve it, and then remove the file. A retired id that
   comes back needs a new signature, by name: `laws sign <id>`.

What makes an approval count is the signers file that you or CI pass to `laws verify`. Anyone can run
`laws verify --signers some-other-file`; that proves nothing.

## Signing through the signing server

There is one place where laws are signed: the signing server (`laws-server`), which runs at home. Every
approval is made on a request that waits there. You approve it on the phone, with a passkey, or on the laptop,
with one named finger. The server itself holds no key and cannot approve anything.

```
laws sign --server https://pi.example.ts.net/laws/
```

What happens, in this order:

1. `laws` posts the cards to the server: the bytes of each card and of each file that is hashed with it.
   The server computes the hashes from those bytes and answers with the list. `laws` prints it and goes on
   only if it is the list that `laws` computed itself.
2. `laws` prints the address to open on the phone. The request waits on the server for 24 hours.
3. If the laptop's fingerprint helper is there (a socket at `/run/laws-signer/socket`), `laws` asks it to
   approve the request, and prints which finger to put on the reader. You have 30 seconds. If you let them
   pass, the request still waits for the phone.
4. `laws` asks the server until it hands out a manifest with a signature. It checks both against the signers
   file, stores them in `laws/approvals/`, prints the list that became approved (id, hash and title), and
   runs `laws verify`. **Read that list.** It names every card that became approved.

| Option | Meaning |
|---|---|
| `--server <address>` | The address of the signing server. Or set `LAWS_SIGNER=server:<address>`. |
| `--phone` | Wait for the phone. The finger is not offered on the laptop. |
| `--laptop <socket>` | The socket of the fingerprint helper, if it is not at `/run/laws-signer/socket`. |

`laws retire <id>... --server <address>` works the same way. On the phone the card is then marked "retire".

On the phone you may accept some cards of a request and reject others. The signed list then holds the accepted
ones only, and `laws` says which ones were left out. The laptop's finger approves the whole request.

`laws` trusts neither the server nor the helper. It stores a manifest only if every line of it is a card that
it sent, with the hash that it computed, if the time in it lies between the start of the command and now
(give or take 5 minutes), and if the signature is good.

### On the phone: the page

The page shows each card of the request in full: its text, its figure as text if one was sent, and the names
and sizes of the files that are hashed with it. You accept or reject each card. Then the page shows the exact
list that will be signed, and one button, "Sign N cards", asks the phone's passkey for the signature. The phone
checks your finger or its screen lock for it.

The page is plain HTML, CSS and JavaScript in `server/page/`. It loads nothing from other sites, sets no
cookie, and nothing on it moves. It was written for a phone, 360 px wide, with a dark background.

### Registering the passkey

Open `register.html` under the server's address on the phone, for example
`https://pi.example.ts.net/laws/register.html`, and press "Make the passkey". The page shows three things:

1. the complete line for the signers file,
2. the sha256 fingerprint of the public key,
3. the AAGUID: sixteen bytes that name the make of the phone, key or app that now holds the passkey.

It also says whether the passkey can be copied to your other devices. The server stores nothing from this
page. The passkey counts only after you added the line to the signers file on the laptop yourself. To compare
the fingerprint there:

```bash
grep ' passkey ' /etc/laws/allowed_signers | awk '{ print $NF }' | base64 -d | sha256sum
```

### The signers file: a passkey line

```
alex passkey origin="https://pi.example.ts.net" rp="pi.example.ts.net" id=<credential id> <public key>
```

One line, single spaces, nothing after the key. `laws` reads these lines itself; `ssh-keygen` never sees them.

| Part | Meaning |
|---|---|
| `alex` | A name for you. Letters, digits and `. _ @ -`. |
| `passkey` | The second word. It tells this line from an SSH line. |
| `origin` | The web address where the passkey may approve: `https://<host>` or `https://<host>:<port>`, with no path. A signature made at any other address does not count. |
| `rp` | The site that the passkey was made for (its "relying party id"): the host of the origin, or a parent of it. |
| `id` | The id of the passkey (credential id), in base64url. |
| the last word | The public key: base64 of its usual DER form (SubjectPublicKeyInfo). Only P-256 keys are accepted, which is the "ES256" kind of passkey. |

A passkey line that is not exact stops `laws verify` with an error that names the line.

### A phone approval

`<name>.passkey.json` holds the passkey's answer (a "WebAuthn assertion") in four parts, each in base64url:

```json
{
  "credentialId": "...",
  "authenticatorData": "...",
  "clientDataJSON": "...",
  "signature": "..."
}
```

`laws verify` accepts it only if all of this is true:

- the file is written exactly this way: these four fields, clean base64url, at most 16 KB;
- `credentialId` is the id of a passkey line in the signers file;
- the browser's part (`clientDataJSON`) says `webauthn.get`, which is a request for a signature;
- its `challenge` is base64url(sha256(`"laws manifest v1\n"` + the manifest bytes)): the signature was made
  for exactly this list;
- its `origin` is exactly the origin of the passkey line, and it was not made inside a frame of another site;
- the phone's part (`authenticatorData`) has at least 37 bytes and starts with sha256 of the `rp` of the line;
- its flags say that a person was there (0x01) and that the phone checked a finger or the screen lock (0x04);
- the signature over `authenticatorData` followed by sha256(`clientDataJSON`) verifies with the public key
  of the line (ES256: P-256, sha256, DER).

### The signing server

```
laws-server --listen 127.0.0.1:<port> --state <folder> --origin <https address> --rp-id <host> [--signers <file>]
```

It listens on the machine itself only. A reverse proxy has to serve it under a path of its own, such as
`/laws/`, and remove that path before it passes a request on (Caddy: `handle_path /laws/*`, and
`redir /laws /laws/`). The page uses relative addresses only.

What it does with a request:

- It computes each card's hash from the bytes it was sent. It stores those bytes and no hash. Each time the
  page asks, the text that is shown and the hash next to it come from the same stored bytes.
- **From the phone**: the page sends the cards that you accepted, each with the hash that it showed. The
  server builds the manifest from the stored bytes of exactly those cards, dates it, and answers with its
  challenge. If a hash is not what the page showed, it offers nothing. Then it stores the passkey's answer.
- **From the laptop**: the fingerprint helper hands over a manifest that it signed with the laptop key. The
  server takes it only if every line names a card of this request with the hash that the server computes.
  A part of the cards is fine. Any other line is refused.
- The first good approval closes the request. A request that was rejected on the page is closed as well.
- With `--signers <file>` it checks each signature before it stores it, so that the phone hears at once
  whether the laptop will accept it. Without it, it stores what it is given. Nothing depends on this check:
  `laws verify` on the laptop is what counts.

**The record.** The server adds one line to `<state>/record.log` for every approval, and never shortens the
file by itself:

```
2026-11-18T21:40:02.511Z phone request=6f0c…e1 checked=yes signed=2026-11-18T21:39:58.220Z T-09=14a2… T-10=9bc1…
2026-11-18T21:52:10.004Z laptop request=a3d1…7c checked=no signed=2026-11-18T21:52:09.871Z T-11=retired
```

The time of the line, who approved (`phone` or `laptop`), the request, whether the server checked the
signature against a signers file, the time inside the manifest, and the list. The record is for you to read.
Whoever is root on the server can rewrite it, and `laws verify` does not use it.

Limits: one file up to 1 MB, the files of one request up to 8 MB together, 100 cards in a request, 20
requests waiting at a time. A request waits 24 hours, so you can post in the evening and sign in the
morning, and is then removed with everything that was stored for it. A request that was approved or
rejected keeps only the list and its signature for the rest of that time, so that the laptop can fetch them.
At most 200 requests are kept in all; beyond that the oldest closed ones go. Request ids are 32 random hex
digits.

### The laptop's fingerprint helper

```
laws-signerd --socket <path> --server <https address> --key <private key file> --log <file> --user <name> --finger <finger>
```

A service that runs as root and holds the laptop key. It adds your finger to the signing server and does
nothing else. A call on its socket says one thing: "approve request `<id>`". For each call it:

1. fetches the cards of that request from the signing server, at the address in its own settings. The caller
   cannot name another server and cannot hand it cards;
2. computes every hash from those bytes and answers the caller with the list;
3. only then asks the fingerprint reader for the one finger named in its settings, for 30 seconds
   (`fprintd-verify -f <finger> <user>`). A match is exit status 0 together with `verify-match`;
4. on a match writes the list to its log, signs it with the laptop key, and hands the manifest and the
   signature to the server itself. The caller only hears "approved", or why not.

Another finger, no touch in time, a call while one is being served: nothing is signed, and the log says why.
Nothing is kept from one call to the next. `--finger` must be one finger by the name that fprintd gives it
(`left-thumb` … `right-little-finger`); `any` is refused. `--server` must be an https address.
If the key file does not exist when the helper starts, it makes an ed25519 key and writes `<key>.pub` next
to it. It prints the line for the signers file when it starts.

**Not known:** whether the laptop's reader really rejects another enrolled finger when one finger is named.
Some readers compare a touch with every stored finger. Test it by hand before you rely on it: start a signing,
touch the reader with an enrolled finger that is not the named one, and see that the helper refuses.

### Setting it up on NixOS

The flake has a package for each command and a module for each service. This was written from the design
and was not run: the modules were only evaluated.

```nix
# The server (the machine at home).
imports = [ laws.nixosModules.laws-server ];
services.laws-server = {
  enable = true;
  port = 8102;
  origin = "https://pi.example.ts.net";
  signersFile = "/etc/laws/allowed_signers"; # a copy, optional
};
# The route in the reverse proxy is yours to add, for example in Caddy:
#   redir /laws /laws/
#   handle_path /laws/* { reverse_proxy 127.0.0.1:8102 }

# The laptop.
imports = [ laws.nixosModules.laws-signer ];
services.fprintd.enable = true;
services.laws-signer = {
  enable = true;
  server = "https://pi.example.ts.net/laws/";
  user = "alex";
  finger = "right-middle-finger"; # enroll it first; best a finger that unlocks nothing else
};
```

The helper runs as root without root's special powers, may use the network, and has no access to `/home`.
Its socket is `/run/laws-signer/socket`, for your group. Its key and log are in `/var/lib/laws-signer`.
The server runs as a throwaway user and keeps its state in `/var/lib/laws-server`.
Then, on the laptop:

```bash
journalctl -u laws-signer | grep namespaces      # the helper's line for the signers file
sudo install -D -m 644 /dev/stdin /etc/laws/allowed_signers   # paste that line and the passkey line
export LAWS_SIGNER=server:https://pi.example.ts.net/laws/
laws sign
```

## Signing at the terminal, without a server

The first signer is still there: a small program, `signer/signer.ts`, installed as `laws-signer`.
`laws sign --signer "<command>"` (or `LAWS_SIGNER="<command>"`) calls it with
`--repo <repo> --out <folder> <id>... --retire <id>...`. The folder is private to you and is removed afterwards.

```
laws-signer --repo <path> --key <private key file> --log <file> --out <folder> [<id>...] [--retire <id>]...
```

It reads the cards itself and computes the hashes itself. Then it prints the list, one line per card:

```
  sign    T-01  14a27a86...  A card's hash covers everything that gives it meaning
  retire  T-03  The laws command cannot sign
```

Then it asks at the terminal: you type `sign` and press Enter (`retire` if the list only retires). It reads the
answer from `/dev/tty`, not from standard input. With any other answer, or with no terminal, it signs nothing.
Either way it appends one line to its log: time, key fingerprint, `signed` or `refused:...`, and the list.
No option and no environment variable skips the question. On a signature it writes `manifest` and
`manifest.sig` into `--out`.

It refuses the whole batch if a file is not a regular file inside the repository, wherever a symbolic link may
lead, or is larger than 1 MB. It checks this on the open file, not on the path. It never writes inside the
repository.

A possible setup on one machine, with the key readable by root only. It is written from the design and was
not run: this repository was built without `sudo`.

```bash
sudo mkdir -p /etc/laws /root/laws
sudo ssh-keygen -t ed25519 -N "" -C "laws approvals" -f /root/laws/key
echo "alex namespaces=\"laws\" $(sudo cat /root/laws/key.pub)" | sudo tee /etc/laws/allowed_signers
export LAWS_SIGNER="sudo $(command -v laws-signer) --key /root/laws/key --log /var/log/laws-signer.log"
laws sign          # in your own terminal: sudo asks first, then the signer shows the list and asks for the word
```

Run it yourself, in a terminal. The signer has to be attached to it: started from a program without a
terminal, such as an agent's shell, it refuses.

## What each way proves, and what it does not

**The phone (cards T-10, T-11).** The signature names the exact list, the web address, and says that the phone
checked your finger or its screen lock. No program on the laptop or on the server can make one.
- The law cannot see where the passkey is kept. If its store is also open on the laptop, a program there may
  be able to use it. Keep this passkey in the phone itself or on a hardware key.
- Someone with root on the server can change the page, so that it shows one card and asks the phone to sign
  another. The signature is then real. Until agents have no root on the server, read the list that `laws sign`
  prints on the laptop after a signing.
- The passkey belongs to a web address, not to this page. Any other page at the same address (same host and
  port) can ask the phone for a signature too, and the phone's question does not show the list. Do not serve
  pages that you do not trust from the address in the signers file.

**The finger on the laptop (card T-09).** One touch of the named finger approves one list that waits on the
server, after the list was sent to you.
- The laptop's software checks the finger, and the key lies on the laptop's disk where only root can read it.
  A program that became root can sign without you.
- The list is shown by a program that runs as you, on a screen that programs running as you can draw on.
- Every program that runs as you can call the helper. The reader then waits for the named finger. Touch it
  only for a signing that you started yourself, and use a finger that unlocks nothing else.

**The typed word (card T-04).** A typed word does not prove a person: a program that makes its own terminal can
type it. What proves a person there is the `sudo` prompt, which does not show the list.

**The server (card T-11).** Nothing that is stored on the server, and no answer that it gives, makes
`laws verify` pass for a list that neither the passkey nor the laptop key signed. The server can refuse to
work, lose requests, and write what it likes into its record.

## Working on this repository

There are no npm packages. Node 24 runs the TypeScript files as they are, and `types/node.d.ts` declares by hand
the few Node functions that are used.

```bash
nix develop --override-input nixpkgs nixpkgs --no-write-lock-file    # node, ssh-keygen, tsc
node src/cli.ts status                   # the command, straight from the source
node --run test                          # every test except the bites
node --run typecheck
node src/cli.ts check && node src/cli.ts bite
nix flake check --override-input nixpkgs nixpkgs --no-write-lock-file
```

The flake does not pin nixpkgs and has no `flake.lock`. A `nix` command without `--no-write-lock-file` writes
one; commit it if you want the pin. Its packages are `default` (`laws` and `laws-signer`), `laws-signerd` and
`laws-server`.

`test/laws/tNN-*.test.ts` is the check of card T-NN and `tNN-*.bite.test.ts` is its bite. A bite imports the
property from its check and runs it against a variant that the bite file breaks on purpose, so every test in a
bite file fails. Both files are frozen with their card, so they use no shared helpers. The checks of T-01, T-02,
T-05, T-08, T-10 and T-11 use generated cases; a failure prints `LAWS_SEED=<n>` to replay it. Tests create
throwaway keys in a temporary folder and remove it.

Tests have no terminal, no fingerprint reader, no phone and no browser.

- The terminal signer's main function takes the function that asks the question as an argument, and tests
  pass a stand-in that answers.
- The helper takes the finger check as an argument, and tests pass a stand-in for the reader. The real check
  is tested against shell scripts that print what `fprintd-verify` prints. The helper is told with a switch,
  which the command line cannot set, that the tests' server is at `http://127.0.0.1`.
- The phone is a software passkey: a P-256 key in memory that writes the same four parts as a phone.
- The page was not run in a browser. Its computing parts are in `server/page/pure.js`, and the tests run those
  under Node and use them to play the phone against a real server on a port of this machine.

## Limits and what is not built yet

- **Not tried for real.** No real fingerprint reader, no real phone, no real browser, and the NixOS modules
  did not run. See "Not known" above for the reader.
- **Approvals can be deleted together with the card.** The gate knows a card was approved only from the
  manifests in the repository. Whoever deletes a card and every manifest that names it leaves no trace there.
  CI has to check that `laws/approvals/` on a branch still holds every file that `main` holds. The server's
  record is not that check: root on the server can rewrite it.
- **What the process search cannot find.** A process that cleared its environment, changed user, or made
  itself unreadable (`ssh-agent` does) does not show the marker. If it also left the check's process group, it
  survives.
- **`bite-says` is a text match.** It proves that the bite failed with the expected message, not that the
  message is honest.
- **Whoever can reach the server can fill it.** It takes requests from everybody who reaches it, up to 20 at a
  time, and without `--signers` it cannot tell a good signature from a bad one before it closes a request.
  Nothing wrong gets approved that way, but a signing can be made to fail. Keep the server behind the tailnet.
- **`laws sign` has to stay open** until you approved. If you stop it, run it again: that posts the cards
  again, and the old request runs out by itself.
- **No hooks, no CI job, no `laws page`, no grade lint.** `laws gate` and `laws verify` are the parts they will
  call.
- **Linux only.** The signers and the process search read `/proc`. Tested on NixOS with Node 24 and OpenSSH 10.
