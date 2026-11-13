# M5 and global acceptance evidence

The final enabled browser suite passed 97 cases with zero failures; four external-account opt-ins were skipped. Core: 202; workspace units: 48; orchestration: nine; type-check: all 17 packages. Build, relevant lint and patch checks pass.

`global-final-browser.log` is the final full sweep against the unchanged final production bundle. Initial/second full sweeps, the passing 95-case sweep before the last live-batch refinement, failed live-only UI cases, and passing correction runs are retained separately. Older dedicated/targeted development runs are marked as initial/intermediate. The current acceptance record and commands are in `../../M5-acceptance.md`.

`lint-files.txt` lists the checked files. The unchanged background logger is outside the relevant lint check. `source-SHA256SUMS` uses paths relative to the repository root; `bundle-SHA256SUMS` uses paths relative to `.output/chrome-mv3`; `SHA256SUMS` uses paths relative to this evidence folder. `environment.json` records the exact source HEAD, tool versions, final results and verification limits. No physical host sleep, physical cellular transition or external-account acceptance is claimed.
