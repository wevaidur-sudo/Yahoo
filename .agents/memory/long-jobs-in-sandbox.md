---
name: Long-running jobs in this sandbox
description: Why background/nohup jobs die, and the pattern that actually works for multi-minute pipelines (data fetch, model training).
---

Backgrounding a process (nohup/setsid/disown) inside a bash tool call does not
survive past that tool call returning — the process gets killed. There is no
way to "kick off and check back later" for CPU/network-bound work from this
environment's bash tool.

**How to apply:** Break long jobs (bulk API fetches, model training, batch
imports) into idempotent, DB-persisted chunks, each of which fits inside a
single ~115s `timeout` bash call. Re-run the same script repeatedly (upsert
semantics) until all chunks are done, rather than trying to run one big job
in the background. For CPU-bound training specifically, allow training a
subset (e.g. one model/category at a time) so a single call only needs to
finish part of the work.
