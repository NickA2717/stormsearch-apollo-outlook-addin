# stormsearch-apollo-outlook-addin

An Outlook add-in for Storm Search. Reply to an email, click **Push to Apollo**, confirm the contact, pick a sender mailbox and an active sequence, and the add-in puts your typed reply (with the formatted thread) into Apollo step 1's manual email and discards the Outlook draft. You click Send in Apollo and Apollo's follow-up steps continue from there.

The repo is public because Outlook loads the manifest and the task pane from GitHub Pages. Manifest URL for sideloading: `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/manifest.xml`.

Install: Microsoft 365 admin center, Settings, Integrated apps, Upload custom apps, Office Add-in, paste the URL; or per user through Outlook, Get Add-ins, My Add-ins, Add a custom add-in, From URL. On first open, enter your own Apollo API key in the Settings panel; it is kept in your Outlook profile's roaming settings and sent to Apollo through the project's Cloudflare proxy on every call.

What is where, and what never to change, is in `CLAUDE.md`. Facts about Apollo and Outlook that code cannot fix are in `learnings.md`.

Apollo endpoints used: `POST /v1/emailer_campaigns/search`, `GET /v1/email_accounts`, `POST /v1/contacts/search`, `POST /v1/contacts`, `POST /v1/emailer_campaigns/{id}/add_contact_ids`, and best-effort `POST /v1/emailer_messages/search` plus `PUT /v1/emailer_messages/{id}` (undocumented in Apollo's spec; legacy behaviour that could break without notice).

License: MIT.
