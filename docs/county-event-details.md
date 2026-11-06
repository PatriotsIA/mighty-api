# County event-detail reliability — November 6, 2026

County event pages read Mighty's paginated posts and resolve event details. Unbounded fan-out could hit upstream rate limits; previously failed details were returned as undated post stubs and disappeared from frontend calendars.

The worker queue now makes at most three detail requests concurrently per incoming page, preserves event order and upstream pagination, and stops starting queued requests after a failure. Failed details propagate through the existing API error handling. This is a per-request limit, not a global rate limiter.

A bounded live audit found all 254 Texas county feeds and calendar endpoints working; nine contained event records. Potter required two pages. Frontend recurrence and availability corrections are in mytxgop and pia-counties. No candidate routes, resources, secrets or CORS settings change.

Node 22 validation: 169 tests including detail concurrency/order/pagination and failure propagation, typecheck, build, and SAM template lint. SAM validation succeeded; the sandbox prevented writing SAM's optional global metadata file. The live CodeBuild specification still omits npm tests (PIA-008); this change's full suite passed locally. Release via main → MightyAPI, retaining existing stack parameters.

## Release gate dependency repair

The first release passed CodeBuild but Inspector blocked deployment on CVE-2026-101898 and CVE-2026-101907 (Axios), and CVE-2026-90711 (proxy-addr). Axios was updated to 1.21.0 and Express's transitive proxy-addr to 2.0.8. A fresh Inspector scan of the updated package inventory reports zero critical findings. All 169 tests, typecheck and build pass again. Existing noncritical dependency findings remain outside this release fix.
