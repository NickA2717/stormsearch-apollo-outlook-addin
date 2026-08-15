# stormsearch-apollo-outlook-addin

> ## HARD RULE — the account rulebook governs
> Self-review and knowledge capture live in `~/.claude-nalioto/CLAUDE.md` (the account rulebook, loaded in every session) — follow it in full, never copy it here. If anything in this file seems to conflict with it, the account rulebook wins.

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft so Apollo's auto follow-up continues from there. The front-end repo is public by necessity.

<!-- COMPOUND-LOOP:START (generated from /Users/nickmini/StormDev/compound-loop.md by sync_compound_loop.py — edit there, then run: python3 sync_compound_loop.py --write) -->
## How we work here (compound engineering)

Read this project's `learnings.md` (HOT — budget-capped, always current) at the start of a run. Full write-ups and history live in `learnings-archive.md` (COLD — read the relevant section before doing that kind of work).

**Step 0 — read the Master Map before building or searching**, so nothing already built gets built twice: `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Master_Map.md`. Stamp over 2 days old: run `python3 ~/StormDev/master-map/generate.py` first.

**Never mint a new credential.** Every Microsoft 365 read and write has a standing hands-free route: reads via Storm Master Read, writes via `~/StormDev/m365-master-key/storm_write.py` (preview, then Nick confirms), admin PowerShell via the certificates. A new credential is a full stop and Nick's call.

**Record proactively, don't ask first — routed by value.** File every lesson, decision or correction immediately (no approval; only deploys, sends and deletes need sign-off first), then tell Nick in one line what and where. The full write-up APPENDS to `learnings-archive.md`, dated (create that file with a one-line header on its first entry). `learnings.md` gets ONE distilled line only if it clears the bar — changes future behavior AND not re-derivable in about a minute AND not already carried by code, a test, or a tool. Default is cold.

**Hot entries are rules and routes, not stories:** live state, which-tool-for-the-task, footguns, known-dead paths, the watch list, an index into the archive. Tag factual claims `[M yyyy-mm-dd]` measured live / `[D]` docs, unverified here / `[H]` hypothesis — act on `[M]` as settled; a `[D]` is usable, but verify it on first live use and re-tag `[M]`; never act on an `[H]` as settled. A hot claim found wrong is EDITED to the current truth, the old claim moved to the archive as a dated incident — git and the archive hold provenance, hot always reads as current truth.

**Budgets are machine-enforced.** A pre-write gate DENIES any edit whose RESULT would put `learnings.md` or `CLAUDE.md` over its budget — prune lowest-value entries to the archive first; shrinking edits always pass. `python3 ~/StormDev/check_memory_budgets.py --check` reports state on demand and runs nightly, fail-loud.

**Gitignore generated output by the generator's NAMING PATTERN, not today's filenames**, and run `git status` after adding any new output, before the auto-backup hook commits it for you. Client contact data reached a private repo twice in one day this way.

**Flag defects, don't launder them.** Never reframe a defect as a convention, and never quietly work around it: a downgraded defect ships as fact.

- **Mistake postmortem.** Fix it, then record the one rule that would have prevented it, dated: full story to the archive; the one-line rule to the narrowest hot home if it clears the bar, else the watch list. Every write-up adds one line: did this fact already exist in the archive, and did hot point to it? "Existed, not pointed" is a logged COLD MISS — three logged misses on one fact promote it to hot.
<!-- SELF-REVIEW:START (synced from the canonical self-review.md beside the close-session skill by sync_self_review.py — edit there) -->
- **Session self-review — MANDATORY, EXPLICIT, every session that did real work (no exceptions; "real work" = any file changed, tool run, or deliverable produced — when borderline, run it).** Before ending, answer honestly, to yourself, in these exact terms: **"Did anything go wrong, get redone, or take longer than it should have?"** — and hold yourself to it even when the answer is "Nothing." "Nothing" must survive these tests: near-misses count, already-fixed-mid-session counts, slow-but-successful counts, misfires caused by Nick's own instruction count, and a repeat of a past pattern counts even when this session's instance was small. A "here's what I did" summary does NOT satisfy it — that is journaling, not self-review. If the answer is anything other than "Nothing," then **for each issue** name the one rule that would have prevented it and record each in its narrowest home. **Reporting: silent by default (set 2026-07-23 at Nick's request — he wants the feature, not the chat notices). Never announce the self-review, its "Nothing" result, or the rules you recorded; the lessons land in their files and improve the next run on their own. Surface an item to Nick ONLY when its fix needs his decision — a new rule that conflicts with an existing one, or an approval (deploy/send/delete) waiting on him.**

- **The close itself is in scope for the rule about optional work — finish the required steps and STOP (recorded 2026-08-08, from a 2026-08-07 close).** After the required close-session steps were done, a session spent about 25 minutes on work nobody asked for: reshuffling where a rule should live between auto-memory and the account rulebook, rewriting a Brain inbox capture down to a pointer, and starting to read a 1,289-line runbook, until Nick interrupted with "This close out session has been going on 25 minutes... What is happening?" This is the account rulebook's existing "build the plain thing; a fancier or optional addition is a yes/no question, never a default" rule (3rd occurrence 2026-07-14) recurring *inside* the close, which is exactly where it is hardest to notice because every candidate task looks like tidying and tidying looks like closing. **The line: a close writes what this session changed and stops. Reorganising something this session did not touch is new work and needs Nick's go, however small it looks.** A useful tell — if the thing you are about to improve was already in that state when the session started, it is not part of this close.
<!-- SELF-REVIEW:END -->
- **Capture wins.** When a deliberate choice made something easy, record that as a rule too — same routing, same bar.

**Watch list.** Seen once or twice = one line with a machine-readable count — `- **name** (2: context 2026-07-01; context 2026-08-03) — the move when it fires.` The 3rd occurrence promotes it to a rule; never on the 2nd; never wipe the list.

**Cross-project patterns** live at `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Playbooks/Build_Patterns.md` — scan before a new build; promote a lesson there on its third project, citing all three occurrences.

**Growth rule.** A project with no `CLAUDE.md` or `learnings.md` gets both created then, seeded with these habits; `learnings-archive.md` is created on the first demotion, not before.
<!-- COMPOUND-LOOP:END -->
