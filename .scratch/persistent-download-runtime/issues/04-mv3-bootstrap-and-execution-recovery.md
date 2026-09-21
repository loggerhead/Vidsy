# 04 — Implement MV3 bootstrap and execution recovery

**What to build:** Make first startup, idle wake-up, extension reload, and service-worker restart run one idempotent bootstrap protocol. The runtime must reconstruct scheduling from durable jobs and reconcile active claims with executor inventory so queued and active work cannot become a ghost or duplicate execution.

**Blocked by:** 03 — Atomically cut over to the persistent DownloadRuntime.

**Status:** ready-for-agent

- [ ] Every background activation loads non-terminal jobs, obtains executor inventory, reconciles current claims, calculates available capacity, claims eligible queued jobs, and dispatches execution.
- [ ] Bootstrap is idempotent when invoked repeatedly or concurrently and cannot claim the same job twice.
- [ ] A durable queued job remains schedulable after the coordinating JavaScript context is destroyed and recreated.
- [ ] A persisted starting or running claim that exists in executor inventory is reattached without creating a new attempt.
- [ ] A persisted claim proven absent by executor inventory follows an explicit state-machine transition rather than timeout, timestamp, or startup-cleanup heuristics.
- [ ] Every new claim increments attempt, assigns a unique execution identity, and is persisted before executor dispatch.
- [ ] Events carrying a superseded execution identity are rejected without changing the current job.
- [ ] Configured concurrency and queue ordering remain correct after runtime recreation.
- [ ] Message-channel keepalive behavior may ensure command acknowledgement but is not required for durable scheduling correctness.
- [ ] Runtime recreation tests cover `queued`, `starting`, and `running`, including duplicate bootstrap and delayed events.
- [ ] No queued timeout, orphan deletion, heartbeat authority, alarm-based correctness mechanism, or fallback scheduler is introduced.
