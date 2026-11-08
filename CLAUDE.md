# stormsearch-apollo-outlook-addin

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft. Two Cloudflare Workers sit behind it. Layout standard: `~/StormDev/stormdev-layout/docs/PLAN.md`.

## Rules

- The repo is PUBLIC by necessity: Outlook loads the manifest and every page and script from GitHub Pages, which serves this repo's `main` branch. Never add anything private: no key, token, `.env`, customer or candidate name, state file or log. Reason: everything in the checkout is world-readable the moment it is pushed.
- Never move, rename or change a served file without a test in Outlook afterwards. The served files are listed below and their URLs are written into every teammate's installed manifest, so a moved file breaks every add-in at once, and a push to `main` redeploys them. Reason: Outlook caches the manifest and has no fallback.
- The Apollo API key lives only in `Office.context.roamingSettings`, entered in the add-in's Settings panel. Never paste it into chat, code or a file. Reason: a chat leak forced one rotation already.
- Both Workers deploy with `npm run deploy` from their own folder, which runs the pinned local wrangler; never `npx wrangler`, which fetches whatever version is newest that day. Reason: fleet pin, 2026-09-28.
- A change to `src/` bumps the `?v=` stamp on the stylesheet and four script tags in `src/taskpane.html`. Reason: Office iframes cache aggressively.
- Do not "fix" the two undocumented Apollo calls (`/emailer_messages/search` by POST, `PUT /emailer_messages/{id}`) or the `/v1` base to match the spec; they work in production. Check them first if a push to step 1 ever breaks.
- Run `npm test` in `worker/` and in `worker-images/` before deploying either; the suites are offline (no key, no network) and prove every reply byte-identical with the usage log on, off, failing and hanging. Reason: a teammate notices a changed reply before anyone reads a log. There is no scheduled job, so there is no watchdog row.
- Both Workers write one usage log, D1 `apollo-addin-calls` (call log 2026-10-23, usage log 2026-11-08): one row per proxied Apollo call and per image upload or failed image request, metadata only, never an Apollo key in any form, a body, a query string, an email address, an image or a successful image fetch (that would track recipients opening email). What it records, how to read it (`scripts/usage-report.mjs`, `--health`) and what is settled: `docs/RUNBOOK_USAGE_LOG.md`, built to the team's shared usage-log standard (Rulebook_Usage_Logs). Reason: one log shape across connectors shows who uses what, what fails and what is slow.
- Every speed change to either Worker gets a `docs/PERFORMANCE_LOG.md` entry on its branch, before merge; that file is the one record file kept beside the four docs. Reason: merged code is not proof of a gain.
- Workers Logs stays off in both `wrangler.toml` files because it records request headers, and those carry each teammate's key. Schema changes go in `worker/migrations/` as additive, nullable columns, applied with `CI=1 ./node_modules/.bin/wrangler d1 migrations apply apollo-addin-calls --remote` from `worker/` before the deploy. Reason: the running version keeps inserting until the new one replaces it.

## Where things are

Served to Outlook (public URL base `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/`):

- `manifest.xml`: the add-in manifest, at root because Outlook is given its URL.
- `index.html`: the landing page at the site root.
- `assets/icon-16.png`, `icon-32.png`, `icon-64.png`, `icon-80.png`, `icon-128.png`: the icons the manifest names by URL.
- `src/taskpane.html`, `taskpane.css`, `taskpane.js`, `apollo.js`, `inline-images.js`, `thread-formatter.js`, `commands.html`: the task pane and its scripts. `thread-formatter-v1.js` is the frozen rollback copy named in a comment in `taskpane.html`.

Not served:

- `worker/`: the CORS proxy Worker (`stormsearch-apollo-proxy`) that forwards the browser's Apollo calls, since Apollo sends CORS headers only to its own extension. On the firm Cloudflare account (`stormsearch-apollo-proxy.jyurk.workers.dev`) since 2026-10-23; the old copy on Nick's personal account (`n-alioto7`) is a fallback until the switch is proven in Outlook, then Nick deletes it.
- `worker-images/`: the Worker that hosts signature images at push time (one KV namespace), also on the firm account.
- `worker/src/usage-log.js`: the usage-log writer both Workers import; `worker/tests/` and `worker-images/tests/`: the offline suites.
- `docs/`: `RUNBOOK_USAGE_LOG.md` and `PERFORMANCE_LOG.md`. `scripts/`: `usage-report.mjs` (the read-only report) and `capture-replies.mjs` (before and after reply hashes for a deploy).
- `learnings.md`: outside-world facts. `README.md`: what it is and how to install it.

## Layout exceptions

- `assets/`: served by URL path (the manifest names `assets/icon-*.png`), so it cannot move to `config/`.
- `worker/` and `worker-images/`: Cloudflare Worker folders with their own `package.json`, `wrangler.toml` and `src/`.
- `index.html`: served at the site root.
- `src/` is the served front end, not a separate program; every file in it is public.
- Nothing is gitignored for secrets or people's data because none exists here; `.env` and `*.key` stay ignored as a guard.
