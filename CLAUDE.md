# stormsearch-apollo-outlook-addin

An Outlook add-in that pushes a typed email reply into an Apollo sequence's manual email step, then discards the Outlook draft so Apollo's auto follow-up continues from there. The front-end repo is public by necessity.

- Both Workers (`worker/` and `worker-images/`) deploy with `npm run deploy` from their own folder, which runs the pinned local wrangler (4.141.0, the fleet version since 2026-09-27); never `npx wrangler`, because that fetches whatever version is newest that day.
