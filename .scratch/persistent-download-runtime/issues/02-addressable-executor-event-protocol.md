# 02 — Establish an addressable executor event protocol

**What to build:** Make each offscreen media execution explicitly addressable so the coordinator can identify which job attempt produced every acknowledgement, progress update, artifact, cancellation result, and failure. Expose the executor's active inventory without changing the current scheduling authority yet.

**Blocked by:** 01 — Centralize download lifecycle writes.

**Status:** ready-for-agent

- [ ] Every execution start command carries a stable job identity, monotonically increasing attempt number, and unique execution identity.
- [ ] Executor acknowledgement, progress, artifact, cancellation, and failure events echo the same identities.
- [ ] The coordinator can query a structured inventory of active executor identities and acknowledged execution states.
- [ ] Events from a non-current execution can be identified without relying on media URL, elapsed time, or last-progress timestamps.
- [ ] Existing HTTP, HLS, DASH, separate-track, MP3, OPFS, and artifact-validation paths continue to execute through the protocol.
- [ ] Protocol contract tests cover successful execution, failure, cancellation, inventory, and delayed events.
- [ ] The existing scheduler remains the only scheduling authority during this ticket; no second persistent queue or dual-write lifecycle is introduced.
