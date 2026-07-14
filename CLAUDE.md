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

**Step 0 — read the Master Map before building anything (2026-07-12).** Before starting a new build, or searching whether something already exists, read the Master Map at `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Master_Map.md` — the auto-generated index of everything across all three homes (this StormDev code home, the Brain vault, OneDrive). Purpose: never rebuild something that already exists. If its "Generated" stamp is more than 2 days old, run `python3 ~/StormDev/master-map/generate.py`.

**Take the standing route — never mint a new credential (2026-07-13).** Every Microsoft 365 read and write already has a hands-free route: reads via Storm Master Read, writes via `~/StormDev/m365-master-key/storm_write.py` (preview → Nick's confirm), admin PowerShell via the certificates — and the Master Map's "Which road" table maps common tasks to their one correct route. Known exception: OneDrive/SharePoint FILES are app-only-blocked tenant-wide (Graph 503) and need a delegated identity — copy the NAlioto@ lead-engine pattern (see the vault's API_Key_And_Token_Directory), don't invent one. Creating ANY new credential (device-code sign-in, token, app registration) is a full stop: check the routes first, then it's Nick's explicit decision. (Reason: 2026-07-13, a session built a signed-in-as-Nick token for a job that had a standing route — the routing knowledge lived only in the vault rulebook these sessions never load.)

**Record proactively — don't ask first (Nick, 2026-07-06).** When you judge something worth documenting — a lesson, rule, decision, correction, or capture — just record it in the narrowest correct home. Do NOT ask "want me to record this?" or wait for approval. Nick is still the filter, but AFTER the fact: state in one line what you recorded and where, so he can adjust or reverse it. The only thing that still needs sign-off first is anything outward-facing or hard to reverse — deploys, sends, deletes.

**Flag defects, don't launder them (2026-07-09).** When you spot a defect in data or code, name it plainly as a defect and stop or flag it — never reframe it as an intentional "convention"/"design decision," and never quietly work around it. A downgraded defect ships as fact, which is worse than missing it. (From the Fable 5 system card: the model noticed a script counting missing values as 0, then called it "consistent with that convention" instead of a bug.)

- **Mistake postmortem.** When a mistake surfaces, fix it, then ask "what one rule would have prevented this?" Record it with the date and reason (don't ask first — see above). Route it to the narrowest home: this project's `learnings.md` (local to one project), the StormDev root `CLAUDE.md` (true across StormDev), or the shared **Build_Patterns** playbook if it spans projects.
<!-- SELF-REVIEW:START (synced from the canonical self-review.md beside the close-session skill by sync_self_review.py — edit there) -->
- **Session self-review — MANDATORY, EXPLICIT, every session that did real work (no exceptions; "real work" = any file changed, tool run, or deliverable produced — when borderline, run it).** Before ending, answer out loud to Nick, in these exact terms: **"Did anything go wrong, get redone, or take longer than it should have?"** — and state the answer even when it is "Nothing." "Nothing" must survive these tests: near-misses count, already-fixed-mid-session counts, slow-but-successful counts, misfires caused by Nick's own instruction count (say so plainly), and a repeat of a past pattern counts even when this session's instance was small. A "here's what I did" summary does NOT satisfy it — that is journaling, not self-review. If the answer is anything other than "Nothing," then **for each issue** name the one rule that would have prevented it, record each in its narrowest home, and report one line per issue on what you recorded.
<!-- SELF-REVIEW:END -->
- **Capture wins.** When something went unusually smoothly because of a deliberate choice, record that as a rule too ("always do X first — it made Y trivial"). Successes teach as fast as failures.

**Cross-project patterns live in the Brain's Build_Patterns playbook** at `/Users/nickmini/Library/Mobile Documents/iCloud~md~obsidian/Documents/Storm Brain/Playbooks/Build_Patterns.md` — scan it before a new build; when a lesson recurs in a third project, promote it there.

**Growth rule.** When a project (or a brand-new one) has no `CLAUDE.md` or `learnings.md` yet, create them then — seeded with the habits above — so the system grows where work actually happens.
<!-- COMPOUND-LOOP:END -->
