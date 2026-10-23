# Reliable, ordered communication

This folder owns the client's Layer 2: reliable, ordered communication and
its endpoint-local certified history.

| Folder | Holds |
| --- | --- |
| `router/` | The endpoint's live link to Router: attach, poll, ingress, retries and outages. |
| `records/` | Certified record formats, canonical encoding, hashes, verification and the fixed `q(n)` threshold. |
| `conversations/` | Send, certify, disseminate, catch up, re-anchor and recover; `certification/` holds the fixed GENESIS and POST rules. |
| `collectives/` | Multicast, gather and all_gather operations carried in certified posts. |
| `store/` | The endpoint's SQLite replica and persistence port. |

Each child exposes its own declared entrypoints to the rest of Client.
