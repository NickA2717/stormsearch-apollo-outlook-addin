# stormsearch-apollo-outlook-addin — learnings (HOT — budget-capped)

**Every full write-up is VERBATIM in `learnings-archive.md`** ("hot-file migration — 2026-08-14") — the seven-pass formatter spec, CORS/image Worker details and the reliability-overhaul story live there. New write-ups APPEND there; this file stays under the fleet budget (`python3 ~/StormDev/check_memory_budgets.py --check`).

## Do NOT re-research (confirmed hard limits)

- **Apollo's "Reply" step can ONLY thread to a Message-ID Apollo itself sent** — no API knob, no setting, no override for externally-sent Outlook mail.
- **Apollo's API sends CORS headers only to its own extension + Salesforce** — all browser calls route through the permanent Cloudflare Worker proxy.
- **Apollo's editor is TinyMCE** (`forced_root_block:'p'`): top-level `<div>` rewrites to `<p>` on load; inline styles DO stick — style the content, don't fight the block structure.
- Signature logos are `cid:` attachments invisible to Apollo recipients — the permanent inline-image Worker hosts each attachment's bytes at push time.

## Design decisions (Nick's)

- 2 clicks in Outlook + 1 in Apollo; sequence dropdown = ACTIVE only; sender picked per push; contact lookup always shows name+title+company+last-activity for verification, auto-create on no match.
- Canonical outbound HTML: one `<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">` per logical line, `&nbsp;` divs for blanks, single font, no Mso clutter.
- HTML cleanup = `thread-formatter.js` (the core IP): DOMParser tree walk, seven passes (spec in archive) — signature images preserved per Nick.

## Reliability rules (each bit live; stories in archive)

- **Read the compose body at CLICK time, never pane-load** (bug 1 of the three that made pushes unreliable).
- **"Green success but nothing in Apollo" was real** — verify the artifact exists in Apollo after push, not the HTTP status (2026-07-22 overhaul, live as v=20260722a).
- **Test formatter changes against a REAL captured Outlook body** — a defect shipped past green synthetic tests because no fixture carried OWA's actual link serialization; keep a recent real capture as a fixture.
- Re-test loop: wait for GitHub Pages redeploy (~1-2 min, curl-poll the version), then hard-refresh the Outlook tab — Office iframes cache aggressively even with version params.
- Open item: `item.close({discardItem:true})` doesn't reliably delete the draft on new Outlook for Mac (mitigations layered; details in archive).

## Security

- The Apollo API key lives ONLY in roaming settings via the add-in's Settings panel — never in files, repo, or chat (rotated once after a chat leak).
