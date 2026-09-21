# Persistent Download Runtime

Status: ready-for-agent

## Problem Statement

Vidsy currently shows a download as `Queued` before the download executor starts. A short-lived queued state is useful when the configured concurrency limit is occupied, but a task can remain queued forever after a Manifest V3 service worker suspension or restart.

The visible progress record and the executable queue currently have separate authorities. The user interface reads a persisted download-progress record, while pending and running work is held in service-worker memory. If that memory disappears, the visible queued record can survive without an executable task behind it. The user sees a download that appears active but can neither advance nor explain why it stopped.

This is not specific to YouTube, a codec, a container, or a media provider. YouTube makes the lifecycle failure visible because adaptive video downloads are long-running and require multiple processing stages, but the defect applies to every queued download.

The current design also spreads download lifecycle knowledge across the background coordinator, queue implementation, offscreen executor, browser-download listener, storage projection, and user interfaces. Those parts can independently infer or write lifecycle state. This makes service-worker recovery, cancellation, pause and resume, concurrency accounting, stale-event rejection, and deterministic testing harder than necessary.

The system must not solve this by timing out queued records, deleting apparent orphan entries at startup, adding retries around individual asynchronous calls, extending service-worker lifetime, or synchronizing a persistent queue with a second in-memory queue. Those approaches preserve the split authority and only mask particular manifestations of it.

## Solution

Vidsy will replace the in-memory download queue and progress-as-authority model with one persistent `DownloadRuntime` module.

The persistent job store will be the sole authority for:

- the submitted download specification;
- queue ordering;
- lifecycle state;
- active execution identity;
- attempt number;
- processing phase;
- progress;
- terminal outcome.

The runtime will expose one small interface for submitting jobs, issuing commands, and reading a snapshot. User interfaces, message handlers, the offscreen executor, and browser-download events will interact with the lifecycle only through this interface.

The Manifest V3 service worker will be treated as disposable. Every activation will run the same bootstrap protocol: load non-terminal jobs, reconcile them with the offscreen executor's active execution inventory, calculate available concurrency, claim queued jobs, and dispatch work. First startup, idle wake-up, extension reload, and recovery after interruption will follow the same path.

Each execution attempt will have a unique execution identity. Progress and completion events must carry that identity, and the runtime will reject events that do not belong to the currently claimed attempt. This prevents delayed events or superseded workers from mutating the current job.

The offscreen document will remain the media executor responsible for network transfer, OPFS operations, media processing, artifact validation, and execution events. It will not own queue order or terminal product state. The background runtime will remain the lifecycle coordinator and final authority for browser-download delivery.

The user will continue to see `Queued`, but it will have a precise meaning: a durable job exists, is ordered in the queue, and is eligible to be claimed when capacity becomes available. A queued job will never be only a stale display record.

## User Stories

1. As a Vidsy user, I want a queued download to start when capacity becomes available, so that the queue represents real work rather than a visual placeholder.
2. As a Vidsy user, I want downloads to survive service-worker suspension, so that normal Manifest V3 lifecycle behavior does not strand my tasks.
3. As a Vidsy user, I want queued downloads to survive a service-worker restart, so that I do not need to reopen the page and submit them again.
4. As a Vidsy user, I want a queued position to remain stable and understandable, so that I know when my download is expected to start.
5. As a Vidsy user, I want queue reordering to change the authoritative order, so that the displayed order and scheduler order always agree.
6. As a Vidsy user, I want cancellation of a queued job to remove the actual job, so that it cannot start later after disappearing from the interface.
7. As a Vidsy user, I want cancellation of a running job to target the current execution, so that an older or newer attempt is not accidentally affected.
8. As a Vidsy user, I want pause to preserve only validated resumable state, so that resuming cannot silently produce a corrupt file.
9. As a Vidsy user, I want resume to create a deliberate new execution attempt, so that the runtime can distinguish old and current events.
10. As a Vidsy user, I want retry after failure to create a deliberate new attempt, so that stale failure or progress events cannot overwrite the retry.
11. As a Vidsy user, I want duplicate download clicks to resolve deterministically, so that the same logical job is not accidentally executed twice.
12. As a Vidsy user, I want the configured concurrency limit to remain correct after a worker restart, so that Vidsy neither stalls nor starts too many resource-intensive jobs.
13. As a Vidsy user, I want long-running adaptive downloads to continue through normal extension lifecycle changes, so that YouTube and similar sources behave reliably.
14. As a Vidsy user, I want direct HTTP, HLS, DASH, and separate audio/video downloads to use the same lifecycle, so that reliability does not depend on media kind.
15. As a Vidsy user, I want subtitles to have an explicitly defined lifecycle, so that fast-path behavior does not bypass product-level success and failure semantics.
16. As a Vidsy user, I want the interface to distinguish queue state from media-processing phase, so that `Queued`, `Downloading video`, `Muxing`, and `Finalizing` have unambiguous meanings.
17. As a Vidsy user, I want a failed task to show a stable reason, so that lifecycle failures are visible instead of appearing as permanent activity.
18. As a Vidsy user, I want a completed task to be recorded only after browser delivery completes, so that a generated artifact is not mistaken for a successfully saved file.
19. As a Vidsy user, I want interrupted browser delivery to produce a failed terminal result, so that the history remains honest.
20. As a Vidsy user, I want completed and failed jobs to remain inspectable until I clear them, so that I can review outcomes without keeping them schedulable.
21. As a Vidsy user, I want clearing terminal history to leave active jobs untouched, so that housekeeping cannot cancel work.
22. As a Vidsy user, I want closing and reopening the popup or side panel to show the same job state, so that UI lifetime does not affect download lifetime.
23. As a Vidsy user, I want all Vidsy surfaces to display the same queue and progress snapshot, so that the popup, side panel, content overlay, and progress window do not disagree.
24. As a Vidsy user, I want a service-worker restart during queue claim to produce at most one active execution, so that the media is not downloaded twice.
25. As a Vidsy user, I want a service-worker restart during transfer to reconnect to the active executor when possible, so that work already in progress is not discarded.
26. As a Vidsy user, I want a service-worker restart during finalization to preserve the correct delivery outcome, so that finished artifacts do not become stuck.
27. As a Vidsy user, I want an unavailable executor to result in a defined state transition, so that a task never remains indefinitely in an ambiguous running state.
28. As a Vidsy user, I want runtime recovery to use the same normal protocol on every activation, so that correctness does not depend on special timeout cleanup.
29. As a Vidsy maintainer, I want one lifecycle authority, so that queue, progress, cancellation, retry, and terminal state cannot drift.
30. As a Vidsy maintainer, I want in-memory data to be disposable caches only, so that deleting process memory cannot change durable behavior.
31. As a Vidsy maintainer, I want a small `DownloadRuntime` interface, so that callers do not need to understand scheduler and recovery internals.
32. As a Vidsy maintainer, I want all state transitions validated in one module, so that illegal transitions cannot be written from arbitrary event handlers.
33. As a Vidsy maintainer, I want queue order derived from persisted jobs, so that there is no synchronization protocol between storage and memory.
34. As a Vidsy maintainer, I want concurrency derived from claimed non-terminal jobs, so that restart does not reset capacity accounting.
35. As a Vidsy maintainer, I want each execution attempt fenced by a unique identity, so that delayed executor events are harmless.
36. As a Vidsy maintainer, I want the executor to report facts rather than mutate product state, so that lifecycle decisions stay local to the runtime.
37. As a Vidsy maintainer, I want browser-download events to enter through the runtime, so that delivery completion follows the same transition rules.
38. As a Vidsy maintainer, I want storage writes to be serialized by the runtime, so that concurrent progress and command messages cannot lose updates.
39. As a Vidsy maintainer, I want the submitted specification to be minimal and immutable, so that retries execute the user's chosen media rather than reselecting a later variant.
40. As a Vidsy maintainer, I want display metadata separated from execution inputs, so that thumbnails and unused variants do not bloat durable jobs.
41. As a Vidsy maintainer, I want stable machine-readable failure reasons, so that tests and interfaces do not parse error prose.
42. As a Vidsy maintainer, I want bootstrap to be idempotent, so that multiple wake-up events cannot claim duplicate work.
43. As a Vidsy maintainer, I want submit to be idempotent for the same logical request, so that repeated messages cannot create accidental duplicates.
44. As a Vidsy maintainer, I want commands to be idempotent where practical, so that repeated cancel or pause messages are safe.
45. As a Vidsy maintainer, I want lifecycle correctness independent of service-worker keepalive behavior, so that browser lifecycle changes do not invalidate the design.
46. As a Vidsy maintainer, I want recovery behavior expressed in the state machine, so that there is no separate orphan-cleanup algorithm.
47. As a Vidsy maintainer, I want a deterministic scheduler, so that queue tests do not depend on wall-clock timing.
48. As a Vidsy maintainer, I want dependencies such as storage, executor inventory, and delivery to be supplied through internal seams, so that the runtime can be tested without a live website.
49. As a Vidsy maintainer, I want tests to observe only runtime commands and snapshots, so that internal refactoring does not rewrite the suite.
50. As a Vidsy maintainer, I want existing media-processing behavior to remain behind the executor seam, so that lifecycle work does not duplicate the remux planner.
51. As a Vidsy maintainer, I want migration to replace the old authority rather than layer over it, so that the old queue can be deleted when the new runtime is enabled.
52. As a Vidsy maintainer, I want production diagnostics to include job, attempt, execution, and transition identities, so that lifecycle failures can be reconstructed without logging sensitive media URLs.
53. As a Vidsy maintainer, I want terminal jobs excluded from scheduling by model invariant, so that clearing or retaining history cannot restart them.
54. As a Vidsy maintainer, I want startup reconciliation to compare durable claims with executor inventory, so that the runtime can resume ownership without guessing from timestamps.
55. As a Vidsy maintainer, I want executor acknowledgements to distinguish `starting` from `running`, so that failures before execution are represented accurately.
56. As a Vidsy maintainer, I want final browser delivery to have its own phase, so that media processing completion and user-visible completion are not conflated.
57. As a Vidsy maintainer, I want queue positions to be derived in snapshots, so that renumbering every stored job is not required after every claim or reorder.
58. As a Vidsy maintainer, I want schema versioning for durable jobs, so that future releases can reject or migrate incompatible records explicitly.
59. As a Vidsy maintainer, I want extension reload behavior covered by an end-to-end test, so that unit tests do not provide false confidence about MV3 lifecycle.
60. As a Vidsy maintainer, I want the original YouTube reproduction to become a verification scenario without making YouTube a scheduling dependency, so that the fix remains site-agnostic.

## Implementation Decisions

- Build one deep `DownloadRuntime` module. Its external interface consists of submitting an immutable download specification, issuing a command against a job, and obtaining or subscribing to a runtime snapshot.
- Use the persistent job store as the sole lifecycle authority. The runtime must not maintain a second authoritative pending queue, running set, pause-intent set, or progress map in memory.
- Treat all in-memory indexes as derived caches. Clearing them and rebuilding from the persistent store must not change observable behavior.
- Replace the existing queue implementation rather than synchronizing it with the new runtime. The migration is complete only when the old pending array, running set, runner registration, and direct progress writers are removed.
- Persist a versioned `DownloadJob` record containing a stable job identity, immutable execution specification, lifecycle state, queue-order key, attempt number, optional current execution identity, processing phase, progress, terminal outcome, and timestamps used for audit rather than correctness guesses.
- Persist only the selected execution inputs and minimal display metadata. Do not persist all detected variants, base64 thumbnails, captured page state, or other discovery data that is no longer needed after submission.
- Separate lifecycle state from processing phase. Lifecycle state determines scheduler eligibility and terminality; processing phase describes work inside a running attempt.
- Use the following lifecycle states: `queued`, `starting`, `running`, `finalizing`, `paused`, `succeeded`, `failed`, and `cancelled`.
- Define a closed transition table inside the runtime. Every state mutation, including executor progress, cancellation, browser delivery, and recovery, must be validated against that table.
- Define `queued` as a durable, schedulable job with an order key and no active execution identity.
- Define `starting` as a claimed job with an execution identity that has not yet been acknowledged by the executor.
- Define `running` as an executor-acknowledged attempt.
- Define `finalizing` as a validated output artifact undergoing browser delivery or awaiting its terminal browser-download result.
- Define `paused`, `succeeded`, `failed`, and `cancelled` as non-schedulable states. Resume and retry are explicit commands that create a new attempt rather than mutating an old execution back into activity.
- Assign a monotonically increasing attempt number and a unique execution identity whenever a queued or resumed job is claimed.
- Require every executor acknowledgement, progress event, artifact result, cancellation acknowledgement, and failure event to carry the job identity, attempt number, and execution identity.
- Reject events whose execution identity does not match the current claim. Rejection must be observable in diagnostics but must not mutate the job.
- Make submission idempotent using an explicit logical request identity. Do not infer idempotency only from the current media URL because the same source may support deliberate downloads with different variants or output intents.
- Keep queue order durable. Reordering updates only queued jobs and cannot move running or terminal jobs.
- Derive visible one-based queue positions from sorted queued jobs in the runtime snapshot rather than storing a second position projection that must be renumbered.
- Calculate available capacity from persisted `starting`, `running`, and `finalizing` jobs subject to the configured concurrency policy.
- Serialize scheduler claims and command transitions through the runtime's storage mutation mechanism so that multiple wake-up events cannot claim the same job.
- Model service-worker activation as normal bootstrap, not exceptional recovery. Bootstrap loads jobs, asks the executor for its active execution inventory, reconciles current claims, calculates capacity, and dispatches eligible jobs.
- Make bootstrap idempotent. Running it repeatedly or concurrently must converge to the same job and execution set.
- Define executor inventory as a structured list of active execution identities and their acknowledged states. The runtime must not infer executor presence from elapsed time or last progress timestamp.
- If a persisted active claim exists in executor inventory, bootstrap re-establishes coordination without creating another attempt.
- If an execution was durably claimed but the executor proves it is absent, the transition is determined by the job state and resumability contract. The runtime creates a new attempt only through the same explicit state-machine transition used for ordinary resume or retry.
- Do not use a queued timeout, stale timestamp, or startup deletion as a lifecycle decision.
- Keep the background context as coordinator and sole writer of product lifecycle state.
- Keep the offscreen context as executor for transfer, OPFS, media processing, output validation, and structured execution events.
- Prevent the offscreen executor from deciding queue order, product terminal state, history insertion, or whether a stale execution event should be accepted.
- Route browser-download completion and interruption through the runtime before updating terminal state or history.
- Record success only after the output artifact has passed validation and the browser download has reached its completed state.
- Record failure when browser delivery is interrupted. Do not leave a job in `finalizing` after a terminal browser-download event.
- Integrate the existing media descriptor, capability planner, processing plan, and artifact-validation pipeline as executor dependencies. The lifecycle runtime must not add a second media-planning authority.
- Use structured machine reason codes for lifecycle failures, including invalid transition, executor unavailable, execution superseded, artifact failure, browser delivery interrupted, and incompatible persisted schema.
- Treat cancellation, pause, resume, retry, reorder, and clear-terminal-history as commands handled by the runtime.
- Make repeated cancellation and repeated pause commands safe and deterministic.
- Allow clearing only terminal job records. Active-job removal must occur through cancellation and its defined terminal transition.
- Make all user interfaces read the same runtime snapshot and issue commands. Remove local lifecycle inference based on `busyUrl`, remembered clicks, or independently assembled active-stage sets.
- Preserve the existing configurable concurrency range and product behavior unless measurement demonstrates a reason to change it.
- Keep message-channel lifetime handling correct, but do not rely on it for durable correctness. Message acknowledgements confirm command acceptance, not completion of the long-running job.
- Add privacy-safe lifecycle logging with job identity, attempt, execution identity, previous state, event, and next state. Media URLs, authentication headers, cookies, and page tokens remain redacted.
- Introduce a schema version on persistent runtime state. Incompatible versions must be handled by an explicit migration or explicit rejection, never by silently interpreting fields under the new model.
- Deliver the migration as replacement slices: define the model and store, introduce the runtime behind the existing message surface, move all writers through it, switch UI projections, then delete old queue and progress authorities.
- Do not retain a compatibility path that can choose between the old queue and new runtime at execution time.

## Testing Decisions

- The primary and ideally only behavioral test seam is the external `DownloadRuntime` interface: submit a job, issue commands or executor events, run bootstrap, and inspect the resulting snapshot and emitted executor commands.
- Tests assert externally visible lifecycle behavior, scheduler decisions, executor commands, and snapshots. They do not assert private arrays, storage-call counts, helper invocation order, or internal method names.
- Supply persistent storage, executor inventory, executor command transport, settings, identity generation, and browser delivery through internal seams. Production adapters use Chrome APIs; deterministic adapters are used by runtime tests.
- Use an in-memory persistent-store adapter that can be discarded and recreated around the same stored records to simulate service-worker death without changing the runtime interface.
- Add a contract suite for every legal state transition and representative illegal transitions.
- Verify that submitting a job persists an immutable specification and yields a queued snapshot with a real queue position.
- Verify that bootstrap claims queued work up to configured capacity and emits one executor start command per claim.
- Verify that repeated bootstrap does not duplicate claims or executor commands for acknowledged active executions.
- Verify that destroying and recreating the runtime while a job is queued still allows the job to be claimed.
- Verify that destroying and recreating the runtime while a job is starting reconciles against executor inventory without duplicate execution.
- Verify that destroying and recreating the runtime while a job is running reconnects to the matching execution.
- Verify the defined behavior when a persisted starting or running claim is absent from executor inventory.
- Verify that a stale progress event from a prior execution identity cannot change the current job.
- Verify that a stale success or failure event from a prior attempt cannot terminate the current job.
- Verify that concurrency remains correct after runtime recreation.
- Verify deterministic queue ordering and one-based queue-position projection after submit, claim, cancel, and reorder.
- Verify that reorder affects only queued jobs.
- Verify idempotent submission for the same logical request identity and distinct jobs for intentionally different output specifications.
- Verify queued cancellation removes scheduler eligibility and results in a terminal cancelled snapshot.
- Verify running cancellation targets only the current execution identity.
- Verify pause preserves only validated resumable progress and moves the job to paused.
- Verify resume increments attempt, creates a new execution identity, and preserves only contractually valid checkpoints.
- Verify retry from failed state creates a new attempt without re-running media selection.
- Verify browser delivery completion is required before `succeeded`.
- Verify browser delivery interruption results in `failed` with a stable reason.
- Verify terminal-history clearing cannot remove or mutate active jobs.
- Verify all UI projections can be derived from one runtime snapshot without independent active-stage inference.
- Reuse existing worker, OPFS, output-validation, browser-download-state, and media-processing tests as lower-level prior art; they remain responsible for executor correctness rather than scheduler lifecycle.
- Add a Chrome extension integration test that submits through the real message surface, observes a queued job, suspends or reloads the service worker, reopens an extension surface, and verifies that the same durable job advances without duplicate execution.
- Add integration coverage for service-worker restart in queued, starting, running, and finalizing states.
- Use repository-controlled fixtures for media execution. Network websites are evidence and exploratory scenarios, not deterministic test dependencies.
- Retain the specified YouTube URL as a manual end-to-end acceptance scenario: select an adaptive format, start the download, confirm that `Queued` advances, restart the service worker during execution, and confirm one final browser download.
- Run the same lifecycle acceptance scenario with a non-YouTube direct HTTP fixture to prove that the behavior is site-agnostic.
- Verify production diagnostics contain enough transition identity to reconstruct a failed lifecycle while continuing to redact sensitive request data.
- A release cannot claim completion while any lifecycle writer bypasses `DownloadRuntime` or while the old in-memory queue remains an executable authority.

## Out of Scope

- Adding a YouTube-specific scheduler, queue rule, timeout, retry, or extractor.
- Changing media detection, site extraction, stream selection, or DRM policy.
- Replacing the media descriptor, capability planner, processing planner, libav variant, or artifact-validation architecture.
- Adding video transcoding, quality fallback, implicit variant switching, or output-container fallback.
- Guaranteeing process continuity by keeping the service worker alive indefinitely.
- Using alarms, heartbeat messages, or open ports as the foundation of correctness.
- Treating stale timestamps as proof that an execution is absent.
- Maintaining both the old in-memory queue and the persistent runtime behind a feature flag or dual-write migration.
- Preserving arbitrary in-flight bytes when the existing resumability and OPFS consistency contract cannot validate them.
- Persisting jobs across a full browser restart if the product continues to define download lifetime as browser-session scoped. The model must permit a future storage-policy change without changing lifecycle semantics.
- Redesigning the visual appearance of download rows beyond changes required to represent the new state and phase model accurately.
- Changing the configured concurrency default or allowed range.
- Changing download-history retention policy except where history must consume runtime terminal outcomes.

## Further Notes

- The motivating reproduction is a YouTube adaptive download that remains at `Queued`, but the specification deliberately describes a provider-independent lifecycle architecture.
- `Queued` remains a valid product state. The defect is not the existence of the state; it is that the displayed state can outlive the executable job.
- Manifest V3 service-worker disposal is a normal operating condition. Correctness must be derivable from durable state and executor inventory without relying on JavaScript process continuity.
- Reconciliation is part of normal bootstrap because it compares two explicit facts: the durable current claim and the executor's reported inventory. It is not a fallback based on timeouts or heuristics.
- The architectural completion criterion is deletion: the old pending array, running set, runner-registration seam, pause-intent authority, and direct lifecycle-progress writers no longer exist.
- The testing completion criterion is restart safety: destroying and recreating the coordinating runtime at every non-terminal state does not create a permanent queue entry, duplicate execution, or false terminal result.
