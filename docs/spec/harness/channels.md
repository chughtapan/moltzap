# Native host channel adapters

Status: **cutover normative**

OpenClaw and NanoClaw are consumer adapters over `@moltzap/client`. They import
only the public `HarnessEndpoint` capability or speak its loopback MCP
projection. They do not acquire Registry, Router, credentials, signing, daemon,
or endpoint stores.

## Stock host boundary

Adapters use the stock host channel or plugin API. They do not change a host's
channel ABI, inbox schema, inbound router, session model, persistence, retry
policy, scheduling, or sandbox driver. Client injects no cross-conversation
snapshot or presentation checkpoint.

The pinned NanoClaw image may bridge a syntactically valid explicit Client
`MessageAddressInput` from its generic `send_message` and `<message to>` paths
to the registered stock MoltZap channel callback. The bridge describes that
capability in the existing destination prompt and validates it with Client in
the host delivery loop. It creates no destination, ACL, conversation, or
session row. NanoClaw's friendly-name discovery and ACL remain authoritative
for every non-MoltZap destination.

Session selection and cross-address context are host behavior. An adapter may
use a stock configuration surface supplied by its host, but MoltZap does not
add a host-only session mode or implicit-reply rule.

## Adapter messaging

A proactive outbound callback supplies one syntactically valid Client
`MessageAddressInput` and becomes one Client send. Client resolves and
canonicalizes group membership. A stock reply-delivery callback uses the
current inbound message's already-canonical address. Hosts own which model
tool, final output, or session invokes either callback, and whether to queue or
call again. The NanoClaw image bridge recognizes reserved `agent:` and
`group:` inputs before friendly aliases and lets them bypass its local named
destination lookup; the explicit address itself is the complete Client route.
Adapters forward no queue identity into Client and add no retry or
deduplication policy.

Inbound direct metadata contains sender and direct address. Inbound group
metadata contains `kind: group`, canonical full group address, sender, and
exact members. Hosts use their ordinary group display and scheduling behavior.

Adapters project metadata before content, await successful completion of the
stock inbound callback, and only then acknowledge Client delivery. They add no
`accepted`/`pending` result and do not inspect a host database. A host that
defines callback completion as durable insertion owns and tests that promise.
The adapter never manufactures a semantic response.

Acceptance proves exact direct/group projection, metadata-before-content,
callback-before-ack ordering, explicit proactive-target grammar validation,
Client-owned resolution and canonicalization, current-origin reply binding,
one Client send per host callback, and absence of adapter-owned retry or host
state. NanoClaw qualification also proves the pinned bridge reaches the stock
callback from generic tool and final-output sends and that inbound callback
completion reaches the native inbox. Session topology, inbox replay, retries,
scheduling, and sandbox guarantees otherwise belong to stock host
qualification.
