# Media detection lifecycle

Network media detection is document-scoped even though Chrome reports the
events through independent APIs. `webRequest.onResponseStarted`,
`tabs.onActivated`, and `tabs.onUpdated` have no guaranteed relative order. A
one-shot authority response such as an HLS master manifest can therefore arrive
before the service worker has observed the active tab or its navigation.

## Ownership

- `TabWorkLifecycle` is the only authority for a tab's active document
  generation. Detection code reads that generation; it must not infer or
  advance navigation state itself.
- `createNetworkCaptureAdmission` is the only gate from `webRequest` into
  network detection. It waits for service-worker bootstrap, aligns the current
  tab URL/loading state, establishes capture when activation raced the
  response, and only then calls the detector.
- `tabs.onUpdated` reports navigation facts to `TabWorkLifecycle`; listeners
  must not clear detections or increment generations independently.

## Required invariants

1. An early response is retained while the initial active-tab lookup is in
   flight. It is never synchronously discarded just because lifecycle state has
   not been restored yet.
2. A response from a newly opened active tab may establish generation 0 before
   `tabs.onActivated` or `tabs.onUpdated` arrives. Those later notifications
   confirm the same generation.
3. Chrome can emit both `status: loading` and a URL change for one navigation.
   They advance the document generation at most once.
4. A replacement document owns capture as soon as navigation starts, while its
   detection waits behind cleanup of the previous generation. Cleanup therefore
   cannot erase a newly detected item.
5. A previously unknown tab remains outside capture unless the current Chrome
   tab state says it is active; observing a response alone never establishes
   capture ownership.

The executable contract lives in
`chrome-extension/src/background/lib/network-capture-admission.test.ts` and
`chrome-extension/src/background/lib/tab-work-lifecycle.test.ts`. When changing
startup, tab, or network listeners, extend these tests with the event ordering
being introduced before changing the listener.
