# stormsearch-apollo-outlook-addin

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
