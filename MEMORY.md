# Storm Search × Apollo × Outlook Add-in — Project Memory

> **Purpose of this file:** capture everything Claude needs to know about this project to operate efficiently in future sessions without re-explaining context.

---

## Project Goal

Build an Outlook add-in that lets Nick:
1. Type a reply to a contact in Outlook (using Outlook as a familiar editor)
2. Click a "Push to Apollo Sequence" button inside Outlook
3. Have the add-in:
   - Look up the contact in Apollo by recipient email (with confirmation popup)
   - Add the contact to a chosen Apollo sequence
   - Push the typed reply + formatted HTML thread context into step 1 (Manual email) of that sequence
   - Discard the Outlook draft so it doesn't clutter Drafts folder
4. Hop to Apollo, click Send on step 1 → Apollo handles steps 2 and 3 automatically

**Outcome:** collapses Nick's current 7+ step manual paste workflow into 2 clicks in Outlook + 1 click in Apollo.

---

## Critical Technical Findings (do not re-research these)

### Apollo threading limitations — confirmed
- Apollo's "Reply" step type can ONLY thread to a Message-ID Apollo itself sent
- Apollo CANNOT thread to externally-sent (Outlook) emails — there is no public API knob, no add-in setting, no manual override
- Apollo's documented "It isn't possible to manually log an email without sending it through Apollo" applies
- The Apollo Chrome Extension "follow-up sequence" feature on Gmail is the only native path to true `In-Reply-To` threading; this is **Gmail-only**, not available in Outlook

### Soft threading is acceptable
- Nick has been running copy/paste HTML threads long enough to confirm subject-based "soft" threading works in practice
- Email clients (Gmail, Outlook web, Apple Mail) visually group by `Re:` subject normalization even without `In-Reply-To` headers
- This means the add-in's job is to AUTOMATE the manual paste workflow, not invent new threading

### Custom field HTML workaround — DEAD
- Apollo custom fields are stored as plain text
- When Apollo plugs `{{custom_field}}` into a template body, HTML tags are escaped (rendered as literal `<div>`, etc.)
- Snippets and templates support HTML but are global, not per-contact
- **Conclusion:** Step 1 MUST be type "Manual email" (the only way to get per-contact HTML body)

### Step 1 Manual email — confirmed working
- API: `POST /v1/emailer_campaigns/{id}/add_contact_ids` adds contact instantly
- Apollo UI: manual email task is editable, accepts plain text + HTML
- Tested 2026-04-25 with contact 669565d590f1de068d9de29a (Anthony Alioto) → Claude Test sequence
- Test contact removed after verification

### API body push — to be tested during build
- The MCP tools available in this Claude session do NOT expose an "update emailer_message body" endpoint
- Apollo's public REST API likely has `PUT /v1/emailer_messages/{id}` or similar — needs to be probed during build with Nick's API key
- **Fallback if API push doesn't work:** add-in copies HTML to clipboard, Nick pastes in Apollo manually. Still way better than today's workflow.

---

## Key Apollo Account Details

| What | Value |
|---|---|
| User ID | `65728046753a5c021b66c1cc` |
| Default sender mailbox | `nicka@stormrecruit.com` |
| Default sender mailbox ID | `66254b6ec24bd301c7b44e44` |
| Test sequence name | CLAUDE TEST |
| Test sequence ID | `69eca35c338653001948481d` |
| Test sequence step 1 ID | `69eca35c338653001948481e` (manual email, new thread) |
| Test sequence step 2 ID | `69eca35c338653001948482f` (auto email, reply to thread, 78h wait) |
| Test sequence step 3 ID | `69eca35c3386530019484832` (auto email, reply to thread, 101h wait) |
| Sequence-level auto-finish on reply | `mark_finished_if_reply: true` |
| Same-account reply delay | 30 days |

Nick has many sender mailboxes (~50+ Nick-prefixed alone, across multiple cold-email "burner" domains like `stormsearch-eng.com`, `stormsearch-mfg.com`, etc). He picks sender per push for now.

---

## User Decisions & Preferences

- **Communication style:** plain language, no jargon, simple explanations
- **Sequence dropdown:** lists all ACTIVE sequences (filter `active: true`)
- **Sender mailbox:** picked per push (not auto-defaulted yet, may change later)
- **Contact lookup:** dropdown with name + title + company + last activity to verify, even when there's only one match. Auto-create if no match — popup asks first.
- **Step 1 type:** Manual email (not automatic — automatic doesn't support per-contact body)
- **Outlook draft after push:** auto-discard via `Office.context.mailbox.item.close({discardItem: true})`
- **API key storage:** local only via `Office.context.roamingSettings`, never in code, never sent to anyone except Apollo
- **Hosting:** GitHub Pages on Nick's account (`NickA2717`)
- **Repo name:** `stormsearch-apollo-outlook-addin`
- **Outlook flavor:** new Outlook for Mac + web (both supported by this add-in)
- **MS 365 admin:** Nick has full admin access; will sideload when instructed

---

## Conversation Journey (high-level)

1. Started with Nick wanting Claude to build an HTML thread snippet from a `.eml` file for Apollo paste
2. Identified the manual workflow was repetitive → discussed automation
3. Considered macOS Quick Action vs Outlook Add-in
4. Pivoted to Outlook Add-in because:
   - Cleanest in-Outlook UX (button right in the reply window)
   - Auto-deletes the draft (Quick Action can't reliably do this)
5. Researched Apollo's threading rules in depth — found the gap above
6. Tested API enrollment + manual step body editability in Apollo UI — both confirmed
7. Committed to the Outlook Add-in build

---

## Architecture (planned)

**Files:**
- `manifest.xml` — Office Add-in manifest (URL pointers, permissions, button placement)
- `taskpane.html` — main popup UI (contact picker, sequence dropdown, sender picker, confirm button)
- `taskpane.css` — styling (will use Microsoft's Fluent UI for consistency)
- `taskpane.js` — Office.js + Apollo API logic
- `settings.html` — API key entry page (stored in Office roaming settings)
- `assets/` — icons (16/32/64/128 px) for the manifest

**Apollo API endpoints used:**
1. `POST /v1/emailer_campaigns/search` (filter active=true) → sequence list
2. `POST /v1/email_accounts/search` or similar → sender mailbox list
3. `POST /v1/contacts/search` (q_keywords = recipient email) → contact lookup
4. `POST /v1/contacts` → create contact if missing
5. `POST /v1/emailer_campaigns/{id}/add_contact_ids` → enroll contact
6. `PUT /v1/emailer_messages/{id}` (TBD) → push body to step 1 manual email

**Office.js APIs used:**
- `Office.context.mailbox.item.body.getAsync()` — read draft body
- `Office.context.mailbox.item.to.getAsync()` — recipients
- `Office.context.mailbox.item.subject.getAsync()` — subject
- `Office.context.mailbox.item.itemId` — for thread context (used with EWS or REST to fetch the parent thread)
- `Office.context.mailbox.item.close({discardItem: true})` — discard draft
- `Office.context.roamingSettings.get/set('apolloApiKey')` — API key persistence

**HTML thread formatter:**
- Reuses the same Outlook-native HTML structure we designed for Nick's manual workflow
- Inserts `[Type your response here]` placeholder above the thread
- Renders `From:/Date:/To:/Subject:` divider blocks between messages
- Strips inline images (Nick confirmed text-only is more authentic than broken image placeholders)

---

## Build Phases (current)

- ✅ Phase 0: Project folder created
- ✅ Phase 1: GitHub repo + tooling (gh CLI auth as NickA2717; git config set)
- ✅ Phase 2: All code written — manifest.xml, taskpane (HTML/CSS/JS), apollo.js, thread-formatter.js
- ✅ Phase 3: Deployed to GitHub Pages at https://nicka2717.github.io/stormsearch-apollo-outlook-addin/
- ✅ Phase 4: Sideloaded via M365 admin center; took ~hours to propagate (Microsoft normal range)
- ✅ Phase 5: Add-in loads in Outlook (button + task pane confirmed)
- ✅ Phase 6: Apollo CORS block diagnosed — Apollo doesn't allow direct browser fetch from our origin
- ✅ Phase 7: Cloudflare Worker proxy built + deployed at `https://stormsearch-apollo-proxy.n-alioto7.workers.dev`
- ✅ Phase 8: apollo.js routed through proxy; mailboxes/contacts/sequences load
- ✅ Phase 9: First successful end-to-end push (Todd Shertzer @ Bench Dogs into Claude Test) verified via post-PUT GET
- ✅ Phase 10: Pushes are reliable; all retries/verification logic in place; console logs available
- ✅ Phase 11: HTML output cleanup — DOM-based formatter, minimal stripping, inline `margin:0` for tight spacing, image-leftover paragraph removal. Apollo render now matches Outlook closely.
- 🔄 Phase 12: Final visual polish iterations as Nick reports specific issues
- ⏳ Phase 13: Address Outlook draft persistence (close() doesn't always discard on new Outlook for Mac — currently using marker-text + best-effort discard)
- ⏳ Phase 14: Optional future enhancement — split Nick's typed reply from quoted thread, render his portion using clean Storm Search Calibri 12pt template, leave thread untouched

## CORS Proxy (Cloudflare Worker)

- Source: `worker/src/index.js`
- Wrangler config: `worker/wrangler.toml`
- Cloudflare account: `e66e78179c050c20a8e3844aa669089a` (n.alioto7@yahoo.com)
- Workers subdomain: `n-alioto7.workers.dev` (auto-assigned)
- Worker URL: `https://stormsearch-apollo-proxy.n-alioto7.workers.dev`
- Health endpoint: `/health` returns `{ok:true,target:"https://api.apollo.io",time:...}`
- Origin allowlist: `nicka2717.github.io`, `outlook.office.com`, `outlook.cloud.microsoft`, plus Office 365 iframe hosts

**Important deploy gotcha:** wrangler can't build from paths containing asterisks (folder name `*CLAUDE CODE - WORK*` breaks esbuild — interprets asterisks as glob wildcards). Workaround: copy `worker/` to a clean path like `/tmp/sapw` before running `wrangler deploy`.

## What's Working

- ✅ Add-in button appears in Outlook compose ribbon
- ✅ Settings panel takes Apollo API key (stored in roaming settings, never in repo or chat)
- ✅ Contact lookup by recipient email (with multi-match dropdown when 2+ found)
- ✅ Mailbox dropdown populated from Apollo's email_accounts
- ✅ Sequence dropdown populated from active sequences
- ✅ "Push to Apollo" enrolls contact in chosen sequence
- ✅ Body push to step 1 (Manual email) works via API — verified by post-PUT GET
- ✅ Search retries on enrollment race (queued message takes a moment to materialize)
- ✅ Console logging throughout (`[push]` and `[apollo]` prefixes) for debugging
- ✅ Failure modes surface in the result banner with explicit reason
- ✅ HTML output looks like a real Outlook thread (tight spacing, authentic fonts, no image gaps)

## HTML Cleanup Strategy — final design

`thread-formatter.js` uses browser-native `DOMParser` to walk the compose body as a tree. Five cleanup passes:

1. **Strip security/non-rendering elements**: `<script>`, `<style>`, `<noscript>`
2. **Strip images and embedded media**: `<img>`, `<video>`, `<object>`, `<embed>` — per Nick's preference (broken placeholders look worse than absent images). After stripping, run an iterative pass that removes paragraphs/divs left functionally empty (no text, no `<br>`, no named anchor) — this collapses the layout space that image wrappers leave behind, especially in vendor signatures (Bench Dogs logo). NBSP (U+00A0) is treated as content so intentional `<p>&nbsp;</p>` blank lines survive.
3. **Strip Office namespace tags**: `<o:p>`, `<v:imagedata>`, `<w:WordSection>`, `<m:math>`, `<st1:place>` — these don't render outside Outlook. Text content (rare) is preserved as a text node.
4. **Strip Outlook ATP banners**: orange-background spans / paragraphs containing only "EXTERNAL" or "[EXTERNAL]" — Defender for Office 365 injects these on incoming external emails. Not part of the conversation.
5. **Force inline `margin: 0` on all `<p>` and `<div>`**: this is the key visual fix. Outlook's compose engine emits `<p class="MsoNormal">` blocks assuming Outlook's stylesheet (margin: 0) renders them tight. Apollo's TinyMCE editor doesn't ship that CSS so `<p>` picks up browser default ~16px margins, which compound visibly on Outlook's `<p>&nbsp;</p>` blank-line spacers. Inline `margin: 0` neutralizes the default. Elements with explicit margin (e.g., `margin-bottom: 12pt` on the From-block) are skipped — explicit Outlook margins stay intact.

Then wrap the cleaned body in a default Calibri/Tahoma 12pt font block (matches Nick's preferred Storm Search outbound style). Nested children with their own font declarations still render in those fonts (preserving authentic mixed-sender thread appearance).

## What Needs Work

- 🔧 **Outlook draft persistence** (Phase 13): `Office.context.mailbox.item.close({ discardItem: true })` doesn't reliably delete the draft on new Outlook for Mac. Mitigations in place:
  1. Try modern `closeBehavior: CloseBehavior.Discard` first (Mailbox 1.10+)
  2. Fall back to legacy `discardItem: true`
  3. Before closing, replace body with marker text "[Pushed to Apollo — safe to delete this draft]" so any persisted drafts are obviously stale leftovers, not duplicates of what was pushed
  Long-term option: bump manifest to require Mailbox 1.10+, or use Microsoft Graph to delete drafts server-side if local close still doesn't work reliably.

## Apollo Editor Quirks (lessons learned)

- **Apollo's editor is TinyMCE-based** (toolbar layout, behavior). Critical implication: `forced_root_block: 'p'` is its default, meaning top-level block `<div>` elements get rewritten to `<p>` on load. We tried converting `<p>` → `<div>` in our formatter — it didn't stick because Apollo undoes it. Inline styles (like `margin: 0`) DO survive the editor round-trip cleanly, so that's the pattern that works.
- **CORS via Cloudflare proxy is non-negotiable**: Apollo's API only sends `Access-Control-Allow-Origin` for their own Chrome extension and Salesforce. Browser fetches from anywhere else (including our github.io origin and Office iframes) fail at preflight. The Worker proxy at `stormsearch-apollo-proxy.n-alioto7.workers.dev` is permanent infrastructure for this.
- **Apollo creates emailer_messages asynchronously** after `add_contact_ids`. Search-then-PUT-body must retry to dodge the race. Current retry: up to 4 attempts with 600ms backoff.
- **Verify body push after PUT**: GET the message back and confirm `body_html` matches what was sent. Catches silent server-side failures (rare but happened once during testing).
- **Cache-busting matters**: Office Add-in iframes cache aggressively. We append `?v=YYYYMMDDx` query strings to all script/CSS URLs from `taskpane.html`, plus emit `<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">` on the HTML itself. Bump the version letter on every code change.

## Nick's Preferred Storm Search Outbound HTML Style

When Nick (or Storm Search) writes an outbound email body in a sequence template,
the canonical clean HTML looks like:

```html
<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">NAME</div>
<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">&nbsp;</div>
<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">PARAGRAPH</div>
<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">&nbsp;</div>
<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">PARAGRAPH</div>
```

Pattern:
- One div per logical line
- Empty `<div>&nbsp;</div>` blocks for blank lines
- Single font: Calibri, Tahoma, sans-serif at 12pt
- No nested spans, no Mso clutter, no mixed colors

Current approach: we wrap the cleaned-up Outlook body in a `<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">` block, which becomes the default font. Nested children that explicitly set their own font (Todd's Verdana signature, etc.) still render in those fonts — that's authentic.

**Possible future enhancement (per Nick's "last resort" idea):** detect the boundary between Nick's typed reply and the quoted thread (Outlook marks it with `<a name="_MailOriginal">` or `<div id="divRplyFwdMsg">`), and re-render Nick's portion using the clean Storm Search template. Quoted thread stays as-is.

## Test Status

- 2026-04-26: Confirmed Todd Shertzer (Bench Dogs) push to Claude Test sequence with full body landed in Apollo. Verified via console logs (`[apollo] verify body length: 23490`) and Apollo task-panel screenshot.
- 2026-04-26: Resolved compounding-margin gap in quoted threads — was caused by Apollo's editor not having Outlook's MsoNormal `margin:0` CSS. Fixed by inlining `margin: 0` on every `<p>`/`<div>` during cleanup.
- 2026-04-26: Resolved Bench Dogs logo gap in Todd's signature — was caused by image-stripping leaving empty `<p><span></span></p>` wrappers. Fixed by iterative cleanup pass that removes functionally empty paragraphs while preserving NBSP/`<br>`/anchor content.
- 2026-04-26: Test contacts removed manually by Nick after each test.

## Current Cache-Bust Version

`v=20260426h` — bump the trailing letter on every code change so Office Add-in iframes pick up the new code instead of serving cached versions.

## Quick Re-Test Procedure

Whenever code changes ship:
1. Wait for GitHub Pages to redeploy (~1-2 min); a background curl-poll confirms the new version is live.
2. Hard-refresh the Outlook tab (Cmd+Shift+R) — Office iframes cache aggressively even with version params on script URLs.
3. Open a fresh Reply window in Outlook (existing reply windows hold stale code).
4. Click Push to Apollo → confirm task pane loads → pick mailbox + sequence → push.
5. Compare result in Apollo's editor against Outlook's render. Optionally Cmd+A → copy → paste into a chat to inspect raw HTML.
6. Always remove the test contact from the sequence afterward (manual via Apollo UI, or "remove [name]" to claude).

## Useful Debugging Recipe

If a push misbehaves:
1. Open Chrome DevTools → Console tab BEFORE clicking Push
2. Click Push and watch for `[push]` and `[apollo]` log lines
3. The result banner in the task pane will show the explicit failure reason if anything broke (e.g., `verify_mismatch`, `put_rejected`, `message_not_found`)
4. The console logs include: HTML length being pushed, the message ID Apollo created, the post-PUT GET verification result
5. If problem is in the formatter (HTML looks wrong but push succeeded): paste the resulting HTML from Apollo back to Claude — the formatting step is local to the browser, so server logs won't help

## Repo & Hosting

- GitHub repo: https://github.com/NickA2717/stormsearch-apollo-outlook-addin (public)
- GitHub Pages URL: https://nicka2717.github.io/stormsearch-apollo-outlook-addin/
- Manifest URL: https://nicka2717.github.io/stormsearch-apollo-outlook-addin/manifest.xml
- M365 admin deployment: "Push to Apollo Sequence" deployed to Nick (Specific user)
- App ID (from manifest): `a8473972-6583-4df4-b72a-56f556e9f059`

---

## Open Questions / TODO

- Confirm exact Apollo REST endpoint for updating queued manual email body (probe during build with Nick's API key)
- Decide whether to fetch full Outlook thread context via EWS / REST, or just use what's in the current compose body (Outlook's default reply quote already includes the thread, so likely the latter)
- Add error handling for: contact not found, sequence add failure, draft read failure
- Future polish: pin go-to sequences to top of dropdown, recent-contacts memory, multi-mailbox routing rules

---

## Security Notes

- Apollo API key was rotated by Nick after a chat-based leak (2026-04-25)
- New key is stored locally on Nick's machine ONLY (not in this memory file, not in repo, not in any chat)
- Never paste API key in chat or code — always enter directly in the add-in's settings panel

---

## Related Memory References

- `/Users/nickmini/.claude/projects/-Users-nickmini--CLAUDE-CODE---WORK-/memory/MEMORY.md` — Nick's global auto-memory
- `feedback_approved_folder.md` — file output goes to `/Users/nickmini/*CLAUDE CODE - WORK*/` only
- `reference_apollo_sequence_extraction.md` — Apollo API endpoints, auth, flow
- `project_tracker_apollo_bridge.md` — TrackerRMS↔Apollo Chrome extension (separate project, may share patterns)
