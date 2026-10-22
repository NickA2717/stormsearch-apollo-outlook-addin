# stormsearch-apollo-outlook-addin — learnings

Facts about Apollo, Outlook and GitHub Pages that code cannot fix. Fixable lessons are code, not notes.

- Apollo's "Reply" step can only thread to a Message-ID Apollo itself sent; there is no API option or setting to thread to externally sent Outlook mail. Do not re-research it.
- Apollo's API sends CORS headers only to its own extension and Salesforce, so every browser call must go through the Cloudflare proxy Worker.
- Apollo's email editor is TinyMCE with `forced_root_block: 'p'`: a top-level `<div>` is rewritten to `<p>` on load, but inline styles stick. Style the content; do not fight the block structure.
- Signature logos arrive as `cid:` attachments that Apollo recipients cannot see; the images Worker has to host each attachment's bytes at push time.
- `POST /v1/emailer_messages/search` and `PUT /v1/emailer_messages/{id}` are absent from Apollo's OpenAPI spec of 2026-08-19 (the search is documented GET-only), yet both work in production; treat them as legacy that can break without notice.
- Apollo's `/v1` base and the documented `/api/v1` both return 200; `/v1` is a working alias.
- `Office.context.roamingSettings` is Microsoft-hosted and roams with the user's Office profile across devices; it is not local to one Mac, so the add-in's key-storage text must say so.
- Office task-pane iframes cache scripts hard, even with a `?v=` parameter: after a deploy, wait for GitHub Pages to redeploy (about 1 to 2 minutes), then hard-refresh the Outlook tab.
- `item.close({discardItem: true})` does not reliably delete the draft in new Outlook for Mac.
- Outlook Web's real compose body serializes links and signatures in ways a hand-written test fixture does not; test formatter changes against a recent real captured body.
- The compose body must be read at click time, not when the pane loads, or the push uses stale text.
- An HTTP success from Apollo does not prove the step was filled; check the artifact in Apollo.
