# stormsearch-apollo-outlook-addin

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft. Two Cloudflare Workers sit behind it. Layout standard: `~/StormDev/stormdev-layout/docs/PLAN.md`.

## Rules

- The repo is PUBLIC by necessity: Outlook loads the manifest and every page and script from GitHub Pages, which serves this repo's `main` branch. Never add anything private: no key, token, `.env`, customer or candidate name, state file or log. Reason: everything in the checkout is world-readable the moment it is pushed.
- Never move, rename or change a served file without a test in Outlook afterwards. The served files are listed below and their URLs are written into every teammate's installed manifest, so a moved file breaks every add-in at once, and a push to `main` redeploys them. Reason: Outlook caches the manifest and has no fallback.
- The Apollo API key lives only in `Office.context.roamingSettings`, entered in the add-in's Settings panel. Never paste it into chat, code or a file. Reason: a chat leak forced one rotation already.
- Both Workers deploy with `npm run deploy` from their own folder, which runs the pinned local wrangler; never `npx wrangler`, which fetches whatever version is newest that day. Reason: fleet pin, 2026-09-28.
- A change to `src/` bumps the `?v=` stamp on the stylesheet and four script tags in `src/taskpane.html`. Reason: Office iframes cache aggressively.
- Do not "fix" the two undocumented Apollo calls (`/emailer_messages/search` by POST, `PUT /emailer_messages/{id}`) or the `/v1` base to match the spec; they work in production. Check them first if a push to step 1 ever breaks.
- This project has no tests and no scheduled job, so it has no watchdog row.

## Where things are

Served to Outlook (public URL base `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/`):

- `manifest.xml`: the add-in manifest, at root because Outlook is given its URL.
- `index.html`: the landing page at the site root.
- `assets/icon-16.png`, `icon-32.png`, `icon-64.png`, `icon-80.png`, `icon-128.png`: the icons the manifest names by URL.
- `src/taskpane.html`, `taskpane.css`, `taskpane.js`, `apollo.js`, `inline-images.js`, `thread-formatter.js`, `commands.html`: the task pane and its scripts. `thread-formatter-v1.js` is the frozen rollback copy named in a comment in `taskpane.html`.

Not served:

- `worker/`: the CORS proxy Worker (`stormsearch-apollo-proxy`) that forwards the browser's Apollo calls, since Apollo sends CORS headers only to its own extension.
- `worker-images/`: the Worker that hosts signature images at push time (one KV namespace).
- `learnings.md`: outside-world facts. `README.md`: what it is and how to install it.

## Layout exceptions

- `assets/`: served by URL path (the manifest names `assets/icon-*.png`), so it cannot move to `config/`.
- `worker/` and `worker-images/`: Cloudflare Worker folders with their own `package.json`, `wrangler.toml` and `src/`.
- `index.html`: served at the site root.
- `src/` is the served front end, not a separate program; every file in it is public.
- Nothing is gitignored for secrets or people's data because none exists here; `.env` and `*.key` stay ignored as a guard.
