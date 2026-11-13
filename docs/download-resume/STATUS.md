# Download recovery implementation status

The complete objective is [requirements.md](requirements.md). M0 through M5 were implemented and accepted sequentially. All gates and the overall objective are complete.

## Final verification

Core and real worker integration: **202 passed**. Package/page units: **48 passed**. Processing/cancel orchestration: **nine passed**. All **17 type-check packages**, production build, relevant ESLint and patch checks pass. Final complete browser regression: **97 passed, zero failures**, with four existing opt-in external live-account cases skipped (19 passing files and one skipped file).

| Gate | Accepted behavior | Record |
| --- | --- | --- |
| M0 | Preserve valid progress after transport/processing failure; Retry validates cached input and reruns only missing work | [M0 acceptance](M0-acceptance.md) |
| M1 | Versioned storage.local task/input/progress ledgers, migration, browser restart/crash/reload recovery, stable resource matching, TTL/LRU and immediate cancel cleanup | [M1 acceptance](M1-acceptance.md) |
| M2 | Persistent finite backoff, actual reconnect and background suspension alarms, retained exhaustion failure and cancellation fences | [M2 acceptance](M2-acceptance.md) |
| M3 | HLS/DASH VOD and independent-track resume, manifest/sequence drift restart, live Stop semantics and frozen completed-input processing Retry | [M3 acceptance](M3-acceptance.md) |
| M4 | Weak/date HTTP validation, <=1 MiB Range/segment/init checkpoints, bounded source URL/header renewal and saved output re-delivery after restart | [M4 acceptance](M4-acceptance.md) |
| M5 | Probed capabilities, paused byte summaries, persistence/cache/TTL settings, metered policy/manual fallback, batch controls and source diagnostics | [M5 acceptance](M5-acceptance.md) |

The complete path/integrity/Definition of Done matrix is in [global acceptance](GLOBAL-acceptance.md). Final logs, correction history and SHA-256 manifests are under [M5 evidence](evidence/m5-2026-11-12). Earlier milestone folders retain their independent evidence.

## Protocol and verification limits

No-Range sources cannot resume by byte offset or meet the 1 MiB retransmission bound: direct streams restart with a visible reason; segmented sources keep complete parts and retry incomplete parts in full. Incomplete live snapshots stop without a resume promise, including through Pause all. Completed live inputs support frozen local processing Retry, and completed output supports local re-delivery after restart.

HTTP cache reuse checks validators/length/coordinates and full local hashes; date/weak/validator-free and alias reuse also require bounded remote samples. Saved outputs use full block hashes and metadata proof with a 24-hour lease. Input retention defaults to seven days and is configurable from 1 to 365 days in settings. TTL/LRU and cancel collect owned files and records; shared passthrough input leases remain separate from artifact expiry.

Chrome on this host does not expose reliable connection.type, so the UI offers a manual metered flag. Cellular/data-saver event handling and real settings controls are tested; effectiveType=4g is never treated as cellular. No physical Wi-Fi-to-cellular transition or actual host sleep is claimed. Wake policy uses overdue-clock/runtime recreation and real suspended-service-worker alarms. Four external-account opt-ins were not enabled. Native Chrome downloads retain their own semantics; re-delivery starts a fresh native copy. Unsupported DASH layouts and AES-128 parts over the existing 32 MiB decryption bound fail explicitly.

README and CHANGELOG match the implemented capabilities and limits. No commit, push, version change, subagent, server/cloud component or resident native process was introduced. Preexisting unrelated dirty work is preserved.
