# 03 — Atomically cut over to the persistent DownloadRuntime

**What to build:** Replace the in-memory queue and persisted progress projection with one versioned persistent `DownloadRuntime` authority. All download surfaces must submit commands and read snapshots through this runtime, and the old executable queue and independent lifecycle writers must be deleted in the same cutover.

**Blocked by:** 01 — Centralize download lifecycle writes; 02 — Establish an addressable executor event protocol.

**Status:** ready-for-agent

- [ ] A versioned durable job records a stable job identity, immutable selected execution specification, lifecycle state, durable queue-order key, attempt, current execution identity, processing phase, progress, terminal outcome, and audit timestamps.
- [ ] The selected execution specification contains only execution inputs and minimal display metadata; unused variants, base64 thumbnails, captured page state, and other discovery-only data are excluded.
- [ ] Lifecycle state and processing phase are separate, with a closed transition model covering `queued`, `starting`, `running`, `finalizing`, `paused`, `succeeded`, `failed`, and `cancelled`.
- [ ] Submission uses an explicit logical request identity and is deterministic for duplicate messages while allowing intentionally distinct variant or output requests.
- [ ] Queue positions are derived from persisted queued jobs, and reorder affects only schedulable queued jobs.
- [ ] Concurrency is derived from persisted claimed jobs and the configured concurrency policy.
- [ ] Submit, cancel, pause, resume, retry, reorder, executor events, browser delivery, terminal clearing, and snapshot reads all pass through the runtime interface.
- [ ] Popup, side panel, content overlay, progress window, interceptor, context menu, and history consume the same runtime snapshot and no longer infer active state independently.
- [ ] The previous pending array, running set, runner-registration seam, pause-intent authority, direct progress writers, and independent UI lifecycle projections are removed.
- [ ] Migration is an atomic authority replacement: there is no runtime feature flag, dual-write period, compatibility scheduler, or fallback to the old queue.
- [ ] Runtime contract tests prove legal transitions, reject representative illegal transitions, and verify queue order, concurrency, idempotent commands, and terminal-history isolation.
