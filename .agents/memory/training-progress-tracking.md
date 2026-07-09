---
name: ML training progress tracking
description: How live progress for the background ML retraining job is exposed to the UI, and pitfalls hit building it.
---

The background ML retraining pipeline (fetch history → fetch fundamentals → build training set →
walk-forward train 4 models) can take 30-90+ minutes with no per-step API response to hang a
progress bar on. Progress is tracked via a process-local in-memory singleton
(`artifacts/api-server/src/lib/ml/progress.ts`) updated from inside the pipeline/train loops, and
polled by the frontend through a `GET /finance/training-status` endpoint.

**Why:** the alternative (log tailing) isn't visible in the UI, and a DB-backed job-progress table
was overkill for something that resets naturally on server restart anyway.

**How to apply:** when wiring progress counters, use 1-based "completed units" (increment before
or report `i + 1`), not the raw 0-based loop index — otherwise the bar shows `0/N` at the start and
never reaches `N/N` at the end. Same applies to any fold/step counter driving a percentage on the
frontend: `current/total`, not `(current-1)/total`. Also gate `refetchInterval` on the terminal
phases (`done`/`error`/`idle`) so polling doesn't run forever after the job settles.
