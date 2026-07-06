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

<!-- COMPOUND-LOOP:START (generated from /Users/nickmini/StormDev/compound-loop.md by sync_compound_loop.py — edit there, then run: python3 sync_compound_loop.py --write) -->
## How we work here (compound engineering)

Each project carries its own `learnings.md` — read it at the start of a run, append new lessons at the end. On top of that, three habits run every session.

**Record proactively — don't ask first (Nick, 2026-07-06).** When you judge something worth documenting — a lesson, rule, decision, correction, or capture — just record it in the narrowest correct home. Do NOT ask "want me to record this?" or wait for approval. Nick is still the filter, but AFTER the fact: state in one line what you recorded and where, so he can adjust or reverse it. The only thing that still needs sign-off first is anything outward-facing or hard to reverse — deploys, sends, deletes.

- **Mistake postmortem.** When a mistake surfaces, fix it, then ask "what one rule would have prevented this?" Record it with the date and reason (don't ask first — see above). Route it to the narrowest home: this project's `learnings.md` (local to one project), the StormDev root `CLAUDE.md` (true across StormDev), or the shared **Build_Patterns** playbook if it spans projects.
<!-- SELF-REVIEW:START (synced from the canonical self-review.md beside the close-session skill by sync_self_review.py — edit there) -->
- **Session self-review — MANDATORY, EXPLICIT, every session that did real work (no exceptions).** Before ending, answer out loud to Nick, in these exact terms: **"Did anything go wrong, get redone, or take longer than it should have?"** — and state the answer even when it is "Nothing." A "here's what I did" summary does NOT satisfy it — that is journaling, not self-review. If the answer is anything other than "Nothing," name the one rule that would have prevented it, record it in the narrowest home, and report in one line what you recorded.
<!-- SELF-REVIEW:END -->
- **Capture wins.** When something went unusually smoothly because of a deliberate choice, record that as a rule too ("always do X first — it made Y trivial"). Successes teach as fast as failures.

**Cross-project patterns live in the Brain's Build_Patterns playbook** at `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Playbooks/Build_Patterns.md` — scan it before a new build; when a lesson recurs in a third project, promote it there.

**Growth rule.** When a project (or a brand-new one) has no `CLAUDE.md` or `learnings.md` yet, create them then — seeded with the habits above — so the system grows where work actually happens.
<!-- COMPOUND-LOOP:END -->
