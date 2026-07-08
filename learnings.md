---
title: Storm Search Apollo Outlook Add-in — Learnings
type: learning
project-kind: code
status: active
updated: 2026-06-28
tags: [learning, project, apollo, outlook, addin]
related:
  - "[[Storm Search Apollo Outlook Add-in]]"
  - "[[+ Code Projects]]"
---

# Storm Search × Apollo × Outlook Add-in — Project Memory

> **Purpose:** the reusable context + gotchas for this project — what the runtime can't hold.
> Setup/architecture/endpoints are in `README.md`; "what happened" is in the session logs.
> Status: **built and working** (end-to-end pushes are reliable). One open item: draft persistence.

> **Consolidated 2026-06-28** (StormDev learnings pass): cut the conversation journey, the
> build-phases checklist, the dated Test-Status diary, the live cache-bust version (the code carries
> it + `taskpane.html` explains the bump rule), and the stale `*CLAUDE CODE - WORK*` memory pointers.
> Promoted: key-leak rule → README. Payload below is the technical findings + design decisions.

---

## What it does (goal)

Collapses Nick's old 7+ step manual paste workflow into 2 clicks in Outlook + 1 in Apollo: type a
reply in Outlook → click **Push to Apollo** → the add-in looks up the contact, enrolls them in a chosen
sequence, pushes the typed reply + formatted HTML thread into step 1 (Manual email), and discards the
Outlook draft. Nick hops to Apollo and clicks Send on step 1; Apollo runs steps 2–3 automatically.

---

## Critical technical findings (do NOT re-research)

### Apollo threading limitations — confirmed
- Apollo's "Reply" step type can ONLY thread to a Message-ID Apollo itself sent. It CANNOT thread to
  externally-sent (Outlook) emails — no public API knob, no add-in setting, no manual override.
- The Apollo Chrome Extension "follow-up sequence" feature is the only native path to true
  `In-Reply-To` threading, and it's **Gmail-only** — not available in Outlook.
- **Soft threading is the accepted answer.** Email clients visually group by `Re:` subject
  normalization even without `In-Reply-To`. So the add-in's job is to AUTOMATE the manual paste
  workflow, not invent threading.

### Step 1 MUST be a "Manual email" — the HTML constraint
- Apollo custom fields store plain text; when plugged into a template body via `{{custom_field}}`, HTML
  tags are escaped (render as literal `<div>`). Snippets/templates support HTML but are global, not
  per-contact. **The only way to get a per-contact HTML body is a "Manual email" step.**
- Body push works via the API: `POST /v1/emailer_campaigns/{id}/add_contact_ids` enrolls, then
  `PUT /v1/emailer_messages/{id}` sets the body (verified by post-PUT GET). **Fallback if PUT ever
  fails:** add-in copies HTML to clipboard, Nick pastes in Apollo manually.

### Key Apollo account details
| What | Value |
|---|---|
| User ID | `65728046753a5c021b66c1cc` |
| Default sender mailbox / ID | `nicka@stormrecruit.com` / `66254b6ec24bd301c7b44e44` |
| Test sequence (CLAUDE TEST) ID | `69eca35c338653001948481d` |
| — step 1 (manual email, new thread) | `69eca35c338653001948481e` |
| — step 2 (auto, reply to thread, 78h wait) | `69eca35c338653001948482f` |
| — step 3 (auto, reply to thread, 101h wait) | `69eca35c3386530019484832` |
| Sequence auto-finish on reply | `mark_finished_if_reply: true` |
| Same-account reply delay | 30 days |

Nick has many sender mailboxes (~50+ Nick-prefixed, across burner domains like `stormsearch-eng.com`,
`stormsearch-mfg.com`); he picks sender per push for now.

---

## Design decisions & preferences

- **Sequence dropdown** lists ACTIVE sequences only (`active: true`). **Sender mailbox** picked per push.
- **Contact lookup** is a dropdown with name + title + company + last activity to verify, even on a
  single match. Auto-create if no match — popup asks first.
- **Step 1 type** = Manual email (automatic doesn't support a per-contact body).
- **Outlook draft after push** = auto-discard (see open item below — unreliable on new Outlook for Mac).
- **API key storage** = local only via `Office.context.roamingSettings`, never in code/repo/chat.
- **Hosting** = GitHub Pages on `NickA2717`; new Outlook for Mac + web both supported; Nick has M365
  admin and sideloads when instructed.

### Office.js APIs used (not in README)
- `item.body.getAsync()` (read draft), `item.to/.subject.getAsync()`, `item.itemId` (thread context),
  `item.close({discardItem:true})` (discard), `roamingSettings.get/set('apolloApiKey')`.

---

## CORS proxy (Cloudflare Worker) — permanent infrastructure

Apollo's API only sends `Access-Control-Allow-Origin` for its own Chrome extension and Salesforce.
Browser fetches from anywhere else (our github.io origin, Office iframes) fail at preflight — so all
Apollo calls route through a Worker proxy.

- Source `worker/src/index.js`; config `worker/wrangler.toml`.
- Cloudflare account `e66e78179c050c20a8e3844aa669089a` (n.alioto7@yahoo.com); subdomain
  `n-alioto7.workers.dev`. URL: `https://stormsearch-apollo-proxy.n-alioto7.workers.dev`.
- `/health` returns `{ok:true,target:"https://api.apollo.io",time:...}`.
- Origin allowlist: `nicka2717.github.io`, `outlook.office.com`, `outlook.cloud.microsoft`, + Office
  365 iframe hosts.
- **Deploy gotcha:** wrangler can't build from paths containing asterisks (esbuild reads `*` as a glob).
  The old `*CLAUDE CODE - WORK*` folder broke it; workaround was copying `worker/` to a clean path
  (e.g. `/tmp/sapw`) before `wrangler deploy`. The project now lives at
  `~/StormDev/stormsearch-apollo-outlook-addin` (no asterisks), but keep the lesson for any starred path.

---

## HTML cleanup strategy — `thread-formatter.js` (the core IP)

Uses browser-native `DOMParser` to walk the compose body as a tree. **Seven cleanup passes:**

1. **Strip non-rendering elements:** `<script>`, `<style>`, `<noscript>`.
2. **Selective image strip** (updated 2026-07-08, Nick: preserve signature logos): KEEP `<img>` with
   http(s) or `data:image/` src; STRIP cid:, Outlook attachment-service URLs (auth-gated, render
   broken outside the mailbox), `<video>`/`<object>`/`<embed>`. Caveat: logos embedded as mail
   attachments (cid:) physically can't survive — only hosted ones do. Then iteratively remove
   paragraphs/divs left functionally empty (no text, no `<br>`, no named anchor, no kept `<img>`)
   to collapse the space stripped-image wrappers leave. NBSP (U+00A0) counts as content here, so
   intentional `<p>&nbsp;</p>` blank lines survive.
3. **Collapse consecutive blank-line paragraphs:** when a blank-line element (whitespace + NBSP + `<br>`
   only) is immediately preceded by another at the same level, remove it; singletons preserved.
   Handles image-spacer pairs that lose their image in Pass 2 and leave stacked spacers. **Note the
   different NBSP semantics:** Pass 2 treats NBSP as content (keeps `<p>&nbsp;</p>`); Pass 3 treats it
   as blank when collapsing redundant runs.
4. **Strip Office namespace tags:** `<o:p>`, `<v:imagedata>`, `<w:WordSection>`, `<m:math>`,
   `<st1:place>` — don't render outside Outlook. Text content preserved as a text node.
5. **Strip ALL security banners** (broadened 2026-07-08, Nick: "remove the yellow security lines"):
   "EXTERNAL" / "[EXTERNAL]" / "EXTERNAL EMAIL", "CAUTION: …originated from outside the
   organization…" (gateway lines, often stacked 4+ at thread bottom), and "You don't often get
   email from x. Learn why this is important" (first-contact tip). Matched only when the text is
   an element's ENTIRE content (≤600 chars), then climbs to the outermost same-text wrapper
   (banner tables/divs) — a real sentence merely mentioning these words survives.
6. **Force inline `margin: 0` on all `<p>`/`<div>`** — the key visual fix. Outlook emits
   `<p class="MsoNormal">` assuming Outlook's `margin:0` stylesheet; Apollo's TinyMCE doesn't ship that
   CSS so `<p>` picks up ~16px browser defaults that compound on `<p>&nbsp;</p>` spacers. Skip elements
   with an explicit margin (e.g. `margin-bottom:12pt` on the From-block) so Outlook's deliberate margins
   stay.
7. **Normalize font-family + collapse main-body font-sizes:**
   - **(a)** Strip every `font-family` from descendant inline styles + the legacy `face` attr from
     `<font>` tags, so the outer wrapper's `Calibri, Tahoma, sans-serif` cascades uniformly.
   - **(b)** Normalize each `font-size` in the **10pt–12pt range to 12pt**. Sizes <10pt (8pt
     confidentiality, 9pt banners) are PRESERVED so fine print stays fine print; >12pt preserved
     (probable headlines).
   - **Why bounded:** Outlook defaults to 11/12pt and quote blocks slip in 10pt → typed reply rendered
     12pt while quoted bodies rendered 11pt. The bounded range unifies main body at 12pt while keeping
     hierarchy markers distinct. An earlier "everything to 12pt" experiment blew up 8pt/9pt fine print
     and Nick rejected it ("absolutely horrendous") — that's why Pass 7 strips font-family but only
     *bounds* font-size.

Then wrap the cleaned body in a default `Calibri, Tahoma, 12pt` block. Inner `font-size` declarations
still win over the wrapper's 12pt — deliberate.

**Rollback (if Pass 7 misbehaves):** `src/thread-formatter-v1.js` is a frozen pre-Pass-7 snapshot. In
`src/taskpane.html`, change the `thread-formatter.js?v=...` script tag to `thread-formatter-v1.js?v=...`,
bump the cache-bust letter on all three script tags, commit/push, wait ~30–60s for Pages, hard-refresh
the task pane. Console logs `[formatter] thread-formatter-v1.js (...) loaded`. Do NOT edit the v1 file —
it's frozen by design. (The bump rule is also a comment at `taskpane.html` line ~70.)

---

## Apollo editor quirks (lessons learned)

- **Apollo's editor is TinyMCE-based**, `forced_root_block: 'p'` by default → top-level `<div>` get
  rewritten to `<p>` on load. Converting `<p>`→`<div>` in our formatter doesn't stick (Apollo undoes
  it). **Inline styles like `margin:0` DO survive the round-trip** — that's the pattern that works.
- **CORS via the Cloudflare proxy is non-negotiable** (see proxy section).
- **Apollo creates emailer_messages asynchronously** after `add_contact_ids` — search-then-PUT must
  retry to dodge the race (currently up to 4 attempts, 600ms backoff).
- **Verify body push after PUT:** GET the message and confirm `body_html` matches — catches silent
  server-side failures (happened once in testing).
- **Cache-busting matters:** Office Add-in iframes cache aggressively. Append `?v=YYYYMMDDx` to all
  script/CSS URLs from `taskpane.html` + emit `<meta http-equiv="Cache-Control" content="no-store,...">`.
  Bump the version letter on every code change. (Live code is already version-stamped; the bump is
  routine, not tracked here.)

---

## Body-push reliability — three bugs that bit (all fixed in `apollo.js` / `taskpane.js`)

The push was unreliable ("more times than not it doesn't carry over") until three independent bugs were
found and fixed. Keep all three in mind — they're the failure modes most likely to recur.

1. **Body read at pane-load instead of click time.** `draftContext.bodyHtml` was captured during
   `loadEverything()` at pane-open, so Nick's reply (typed AFTER) never made the push. **Fix
   (`handlePush`):** read body fresh via `item.body.getAsync(CoercionType.Html, ...)` AND keep the
   cached one; pick whichever has more content (some Office.js/Outlook combos returned empty on
   second-read, so cached wins as fallback). Logs both lengths.
2. **PUT to a stale orphan message.** `/emailer_messages/search` filtered by
   `contact_ids + emailer_campaign_ids` returns ALL messages ever created for that contact in that
   sequence — including stale ones from prior add/remove/re-add cycles (exactly Nick's test flow). PUT
   + verify both succeed but Apollo's UI shows old content because we wrote the wrong message (one test
   returned **5 messages** for a 3-step, 1-contact sequence). **Fix (`tryUpdateManualMessageBody`):**
   filter to manual_email + non-terminal status, sort `created_at` desc (ObjectId lex fallback — Mongo
   ObjectIds encode timestamp in the first 8 hex chars), pick the newest.
3. **Wrong field-value guesses in the filter.** Confirmed from production logs (NOT inferred): `type` =
   `"outreach_manual_email"` (not `"manual_email"`), `status` = `"drafted"` (not queued/pending/draft).
   A freshly-enrolled step 1 has `current body length: 63` (empty template). The filter uses the real
   values plus the older guesses for forward-compat, and includes `unscheduled` defensively.

4. **(2026-07-08) Apollo silently dropped the `contact_ids` filter on `/emailer_messages/search`.**
   The search returned EVERY message in the campaign regardless of contact (verified: a bogus
   contact id still returned other contacts' messages). Combined with the old "newest overall"
   fallback, a push for contact A overwrote contact B's SCHEDULED automatic follow-up (body +
   subject) — a wrong email queued to a real prospect. **Fixes shipped (commit 88e53e2):**
   (a) hard client-side filter `m.contact_id === contactId` before any candidate selection;
   (b) removed the newest-overall fallback — only manual-email or explicit step-1 messages are
   valid PUT targets; (c) abort if `add_contact_ids` returns 200 with an empty `contacts` array
   (defensive only — Nick confirmed enrollment DID work during the incident; he removed the
   contact manually after each failed push. The real gap: Apollo creates the drafted message
   asynchronously and it didn't exist yet within the ~5s retry window, so the broken search +
   fallback grabbed another contact's message); (d) keep the Outlook draft unless
   the push VERIFIED — clipboard is fragile and the draft was the only durable copy of the reply.
   **Rules:** never trust an Apollo server-side filter — always re-filter results client-side on
   the field that matters; never PUT to a message type you didn't create (automatic emails are
   Apollo's, not ours); never destroy the source (draft) unless the destination is verified.

**Diagnostic that surfaces all of the above:** the log line
`[apollo] picked message id=... status=... type=... (N manual candidate(s) of M total)`. If a future
Apollo change breaks the filter, Nick pastes that line and we update the strings.

**Operational note:** removing a test contact does NOT delete its emailer_messages — they pile up
orphaned. Harmless thanks to the newest-wins picker; if pile-up ever causes trouble, an Apollo support
ask or admin sweep can clear them.

---

## Nick's preferred Storm Search outbound HTML style

Canonical clean body: one `<div style="font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;">`
per logical line, with empty `<div ...>&nbsp;</div>` blocks for blank lines; single font, no nested
spans, no Mso clutter, no mixed colors. The formatter wraps the cleaned Outlook body in that block as
the default font; nested children that set their own font (e.g. a Verdana signature) render in those
fonts — authentic.

**Possible future enhancement** (Nick's "last resort" idea): detect the boundary between Nick's typed
reply and the quoted thread (Outlook marks it with `<a name="_MailOriginal">` or
`<div id="divRplyFwdMsg">`) and re-render only Nick's portion using the clean template; leave the quoted
thread as-is.

---

## Operations

### Quick re-test (after shipping code)
1. Wait for GitHub Pages redeploy (~1–2 min; a background curl-poll confirms the version is live).
2. Hard-refresh the Outlook tab (Cmd+Shift+R) — iframes cache aggressively even with version params.
3. Open a FRESH Reply window (existing ones hold stale code).
4. Push to Apollo → confirm pane loads → pick mailbox + sequence → push.
5. Compare Apollo's editor render vs Outlook (Cmd+A → copy → paste into chat to inspect raw HTML).
6. Remove the test contact afterward.

### Debugging a misbehaving push
1. Open DevTools Console BEFORE clicking Push; watch `[push]` and `[apollo]` lines.
2. The result banner shows the explicit failure reason (`verify_mismatch`, `put_rejected`,
   `message_not_found`). Console logs include HTML length pushed, the message ID, and the post-PUT GET
   verification.
3. If the HTML looks wrong but the push succeeded, the bug is in the formatter (local to the browser) —
   paste the resulting Apollo HTML back to Claude; server logs won't help.

### Repo & hosting
- Repo `https://github.com/NickA2717/stormsearch-apollo-outlook-addin` (public); Pages
  `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/`; manifest at `…/manifest.xml`.
- M365: "Push to Apollo Sequence" deployed to Nick (Specific user). App ID
  `a8473972-6583-4df4-b72a-56f556e9f059`.

---

## Open item & future polish

- **Outlook draft persistence (only open issue).** `item.close({discardItem:true})` doesn't reliably
  delete the draft on new Outlook for Mac. Mitigations in place: try modern
  `closeBehavior: CloseBehavior.Discard` first (Mailbox 1.10+), fall back to legacy `discardItem:true`,
  and before closing replace the body with marker text "[Pushed to Apollo — safe to delete this draft]"
  so any leftover is obviously stale, not a duplicate of what was pushed. Long-term: require Mailbox
  1.10+, or delete drafts server-side via Microsoft Graph.
- **Future polish:** pin go-to sequences to the top of the dropdown; recent-contacts memory;
  multi-mailbox routing rules; optionally split Nick's typed reply from the quoted thread and re-render
  his portion in the clean template (see HTML style above).

---

## Debugging rules (2026-07-08 session)
- **Reproduce read-only first.** Diagnose from Apollo's real production records (message search,
  campaign contacts, message GETs) before reaching for a write-based test enrollment — the
  read-only path found the root cause without touching live sequences.
- **This repo is PUBLIC — never write contact data (emails, names, bodies) into the project
  folder,** even temporarily. Recovered/pulled PII stays in Apollo or goes where Nick names.

## Security
- The Apollo API key is stored locally only (roaming settings) — never in this file, the repo, or chat.
  It was rotated once after a chat-based leak. The hard rule lives in README; enter the key only in the
  add-in's Settings panel.
