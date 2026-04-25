# Storm Search × Apollo — Outlook Add-in

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft. Apollo's auto follow-up steps continue from there.

**Manifest URL:** `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/manifest.xml`

## What it does

1. You hit Reply on an email in Outlook and type your message
2. You click the **Push to Apollo** button
3. The add-in:
   - Looks up the recipient in Apollo by email
   - Lets you confirm the contact + pick a sender mailbox + pick a sequence
   - Pushes your typed reply (with the formatted thread) into Apollo step 1's manual email
   - Discards the Outlook draft
4. You hop to Apollo, click Send on step 1, and Apollo handles the rest

## Setup (one-time)

### 1. Sideload the manifest in Outlook

**Microsoft 365 admin route (recommended for org use):**

1. Open the Microsoft 365 admin center → **Settings → Integrated apps → Upload custom apps**
2. Choose **Office Add-in** and paste the manifest URL above
3. Assign to specific users (you) or your whole org

**Per-user route (for testing on just your account):**

- Outlook on the web: open any email → Apps → Get Add-ins → My Add-ins → Add a custom add-in → From URL → paste manifest URL
- New Outlook for Mac: Outlook menu → Settings → Get Add-ins (icon) → My Add-ins → Add a custom add-in → From URL

### 2. First-time API key

When you first open the add-in, it'll show a Settings panel asking for your Apollo API key. Paste it in. The key is stored locally in your Outlook profile via `Office.context.roamingSettings`. It never leaves your machine except to call Apollo's API directly.

### 3. Use it

Reply to any email → click **Push to Apollo** in the ribbon → confirm contact, pick sender + sequence → done.

## Architecture

- `manifest.xml` — Office Add-in manifest. Defines the ribbon button on the message compose surface.
- `index.html` — landing page for the GitHub Pages site root.
- `src/taskpane.html` — main UI shown when the user clicks the ribbon button.
- `src/taskpane.css` — styling.
- `src/taskpane.js` — controller. Handles Office.js init, draft reading, push flow, draft discard.
- `src/apollo.js` — Apollo REST API client (in browser, with API key from roaming settings).
- `src/thread-formatter.js` — turns the Outlook draft body into Apollo-ready HTML.
- `src/commands.html` — required Office Add-in function file.
- `assets/icon-*.png` — icons referenced by the manifest.

## Key API endpoints

- `POST /v1/emailer_campaigns/search` — list active sequences
- `GET /v1/email_accounts` — list sender mailboxes
- `POST /v1/contacts/search` — find contact by email
- `POST /v1/contacts` — create contact if missing
- `POST /v1/emailer_campaigns/{id}/add_contact_ids` — enroll contact in sequence
- `POST /v1/emailer_messages/search` + `PUT /v1/emailer_messages/{id}` — push body to step 1 (best-effort; falls back to clipboard if API rejects)

## Development notes

See `MEMORY.md` for full project context, decisions, and the Apollo threading research that shaped this design.

## License

MIT
