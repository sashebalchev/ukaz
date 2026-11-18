# laws

Law cards for software that agents write.

A law is one sentence that must always hold, with a blocked case, an allowed case and a machine check.
You approve a law by signing it. `laws` keeps that approval tied to the exact text of the law and of its check,
so an agent can neither fake an approval nor change a law that you approved without you seeing it.

This is version 0. The tool's own laws are the seven cards in `laws/`, and its tests are their checks.

## A card

A card is the file `laws/<ID>.md`: a front matter block, then Markdown. The first heading is the title.

```markdown
---
id: D-03
grade: generated
check: pytest tests/laws/test_d03.py
bite: pytest tests/laws/test_d03_bite.py
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
| `frozen` | Files whose content is part of the law. Changing one byte of them voids the approval. |
| `scope` | The files the law is about. For the reader only. |
| `timeout` | Seconds allowed for the check and for the bite. Default 60. |
| `figure` | A figure spec `NAME.spec.json`. `laws show` prints `NAME.txt` if it lies next to it. |

Only `id` and `grade` are required by the parser. A card above `prose` grade without a `check` fails
`laws check`, and without a `bite` it cannot be signed.

The parser is strict. It rejects unknown keys, duplicate keys, empty values, blank lines and comments in the
front matter, an id that does not match the file name, and paths that are absolute, contain `..` or are spelled
in a roundabout way (`./a`, `a//b`). Values are taken literally: no quotes, no multi-line values. Lists are
written on one line as `[a, b]`. Every `laws/*.md` file is a card.

## Commands

Run them in a repository root, or pass `--repo <path>`.

| Command | What it does |
|---|---|
| `laws status` | One line per card: id, grade, state, title. States: `waiting` (never approved), `changed` (approved, but the hash differs now), `approved`, `broken` (the card or a frozen file cannot be read). |
| `laws show <id>` | Prints the card, and its figure as text if it is rendered. |
| `laws check` | Runs every check. One line per card, then `ALL LAWS HOLD`, or the failing cards with their last lines of output and `SOME LAWS FAIL` (exit 1). |
| `laws bite` | Runs every bite. A bite that passes, is missing, hangs or cannot be run is `TOOTHLESS` (exit 1). |
| `laws gate` | Prints `open` if every card is approved as it is now, else `closed` and why (exit 1). |
| `laws verify` | The same test as the gate, worded for CI. |
| `laws sign [<id>...]` | Asks the signer to approve the given cards, or all that are waiting or changed. |

Each check and each bite runs in its own process group with the card's time limit. When it ends or is stopped,
the whole group is killed and `laws` waits until it is gone.

A repository with no cards fails `check`, `bite`, `gate` and `verify`: nothing was checked.

## How approval works

1. **The hash.** A card's hash is the sha256 of the card file and of every frozen file with its path, each part
   prefixed with its length. A missing frozen file is an error.
2. **The approval.** An approval is a batch: `laws/approvals/<utc time>.manifest` holds one line `<id> <hash>`
   per card, and `<utc time>.manifest.sig` is an SSH signature over exactly those bytes
   (`ssh-keygen -Y sign -n laws`). Approvals are committed with the cards.
3. **The signers file.** `laws` accepts a signature only from a key in the allowed-signers file. It takes the file
   from `--signers <file>`, else from `LAWS_SIGNERS`, else `/etc/laws/allowed_signers`. A path inside the
   repository is refused, and there is no fallback. One line of it looks like this:
   `alex namespaces="laws" ssh-ed25519 AAAA...`
4. **The signer.** `laws` holds no key and cannot sign. `laws sign` runs every picked card's bite, refuses the
   batch if one is toothless, and then calls the signer command with `--repo <repo> --out <folder> <id>...`.
   It stores what comes back only if the manifest is exactly the list it asked for and the signature verifies
   against the signers file.

The signer is its own small program, `signer/signer.ts`, installed as `laws-signer`:

```
laws-signer --repo <path> --key <private key file> --log <file> --out <folder> <id>...
```

It reads the cards itself, computes the hashes itself, prints id, hash and title of each card, appends one line
to its log (time, key fingerprint, each `id=hash`), signs that list, and writes `manifest` and `manifest.sig`
into `--out`. It refuses the whole batch if a file is not a regular file inside the repository after following
symbolic links, or is larger than 1 MB. It never writes inside the repository.

A possible setup on one machine, with the key readable by root only. It is written from the design and was
not run: this repository was built without `sudo`.

```bash
sudo mkdir -p /etc/laws /root/laws
sudo ssh-keygen -t ed25519 -N "" -C "laws approvals" -f /root/laws/key
echo "alex namespaces=\"laws\" $(sudo cat /root/laws/key.pub)" | sudo tee /etc/laws/allowed_signers
export LAWS_SIGNER="sudo $(command -v laws-signer) --key /root/laws/key --log /var/log/laws-signer.log"
laws sign
```

What makes an approval count is the signers file that you or CI pass to `laws verify`. Anyone can run
`laws verify --signers some-other-file`; that proves nothing.

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
one; commit it if you want the pin.

`test/laws/tNN-*.test.ts` is the check of card T-NN and `tNN-*.bite.test.ts` is its bite. A bite imports the
property from its check and runs it against a variant that the bite file breaks on purpose, so every test in a
bite file fails. Both files are frozen with their card, so they use no shared helpers. The checks of T-01, T-02
and T-05 use generated cases; a failure prints `LAWS_SEED=<n>` to replay it. Tests create throwaway keys in a
temporary folder and remove it.

## Limits and what is not built yet

- **A process that leaves its group survives.** A check that starts a process in a new session (`setsid`) is not
  stopped by killing the group. Closing this needs a process namespace or a control group, and so one more
  program than Node and `ssh-keygen`.
- **Removing a card is not noticed.** The gate looks at the cards that exist. Retiring a law needs a signed record
  of its own, and so does protection against deleting or rolling back approvals; CI has to compare with `main`.
- **Figures are not hashed** unless the card lists them in `frozen`.
- **A bite can fail for the wrong reason.** A typo in the bite's path also exits 1. Only a missing program
  (exit 126 or 127) is caught.
- **The signer does not ask.** It prints the list and signs. The question to you is the `sudo` prompt today.
- **The signing server.** The signer reads the repository from a local path. A server reachable from the phone
  needs the cards sent to it.
- **No hooks, no CI job, no `laws page`, no grade lint.** `laws gate` and `laws verify` are the parts they will
  call.
- **Linux only.** Tested on NixOS with Node 24 and OpenSSH 10.
