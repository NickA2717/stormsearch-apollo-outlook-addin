# stormsearch-apollo-outlook-addin

> ## HARD RULE — the account rulebook governs
> Self-review and knowledge capture live in `~/.claude-nalioto/CLAUDE.md` (the account rulebook, loaded in every session) — follow it in full, never copy it here. If anything in this file seems to conflict with it, the account rulebook wins.

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft so Apollo's auto follow-up continues from there. The front-end repo is public by necessity.

<!-- COMPOUND-LOOP:START (generated from /Users/nickmini/StormDev/compound-loop.md by sync_compound_loop.py — edit there, then run: python3 sync_compound_loop.py --write) -->
## How we work here (compound engineering)

Read `learnings.md` (HOT, budget-capped) first; full write-ups in `learnings-archive.md` (COLD — read its relevant section before such work).

**Step 0 — read the Master Map before building or searching:** `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Master_Map.md`. Stamp over 2 days old: run `python3 ~/StormDev/master-map/generate.py` first.

**Never mint a new credential.** M365 reads: Storm Master Read. Writes: `~/StormDev/m365-master-key/storm_write.py` (preview; Nick confirms). Admin PowerShell: certificates. New credential = full stop, Nick's call.

**Record proactively, don't ask first.** File every lesson, decision or correction immediately (only deploys, sends, deletes need sign-off); tell Nick in one line what and where. APPEND the full write-up, dated, to `learnings-archive.md` (one-line header on first entry). `learnings.md` gets ONE distilled line only if it changes future behavior AND isn't re-derivable in ~1 minute AND isn't carried by code, a test, or a tool. Default is cold.

**Hot entries are rules and routes, not stories.** Tag claims `[M yyyy-mm-dd]` measured live / `[D]` docs, unverified here / `[H]` hypothesis. `[M]` = settled; a `[D]` is usable — verify on first live use, re-tag `[M]`; never treat an `[H]` as settled. A wrong hot claim is EDITED to current truth; old claim → archive, dated incident.

**Budgets are machine-enforced.** A pre-write gate DENIES any edit that would put `learnings.md` or `CLAUDE.md` over budget — prune lowest-value entries to the archive first; shrinking edits pass. `python3 ~/StormDev/check_memory_budgets.py --check` reports; nightly, fail-loud.

**Gitignore generated output by the generator's NAMING PATTERN, not today's filenames**, and run `git status` after adding new output, before auto-backup commits it (client data hit a private repo twice in one day).

**Flag defects, don't launder them.** Never reframe one as a convention or quietly work around it.

- **Mistake postmortem.** Fix it; record the one dated rule that would have prevented it: full story to the archive; one line to the narrowest hot home if it clears the bar, else the watch list. Every write-up records: did the fact already exist in the archive, and did hot point to it? "Existed, not pointed" = logged COLD MISS; three misses on one fact promote it to hot.
<!-- SELF-REVIEW:START (synced from the canonical self-review.md beside the close-session skill by sync_self_review.py — edit there) -->
- **Session self-review — MANDATORY, EXPLICIT, every session that did real work (no exceptions; "real work" = any file changed, tool run, or deliverable produced — when borderline, run it).** Before ending, answer honestly, to yourself, in these exact terms: **"Did anything go wrong, get redone, or take longer than it should have?"** "Nothing" must survive these tests: near-misses count, already-fixed-mid-session counts, slow-but-successful counts, misfires from Nick's own instruction count, and a repeat of a past pattern counts even when small. A "here's what I did" summary is journaling, not self-review. If the answer is anything other than "Nothing," then for each issue name the one rule that would have prevented it and record it in its narrowest home. **Silent by default (Nick, 2026-07-23): never announce the self-review, its "Nothing" result, or the rules recorded; surface an item ONLY when its fix needs Nick's decision — a rule conflict, or an approval (deploy/send/delete) waiting on him.**

- **The close finishes the required steps and STOPS (2026-08-08: 25-min close of unasked tidying, Nick interrupted).** A close writes what this session changed and stops; reorganising anything this session did not touch is new work needing Nick's go, however small. The tell: already in that state at session start → not part of this close.
<!-- SELF-REVIEW:END -->
- **Capture wins.** When a deliberate choice made something easy, record it as a rule too — same routing, same bar.

**Watch list.** Seen once or twice = one line, machine-readable count — `- **name** (2: context 2026-07-01; context 2026-08-03) — the move when it fires.` 3rd occurrence promotes to a rule; never the 2nd; never wipe the list.

**Cross-project patterns**: `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Playbooks/Build_Patterns.md` — scan before a new build; promote on its third project, citing all three.

**Growth rule.** A project missing `CLAUDE.md` or `learnings.md` gets both then — `CLAUDE.md` seeded with the compound-loop POINTER, never a pasted copy; `learnings-archive.md` on first demotion only.
<!-- COMPOUND-LOOP:END -->
