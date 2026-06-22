---
title: Storm Search Apollo Outlook Add-in
type: project
project-kind: code
status: active
language: TypeScript/JS
runtime: outlook-addin
created: 2026-04-10
updated: 2026-05-08
tags: [project, code, apollo, outlook, addin]
related:
  - "[[+ Code Projects]]"
  - "[[Nick_Alioto_Apollo_Capabilities]]"
  - "[[+ Cold Email System]]"
---

# Storm Search Apollo Outlook Add-in

> Stub note. Source code lives at `Claude Code Projects/Storm Search Apollo Outlook Add-in/` (excluded from graph).

## What it does

An Outlook add-in that lets Nick:
1. Type a reply to a contact in Outlook (using Outlook as a familiar editor)
2. Click a "Push to Apollo Sequence" button inside Outlook
3. Have the add-in look up the contact in Apollo, add them to a chosen sequence, push the typed reply + formatted HTML thread context into step 1 (Manual email), and discard the Outlook draft
4. Hop to Apollo, click Send on step 1 → Apollo handles steps 2 and 3 automatically

**Outcome:** collapses Nick's previous 7+ step manual paste workflow into 2 clicks in Outlook + 1 click in Apollo.

## Critical findings (do not re-research)

- Apollo's "Reply" step type can ONLY thread to a Message-ID Apollo itself sent — **cannot** thread to externally-sent (Outlook) emails
- Soft threading (subject-based) works in practice
- Custom field HTML workaround is dead (Apollo escapes HTML in `{{custom_field}}`); step 1 must be type "Manual email"
- Apollo's API uses `outreach_manual_email` (not `manual_email`) and `drafted` (not `queued`) for a freshly-enrolled step 1 — the candidate-message filter must use these exact strings
- The Outlook draft body must be re-read at click time, not at task-pane load time, or Nick's typed reply gets dropped
- `/emailer_messages/search` returns ALL messages for that contact in that sequence, including stale orphans from prior enrollments — picker must sort by `created_at` desc and target the freshest match

## Status (2026-05-08)

End-to-end push working consistently across multiple consecutive sends. See [[learnings]] for the diagnosis trail and the cache-bust version currently deployed.

## Related

- [[+ Code Projects]]
- [[Nick_Alioto_Apollo_Capabilities]]
- [[+ Cold Email System]] — sequences this add-in pushes into
