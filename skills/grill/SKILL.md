---
name: grill
description: "Interview Alex one question at a time, each with your recommended answer, until a request is clear enough to become laws. Use for /grill, or before building anything non-trivial from a vague request. Looks things up first and builds nothing."
disable-model-invocation: true
---

# Grill

Make the request clear before any law or code. Questions are cheap; building the wrong thing is not.

1. **Look first.** Read the project, its docs, git history, the memory folder (`~/.claude/projects/-home-alex/memory/`) and, if it came from a napkin idea, that file. Ask only what you cannot find.
2. **One question at a time.** Each comes with your recommended answer and the reason in one line, so he can say "yes" or "no, because...". Plain words, no jargon; say what a term means the first time.
3. **Keep a short list of what is decided.** Say it back now and then ("so far: ..."). Spot contradictions and say so.
4. **Aim at laws.** You are done when you could write each rule as a plain sentence about what must always be true, with one example. Ask for the outcomes he feels (noise, heat, who can approve, what must never leak), not for mechanisms.
5. **Say what cannot be met.** If something he wants cannot be guaranteed today, tell him now and why.
6. **When he says "your call",** decide, note it as your decision, and move on.

At the end show, in a fenced code block he can paste: the decisions, the draft laws (each: the sentence, one example, how strongly it can be checked), and what stays unknown. Mention `/sharpen` if he wants the request rewritten as a prompt. If the idea came from `/napkin`, mark it: `node ~/.claude/skills/napkin/scripts/napkin-save.mjs set-status <category/slug> explored --note "<one line>"`.

Build nothing. The next step is `/law`.

<!-- Written new for Alex (ukaz); the one-question-at-a-time interview follows Matt Pocock's grilling skill (MIT) in spirit. -->
