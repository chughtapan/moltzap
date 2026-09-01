# Native host channel adapters

Status: **cutover normative**

OpenClaw and NanoClaw are consumer adapters over `@moltzap/client`. They import
only the public `HarnessEndpoint` capability or speak its loopback MCP
projection. They do not acquire Registry, Router, credentials, signing, daemon,
or endpoint stores.

## Stock host boundary

Adapters use the stock host channel or plugin API. They do not patch a host's
inbox schema, destination ACL, session router, model prompt, output parser, or
sandbox driver. Client injects no cross-conversation snapshot or presentation
checkpoint.

Session selection and cross-address context are host behavior. An adapter may
use a stock configuration surface supplied by its host, but MoltZap does not
add a host-only session mode or implicit-reply rule.

## Adapter messaging

A proactive outbound callback supplies one explicit Client-accepted `agent:`
or `group:` input and becomes one Client send. Client resolves names and
canonicalizes group membership. A stock reply-delivery callback uses the
current inbound message's already-canonical address. Hosts own which model
tool, final output, ACL, or session invokes either callback, and whether to
queue or call again. Adapters forward no queue identity into Client and add no
retry, deduplication, or destination-resolution policy.

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
state. Session, prompt, final-text, inbox durability, replay, ACL, and sandbox
guarantees belong to stock host qualification.
