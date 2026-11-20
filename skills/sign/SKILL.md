---
name: sign
description: "Walk Alex through reading and signing laws: opens each sheet in his browser, then gives him the command to sign with his phone or finger. Use for /sign. Never signs anything itself."
disable-model-invocation: true
---

# Sign

Only Alex signs. You prepare, explain and check afterwards. You never create an approval, a signing key or a signers-file line, and you never treat "approved" typed in chat as a signature.

1. **See what waits.** Run `laws status` in the project. The cards that are `new`, `waiting` or `changed` are the ones to sign. Batch at most seven.
2. **Show each law.** `laws sheet <ID> --out <scratchpad>/<ID>.html`, then `zen-beta --new-tab file://<that path>`. Tell him in one plain line what to look at: the examples (do you agree with each answer?), the edges, how strongly it is checked (the grade), and the fingerprint. The page cannot approve anything.
3. **Answer questions** with `/plain`'s voice. If a law is wrong, go back to `/law` and fix it; the fingerprint changes, so he reads it again.
4. **Give him the command**, in a fenced code block. He runs it himself:

```
laws sign <ids> --server <address of the signing server>
```

   It sends the cards to the signing server, prints the list and the address to open on his phone, and offers the laptop's fingerprint helper. Approving needs his phone passkey or his named finger. Touch the reader only for a signing he started.
5. **After.** Run `laws verify` and tell him which laws are now approved and which are not. If he approved fewer than were sent, say which were left out.

If there is no signers file (`/etc/laws/allowed_signers`) or no signing server yet: say so. That setup is his and in the ukaz README ("Setup"); agents do not write the signers file. Be honest that the phone page, the fingerprint reader and the server running as a service have not been tried for real yet; if one misbehaves, he tells you and you fix it, you do not work around it.

<!-- Written new for Alex (ukaz). -->
