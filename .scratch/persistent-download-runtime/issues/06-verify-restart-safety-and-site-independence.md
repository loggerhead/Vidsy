# 06 — Verify restart safety and site independence

**What to build:** Prove the persistent download lifecycle through the highest available runtime and extension seams. The verification must demonstrate that service-worker disposal at every non-terminal state neither strands nor duplicates a job, and that the result applies equally to the motivating YouTube download and repository-controlled media fixtures.

**Blocked by:** 04 — Implement MV3 bootstrap and execution recovery; 05 — Close the pause, resume, and browser-delivery lifecycle.

**Status:** ready-for-agent

- [ ] The `DownloadRuntime` contract suite covers every legal transition and representative illegal transitions through submit, command, bootstrap, executor event, browser-delivery event, and snapshot behavior.
- [ ] Tests prove deterministic queue order, one-based queue-position projection, configured concurrency, duplicate submission behavior, idempotent commands, and terminal-history isolation.
- [ ] Tests prove that stale acknowledgements, progress, artifacts, cancellation results, failures, and completions from superseded execution identities cannot mutate current jobs.
- [ ] Runtime destruction and recreation is verified independently in `queued`, `starting`, `running`, and `finalizing`.
- [ ] A Chrome extension integration test submits through the real message surface, reloads or suspends the service worker, reopens an extension surface, and observes the same durable job advance without duplicate execution.
- [ ] Existing worker, OPFS, media-processing, output-validation, and browser-download-state suites continue to pass and remain the lower-level executor evidence.
- [ ] Repository-controlled direct HTTP and adaptive separate-track fixtures pass the restart scenario without network-site dependency.
- [ ] The specified YouTube video can be downloaded manually as an adaptive format, advances beyond `Queued`, survives a service-worker restart, and produces exactly one completed browser download.
- [ ] Lifecycle diagnostics expose job, attempt, execution, previous state, event, and next state while continuing to redact URLs, headers, cookies, and tokens.
- [ ] Root type checking, focused tests, production extension build, and manifest asset validation pass.
- [ ] A repository search confirms that no executable in-memory queue, runner-registration seam, pause-intent authority, direct lifecycle writer, dual-write compatibility path, timeout cleanup, or fallback scheduler remains.
- [ ] Completion evidence records commands, results, and any manual browser steps needed to reproduce the acceptance scenario.
