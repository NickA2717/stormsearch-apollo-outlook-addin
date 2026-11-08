# Performance log

Every speed change to the add-in's two Workers (the CORS proxy in `worker/` and the image host in `worker-images/`), one entry each, with what was actually measured. `node scripts/usage-report.mjs` prints this log at the end of every report and fails loudly if an entry is malformed, so a claim without its evidence cannot sit here quietly. The usage log it reads went live on 2026-11-08 (`docs/RUNBOOK_USAGE_LOG.md`).

## Rules

- One `## P<n>: <short name>` entry per change, newest at the bottom; never delete an entry, because a later change is judged against it. Update an entry's Status and evidence fields in place as it moves; git history keeps the earlier states.
- The entry is written on the branch that makes the change, before merge.
- Status is exactly one of the values below, and each needs the evidence field named beside it filled in. Merging alone never earns a verified status, because merging does not deploy and a branch's own numbers are a claim until someone else reruns them.
- Times are milliseconds. Benchmark numbers are the median of at least three runs, and before and after must give identical output (a checksum or a golden replay).
- Live numbers come from the usage report's version comparison: the same Worker, the same workload band (a proxied call by method and path shape, because each Apollo endpoint has its own speed; an upload by size band and whether it deduped), successful calls only.
- Minimum calls: 5 successful calls on each version in the band compared, the standard's floor. Reason: one push through the add-in is a handful of Apollo calls, each to a different endpoint, and an upload happens only when a signature carries an embedded image, so a band of 10 could take months to fill; 5 still beats a guess when the report prints the count beside every number.
- Take the baseline before the speed change ships, from live calls on the current version, because once the change deploys the "before" numbers are gone.
- A later version that carries the same code counts as "after" too; the entry names it. A later change that touches a logged path names the earlier entry under Affects and says whether it kept, improved or undid that gain.
- A Worker's clock only moves on I/O, so "our time" (total minus Apollo's) is waiting outside Apollo, never CPU. Neither Worker does real CPU work, so speed here is almost all Apollo's and Cloudflare's.
- A speed change ships with an offline, read-only benchmark (a fake Apollo with a fixed delay, no credential, no deploy, output checksummed); a change with none says so under Benchmark and names the live measure to watch.

| Status | Means | Evidence it needs |
|---|---|---|
| `planned` | Idea only, no branch yet | none |
| `in progress` | A branch is being worked | Branch |
| `claimed on branch` | The branch measured a gain with its benchmark | Benchmark, Branch before/after |
| `merged, awaiting validation` | Merged, nobody has rerun the benchmark yet | Merged |
| `merged, benchmark verified` | The benchmark was rerun on main and the branch and the gain held with identical output | Merged, Rerun before/after |
| `deployed, awaiting live data` | The merged code is live, too few calls yet to judge | Merged, Version before/after |
| `live verified` | Live calls on the new version are faster | Merged, Version before/after, Live before/after |
| `no gain` | Measured and no real gain | Merged or Branch, plus at least one before/after field |
| `regression` | Measured and slower, or output changed | Merged or Branch, plus at least one before/after field |

Fields, one `- Field: value` line each: Status, Tool or path, What changed, Branch, Benchmark, Branch before/after, Rerun before/after, Merged, Version before/after, Live before/after, Affects, Notes. Write `-` for a field with nothing yet.
