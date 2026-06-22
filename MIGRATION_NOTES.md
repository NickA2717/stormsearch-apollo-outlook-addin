---
title: Storm Search Apollo Outlook Add-in — Migration Notes
type: migration-notes
project-kind: code
status: archived
tags: [migration-notes, project, apollo, outlook, addin]
related:
  - "[[Storm Search Apollo Outlook Add-in]]"
---

# Storm Search Apollo Outlook Add-in — Migration Notes

**Original location:** `/Users/nickmini/*CLAUDE CODE - WORK*/stormsearch-apollo-outlook-addin/`
**New location:** `…/MASTER FOLDER/Claude Code Projects/Storm Search Apollo Outlook Add-in/`

## What this is

Outlook task-pane add-in: select a reply in Outlook → click "Push to Apollo" → the message body is pushed into an Apollo email sequence so follow-ups continue automatically.

Two pieces:
1. **Add-in front end** — `manifest.xml`, `src/taskpane.html`, `src/commands.html`, etc. Hosted at `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/` (GitHub Pages from the repo's `main` branch).
2. **Cloudflare Worker proxy** — `worker/` subfolder. Deployed to `https://stormsearch-apollo-proxy.<cf-subdomain>.workers.dev` via `wrangler deploy`. Proxies Apollo API calls so the Apollo API key isn't shipped in the Outlook add-in.

This folder is its own **git repo** (`.git/`). I verified `git status` works clean from the new location.

## What will break on a path move — surprisingly little

- **Manifest URLs** all point to GitHub Pages (`https://nicka2717.github.io/...`) — no local paths. Outlook sideloads aren't affected.
- **Worker** `wrangler.toml` is path-clean.
- **Git remote** is fine — git doesn't care where the working copy lives.

## What might break — the wrangler asterisk bug (and its fix)

The project's own `learnings.md` documents:
> wrangler can't build from paths containing asterisks (folder name `*CLAUDE CODE - WORK*` breaks esbuild — interprets asterisks as glob wildcards). Workaround: copy `worker/` to a clean path like `/tmp/sapw` before running `wrangler deploy`.

The new path **has no asterisks** — but it does have spaces and parentheses. esbuild generally handles spaces fine but can choke on parens in some shell contexts. We'll find out empirically:

1. Try the direct deploy first:
   ```bash
   cd "/Users/nickmini/Library/Mobile Documents/com~apple~CloudDocs/(CLAUDE - STORM SEARCH)/MASTER FOLDER/Claude Code Projects/Storm Search Apollo Outlook Add-in/worker"
   npx wrangler deploy
   ```
2. If that errors out on the parens, fall back to the original workaround:
   ```bash
   cp -R "…/Storm Search Apollo Outlook Add-in/worker" /tmp/sapw
   cd /tmp/sapw
   npx wrangler deploy
   ```
3. Update `learnings.md` with whatever the new behavior is so future-you knows.

## Re-pointer walkthrough

### Front-end (Outlook sideload)

The add-in's hosting is at GitHub Pages, so **the deployed add-in keeps working without any change** — even before you touch the local copy.

If you want to **update** the add-in:
1. Edit files in `src/` from the new location.
2. `git add` / `git commit` / `git push origin main` from the new location — git remote is preserved.
3. Wait ~30s for GitHub Pages to redeploy.

### Worker (Cloudflare proxy)

See "wrangler asterisk bug" section above for deploy command.

You'll need:
- Node + npm (already installed if `wrangler` worked before)
- `wrangler login` (cached creds may still be valid)
- The Apollo API key in the worker's environment — set via `wrangler secret put APOLLO_API_KEY` if it isn't already

### Outlook sideload (re-validation)

The add-in is loaded into Outlook by the manifest URL, not the local file. To verify it still works:
1. Open Outlook (web or desktop).
2. Compose a reply.
3. The "Push to Apollo" button should appear in the toolbar.
4. Click it → task pane opens → confirm it loads from `nicka2717.github.io`.

If the button is missing, re-sideload via Outlook's "Get Add-ins" → "My add-ins" → "Add a custom add-in" → URL: `https://nicka2717.github.io/stormsearch-apollo-outlook-addin/manifest.xml`.

## iCloud caveat

If the worker `node_modules/` get evicted by iCloud, `wrangler deploy` will be slow on first run while it re-downloads. Consider:
- Right-click the project folder → **Keep Downloaded**, or
- Add `worker/node_modules/` to `.gitignore` (already is) and just let it re-install via `npm install` after sync.

## Files / folders in this folder

- `manifest.xml` — Outlook add-in manifest
- `src/` — front-end (taskpane + commands)
- `worker/` — Cloudflare Worker proxy
- `assets/` — icons
- `index.html`, `README.md` — landing/docs
- `learnings.md` — full project history (read this if the project ever needs deeper attention)
- `.git/` — git repo, remote: `github.com/NickA2717/stormsearch-apollo-outlook-addin`

## Verification checklist

- [ ] `git status` clean from new location ✅ (confirmed during migration)
- [ ] `wrangler deploy` succeeds from new path (or fall back to /tmp workaround)
- [ ] Outlook add-in still appears in compose toolbar
- [ ] Test push: select a sequence, hit "Push to Apollo", verify contact added in Apollo
- [ ] `Keep Downloaded` set if you prefer instant builds
