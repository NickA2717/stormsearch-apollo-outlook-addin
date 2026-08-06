# stormsearch-apollo-outlook-addin

> ## HARD RULE — the account rulebook governs
> Self-review and knowledge capture live in `~/.claude-nalioto/CLAUDE.md` (the account rulebook, loaded in every session) — follow it in full, never copy it here. If anything in this file seems to conflict with it, the account rulebook wins.

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft so Apollo's auto follow-up continues from there. The front-end repo is public by necessity.

<!-- COMPOUND-LOOP:START (generated from /Users/nickmini/StormDev/compound-loop.md by sync_compound_loop.py — edit there, then run: python3 sync_compound_loop.py --write) -->
## How we work here (compound engineering)

Read this project's `learnings.md` at the start of a run; append new lessons at the end.

**Step 0 — read the Master Map before building or searching**, so nothing already built gets built twice: `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Master_Map.md`. Stamp over 2 days old: run `python3 ~/StormDev/master-map/generate.py` first.

**Never mint a new credential.** Every Microsoft 365 read and write has a standing hands-free route: reads via Storm Master Read, writes via `~/StormDev/m365-master-key/storm_write.py` (preview, then Nick confirms), admin PowerShell via the certificates. A new credential is a full stop and Nick's call.

**Record proactively, don't ask first.** File a lesson, decision or correction in its narrowest home immediately, then tell Nick in one line what and where. Only deploys, sends and deletes need sign-off first.

**Gitignore generated output by the generator's NAMING PATTERN, not today's filenames**, and run `git status` after adding any new output, before the auto-backup hook commits it for you. Client contact data reached a private repo twice in one day this way.

**Flag defects, don't launder them.** Never reframe a defect as a convention, and never quietly work around it: a downgraded defect ships as fact.

- **Mistake postmortem.** Fix it, then record the one rule that would have prevented it, dated, in the narrowest home: this `learnings.md`, the StormDev root `CLAUDE.md`, or the Brain's **Build_Patterns** playbook when it spans projects.
<!-- SELF-REVIEW:START (synced from the canonical self-review.md beside the close-session skill by sync_self_review.py — edit there) -->
- **Session self-review — MANDATORY, EXPLICIT, every session that did real work (no exceptions; "real work" = any file changed, tool run, or deliverable produced — when borderline, run it).** Before ending, answer honestly, to yourself, in these exact terms: **"Did anything go wrong, get redone, or take longer than it should have?"** — and hold yourself to it even when the answer is "Nothing." "Nothing" must survive these tests: near-misses count, already-fixed-mid-session counts, slow-but-successful counts, misfires caused by Nick's own instruction count, and a repeat of a past pattern counts even when this session's instance was small. A "here's what I did" summary does NOT satisfy it — that is journaling, not self-review. If the answer is anything other than "Nothing," then **for each issue** name the one rule that would have prevented it and record each in its narrowest home. **Reporting: silent by default (set 2026-07-23 at Nick's request — he wants the feature, not the chat notices). Never announce the self-review, its "Nothing" result, or the rules you recorded; the lessons land in their files and improve the next run on their own. Surface an item to Nick ONLY when its fix needs his decision — a new rule that conflicts with an existing one, or an approval (deploy/send/delete) waiting on him.**
<!-- SELF-REVIEW:END -->
- **Capture wins.** When a deliberate choice made something easy, record that as a rule too.

**Cross-project patterns** live at `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Playbooks/Build_Patterns.md` — scan before a new build; promote a lesson there on its third project.

**Growth rule.** A project with no `CLAUDE.md` or `learnings.md` gets both created then, seeded with these habits.
<!-- COMPOUND-LOOP:END -->
