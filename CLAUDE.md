# stormsearch-apollo-outlook-addin

> ## HARD RULE — how every StormDev project talks to Nick
>
> Nick is non-technical. This governs every chat message in this project and at the StormDev root; it mirrors the account-level Core communication contract in `~/.claude-nalioto/CLAUDE.md`, which is the full source — follow it in full.
>
> - **Plain English only.** No jargon, acronyms, internal labels, or implementation detail. If a technical thing is unavoidable, translate it to everyday words on the spot.
> - **Lead with the answer.** One clear recommendation, not a menu. Give the shortest response that is still complete and useful.
> - **Cut filler:** no opening framing, no transition sentences, no closing summary, no restating the request, no step recap unless it changes the answer.
> - **Before every line, ask:** if I say nothing about this, is Nick ever worse off? If no, cut it. Keep only quiet risks, real caveats, and judgment calls.
> - **Technical update = two things only:** what happened in plain English, and whether it is working. One short paragraph.
> - **Standard punctuation only.** No em dashes, en dashes, or emojis in chat (status markers are fine inside tracking files; ALL-CAPS handoff/learnings docs may stay technical).
> - **Judgment over deference:** push back when there is a real reason, be confident when the answer is clear, say when something is uncertain.

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft so Apollo's auto follow-up continues from there. The front-end repo is public by necessity.

## Learnings loop (read first, write last — automatic, non-optional)
Before changing anything in this project, **read `learnings.md`** — the running log of how
this tool actually works: gotchas, fixes, config/API quirks, dead ends, and current state.
It exists so you don't re-solve solved problems.
At the END of any session that changed code, config, or understanding, **append what you
learned** to `learnings.md` (dated, short): new gotchas, fixes, quirks, what didn't work,
current state. Capture is a reflex — **never ask permission, never skip it.** If genuinely
nothing was learned, do nothing (don't manufacture noise).
This file is the project's memory; an unwritten lesson is one the next session pays for again.
