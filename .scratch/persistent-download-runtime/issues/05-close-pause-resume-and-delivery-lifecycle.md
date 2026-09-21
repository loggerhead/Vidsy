# 05 — Close the pause, resume, and browser-delivery lifecycle

**What to build:** Complete the persistent lifecycle for paused, resumed, retried, cancelled, and finalizing jobs. New attempts must be fenced from old events, resumable bytes must satisfy the existing OPFS consistency contract, and product success must require a terminal browser-download completion.

**Blocked by:** 04 — Implement MV3 bootstrap and execution recovery.

**Status:** ready-for-agent

- [ ] Pause targets only the current execution identity and moves the durable job to `paused` after the executor acknowledges cancellation.
- [ ] Pause preserves only OPFS and chunk metadata that pass the existing consistency and resumability contract.
- [ ] Resume and retry create a new attempt and execution identity while preserving the immutable selected execution specification.
- [ ] Delayed progress, cancellation, artifact, success, or failure events from an earlier attempt cannot mutate the resumed or retried job.
- [ ] Cancellation is deterministic for queued, starting, running, paused, and finalizing jobs and cannot allow cancelled work to restart.
- [ ] A validated output artifact moves the job to `finalizing`; it does not mark the product download successful.
- [ ] Browser-download completion is required before the job becomes `succeeded` and enters successful history.
- [ ] Browser-download interruption moves the current job to `failed` with a stable machine-readable reason.
- [ ] Background recreation during `finalizing` uses browser-download inventory to reach the correct terminal state without duplicate delivery.
- [ ] Clearing terminal records cannot remove or mutate active jobs.
- [ ] Contract and integration tests cover pause, resume, retry, cancel, stale attempt events, browser completion, browser interruption, and finalizing recovery.
- [ ] No hidden full restart, implicit media reselection, quality fallback, or timestamp-based recovery is introduced.
