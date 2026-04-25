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

## Build Phases

- ✅ Phase 0: Project folder created at `/Users/nickmini/*CLAUDE CODE - WORK*/stormsearch-apollo-outlook-addin/`
- ✅ Phase 1: GitHub repo + tooling setup (gh CLI installed, auth done as NickA2717)
- ✅ Phase 2: All code written — manifest, taskpane (HTML/CSS/JS), apollo.js, thread-formatter.js
- ✅ Phase 3: Deployed to GitHub Pages at https://nicka2717.github.io/stormsearch-apollo-outlook-addin/
- ✅ Phase 4: Sideloaded via M365 admin center as "Push to Apollo Sequence", deployed to Nick (User-only)
- 🔄 Phase 5: Waiting on Microsoft propagation (5 min – 72 hr per MS, typically 10-30 min)
- ⏳ Phase 6: End-to-end test on a real reply
- ⏳ Phase 7: Polish based on Nick's first-week feedback

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
