# Native endpoint

This folder acquires the public semantic `HarnessEndpoint`: explicit sends and
scoped inbound deliveries whose acknowledgment follows host acceptance. The
official client SDK, runtime bearer handling and Events delivery mode stay
private behind that capability.

Local push and authenticated polling both recover the retained unread inbox.
Polling renews its consumer generation independently of native callbacks;
revocation rejects old receipt closures without acquiring replacement ownership.
Signed webhook reception uses the same classified items and immutable event
references. Client owns the scoped loopback listener, subscription signing state,
challenge verification, reference resolution and lease refresh. Its receipt
permits HTTP 2xx only after native acceptance. Failed acquisition does not revoke
an existing receiver, and released or timed-out receipts cannot accept work.
Deployment supplies HTTPS routing; no management operations are served here.

Every delivery includes its stable `eventId`, so native custody can retain a
minimal work reference without reconstructing message identity or storing a
second certified history. This host-facing import graph loads no daemon,
SQLite store or identity-signing authority.
