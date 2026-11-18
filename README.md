# laws

Law cards for software that agents write.

A law is one sentence that must always hold, with a blocked case, an allowed case and a machine check.
You approve a law by signing it. `laws` keeps that approval tied to the exact text of the law and of its check,
so an agent can neither fake an approval nor change a law that you approved without you seeing it.

This is version 0. The tool's own laws are the eight cards in `laws/`, and its tests are their checks.

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
| `laws sign [<id>...]` | Asks the signer to approve the given cards, or all that are waiting or changed. |
| `laws retire <id>...` | Asks the signer to retire the given cards. Afterwards their files can be removed. |

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
2. **The manifest.** A signed batch is `laws/approvals/<name>.manifest` and `<name>.manifest.sig`, an SSH
   signature over exactly the bytes of the manifest (`ssh-keygen -Y sign -n laws`). They are committed with the
   cards. A manifest looks like this:

   ```
   signed: 2026-11-18T09:15:00.123Z
   T-01 14a27a861431c292118968a11be5981f88e48f8071a2a2eb23c48c0a74e87177
   T-03 retired
   ```

   The first line is the time the signer signed it. It orders the batches: a retirement ends every approval of
   that card signed up to then, and an approval counts only if it is later than the card's last retirement.
   The file name is not signed and means nothing.
3. **The signers file.** `laws` accepts a signature only from a key in the allowed-signers file. It takes the file
   from `--signers <file>`, else from `LAWS_SIGNERS`, else `/etc/laws/allowed_signers`. A path inside the
   repository is refused, and there is no fallback. One line of it looks like this:
   `alex namespaces="laws" ssh-ed25519 AAAA...`
4. **The signer.** `laws` holds no key and cannot sign. `laws sign` runs every picked card's bite, refuses the
   batch if one is toothless, and then calls the signer command with
   `--repo <repo> --out <folder> <id>... --retire <id>...`. The folder is private to you and is removed
   afterwards. `laws` stores what comes back only if the manifest is exactly the list it asked for, its time is
   later than the newest manifest already there, and the signature verifies against the signers file.
5. **Retiring.** A card that was approved cannot just be deleted: the gate closes with `missing`. Run
   `laws retire <id>` while the card is still there, confirm, and then remove the file. A retired id that comes
   back needs a new signature, by name: `laws sign <id>`.

The signer is its own small program, `signer/signer.ts`, installed as `laws-signer`:

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

Run `laws sign` and `laws retire` yourself, in a terminal. The signer has to be attached to it: started from a
program without a terminal, such as an agent's shell, it refuses.

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
bite file fails. Both files are frozen with their card, so they use no shared helpers. The checks of T-01, T-02,
T-05 and T-08 use generated cases; a failure prints `LAWS_SEED=<n>` to replay it. Tests create throwaway keys in
a temporary folder and remove it.

Tests have no terminal. The signer's main function takes the function that asks the question as an argument,
and tests pass a stand-in that answers. Where a test needs a signer command for `laws sign`, it writes a
three-line program that runs the real signer with such a stand-in. One test starts the real program without a
terminal and expects the refusal.

## Limits and what is not built yet

- **A terminal is not a person.** The signer refuses without a terminal, but a program can open a pseudo-terminal
  and type the word. What proves a person today is the `sudo` prompt, which does not show the list. A key that
  needs a touch for every signature, or the signing server with a passkey, would close this.
- **Approvals can be deleted together with the card.** The gate knows a card was approved only from the
  manifests in the repository. Whoever deletes a card and every manifest that names it leaves no trace there.
  CI has to check that `laws/approvals/` on a branch still holds every file that `main` holds.
- **What the process search cannot find.** A process that cleared its environment, changed user, or made
  itself unreadable (`ssh-agent` does) does not show the marker. If it also left the check's process group, it
  survives.
- **`bite-says` is a text match.** It proves that the bite failed with the expected message, not that the
  message is honest.
- **The signing server.** The signer reads the repository from a local path. A server reachable from the phone
  needs the cards sent to it.
- **No hooks, no CI job, no `laws page`, no grade lint.** `laws gate` and `laws verify` are the parts they will
  call.
- **Linux only.** The signer and the process search read `/proc`. Tested on NixOS with Node 24 and OpenSSH 10.
