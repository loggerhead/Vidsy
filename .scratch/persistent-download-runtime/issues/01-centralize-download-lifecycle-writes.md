# 01 — Centralize download lifecycle writes

**What to build:** Introduce one coordinating lifecycle seam through which queue state, execution progress, browser delivery, commands, and terminal outcomes are written. Preserve current user-visible behavior while removing direct lifecycle mutation from callers, so the later runtime replacement has one controllable entry point.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Download submission, cancellation, pause, resume, retry, queue reorder, executor progress, browser delivery, and terminal-history updates enter through one coordinating interface.
- [ ] Existing popup, side-panel, content-overlay, progress-window, interceptor, and context-menu behaviors remain operational.
- [ ] Callers no longer write lifecycle storage directly or independently decide lifecycle transitions.
- [ ] Existing queue order, concurrency, progress stages, terminal history, and browser-download behavior remain unchanged.
- [ ] Focused contract tests exercise the coordinating interface rather than private helpers or storage-call order.
- [ ] No persistent queue, duplicate state authority, compatibility switch, or fallback execution path is introduced.
