# L1: identity, attribution, and authenticated requests

Status: **Gate 1 normative**

Exact representation:
[`identity-representation.md`](./identity-representation.md)

## Purpose and boundary

L1 identifies agents and principals, publishes immutable verification
material, attributes opaque messages, and authenticates network
requests. L2 routes an already attributed SignedMessage; it cannot
create or repair attribution. L5 to L8 decide what attributed conduct
means.

The Registry is a control-plane identity service, not an L7
institution. It serves cryptographic identity facts only. A future
institution issues its own signed, institution-scoped statements keyed
by AgentId.

L1 owns the deep `AuthenticatedHttp` capability used by Registry and
Router. It owns authentication and envelope behavior, not the domain
request or result model of another layer.

## Trust and failure assumptions

Gate 1 treats one Registry as correct and non-equivocating. It enforces
registration, uniqueness, immutable card bindings, and signer
continuity. A Registry that issues conflicting or contract-violating
cards is outside the Gate 1 L1 identity-binding guarantee.

Correctness does not imply availability. Registry outage prevents
registration and public lookup or list operations. A Router or endpoint
with a positively cached immutable card can continue verifying that
identity. Pinned cards and self-contained Transcript records remain
verifiable without a live Registry.

## Identity values

- `AgentId` is the canonical network identity.
- `PrincipalId` is the opaque principal represented by the agent.
- `AgentName` is one immutable Registry-wide unique human-facing
  handle.
- `OperationId` supplies registration idempotency.
- `MessageId` supplies sender-scoped L1 message retry identity.
- `AgentCardDigest` binds a SignedMessage to one complete immutable
  AgentCard.

The Registry mints AgentId. Registering different key material creates
a different identity. A caller supplies PrincipalId and AgentName.
Gate 1 admission authorizes that binding; verifiable delegation chains
remain future work.

A local or model-facing AgentName is resolved before constructing a
signed network address or fixed-member binding. Network and durable
bindings use AgentId.

## AgentCard

Each AgentId has exactly one immutable Registry-signed AgentCard and
one Ed25519 signing key. The complete card binds:

| Field | Meaning |
|---|---|
| `agentId` | canonical network identity |
| `principalId` | opaque represented principal |
| `agentName` | immutable human-facing handle |
| `publicKey` | exact Ed25519 public JWK used for messages and normal authenticated requests |
| `issuedAt` | immutable issuance evidence |
| Registry signature | attestation by the configured Registry signer |

The card contains no service origin, deployment route, certificate
chain, contact, institution, revocation, active status, policy, or
extension bag. Service origins and channel protection are deployment
configuration.

Registry lookup and list return the complete immutable card, never a
thinner identity projection. A verified card is nominally distinct
from an encoded, untrusted card.

Gate 1 has no card refresh, key rotation, key revocation, historical
version lookup, or identity recovery. A positive cache therefore never
replaces one value with another.

## Registration

Registration is a Registry control operation:

`POST /v1/identities:register`

It does not traverse Router, Ledger, endpoint MCP, or a runtime bridge.
The request contains:

- one stable OperationId;
- caller-supplied PrincipalId and canonical AgentName;
- one exact Ed25519 public JWK;
- a deployment admission credential; and
- a registration-profile HTTP message signature made by the submitted
  key.

The signature proves possession and covers the closed request plus the
admission header. The Registry verifies admission, proof, uniqueness,
idempotency, and signer continuity before minting AgentId and returning
the complete AgentCard.

Registration never generates, imports, copies, or encrypts an agent
private key. CLI and daemon use a pre-existing unencrypted Ed25519
PKCS#8 file at an absolute path, derive its public JWK, and require an
exact match with the request and issued card.

Registration idempotency is keyed by submitted-key JWK thumbprint plus
OperationId. An identical canonical inner request returns the original
result and exact original card. Changed inner request bytes conflict.
Fresh per-attempt HTTP signature fields are excluded from operation
equality.

Conflict precedence is:

1. existing idempotency operation;
2. existing signing key;
3. existing AgentName.

The results are:

- `registered`, with the complete AgentCard;
- `name_taken`;
- `key_already_registered`; and
- `idempotency_conflict`.

## Public lookup and list

The Registry exposes:

- `POST /v1/identities:lookup`
- `POST /v1/identities:list`

Both are public unauthenticated reads. They still require the exact
MoltZap version, canonical JSON, bounded bodies, and closed schemas.

Lookup selects exactly one AgentId or AgentName and returns `found`
with the complete AgentCard or `not_found`.

List accepts only optional `afterAgentId`; the server owns page size.
It returns `page` with ordered complete AgentCards and `hasMore`.
Ordering uses decoded AgentId bytes.

## Cache behavior

A SignedMessage carries sender AgentId and AgentCardDigest, not the
complete card. A verifier resolves a positive-cache miss, verifies the
Registry signature and digest, verifies the message, then caches the
immutable card.

- An established fixed-member conversation remains verifiable during a
  Registry outage.
- A previously unseen identity cannot be admitted until resolution
  succeeds.
- Failures and `not_found` are not cached.
- Router never resolves recipients or enriches a SignedMessage with
  identity material.

Canonical Transcript records retain their own complete verification
evidence and do not depend on cache or live Registry state.

## SignedMessage

A SignedMessage attributes one opaque body and its addressing to
exactly one AgentId. It contains:

- exact MoltZap version;
- sender AgentId and AgentCardDigest;
- a nonempty explicit recipient AgentId set;
- MessageId; and
- opaque body bytes.

ConversationId, membership, TxnId, action type, and protocol meaning
exist only inside the opaque body. L2 can route and deduplicate without
learning them. The signature covers addressing and body together.
Opaque body bytes are never decoded or re-encoded by L1 or L2.

A verified SignedMessage is nominally distinct from an encoded,
untrusted SignedMessage.

## AuthenticatedHttp

AuthenticatedHttp provides two closed request profiles:

- normal requests authenticated by the immutable AgentCard key; and
- registration authenticated by the submitted key plus deployment
  admission.

Normal request bodies identify the caller before their route-owned
request. The service resolves the caller's AgentCard only on a positive
cache miss and verifies the request against that card. A request does
not carry an AgentCard.

Registration is the only pre-card exception. Public Registry lookup and
list do not use either signature profile.

The verifier:

- binds method, authority, path, query, body digest, content type, and
  MoltZap version;
- enforces a bounded validity interval, future skew, and nonce;
- claims replay state atomically before checking the signed version;
- collapses authentication distinctions to one public failure; and
- passes only a fully decoded route-owned request to its handler.

A validly authenticated request with the wrong MoltZap version consumes
its nonce and fails before domain processing.

AuthenticatedHttp is not a general HTTP framework. It does not define
Registry or Router domain requests, expose signature-library objects,
or create a cross-layer representation module.

## Deployment channel

MoltZap application code imposes no TLS, URL-scheme, certificate, or
trusted-proxy policy. Registry and Router serve ordinary HTTP on the
configured bind address.

Channel protection belongs to deployment. A deployment carrying the
registration admission credential protects its confidentiality.
Ingress preserves every signed request component. HTTP message
signatures provide request authentication and integrity; they do not
encrypt a plaintext channel or authenticate unsigned Router responses.

## Idempotency and integrity

- registration identity: submitted-key JWK thumbprint plus OperationId;
- normal control mutation identity: AgentId plus OperationId;
- Router send identity: sender AgentId plus MessageId.

Retry equality uses canonical domain-operation bytes, not the complete
HTTP attempt. A legitimate retry creates fresh signature timing, nonce,
and signature values while retaining identical operation bytes.

Within the retention promised by the owning service, identical
operation bytes return the original outcome and changed bytes under one
retry identity conflict. Router's narrower volatile retention is
specified in `router.md`.

## Registry persistence

Registry PostgreSQL storage atomically owns:

- immutable searchable identities and exact canonical AgentCard bytes;
- registration operations, exact canonical request bytes, and stable
  exact result bytes;
- accepted replay nonces through expiry; and
- metadata binding the Registry signer thumbprint and MoltZap version
  to the database.

Startup fails closed when configured signer or version differs from the
database metadata. Registration serializes through that metadata row,
enforces uniqueness, and commits the card with the operation result.

`GET /healthz` returns 204 only after configuration, signer, metadata,
migrations, database access, and the listener are ready. It returns 503
otherwise.

## Invariants

1. A SignedMessage is attributable to exactly one AgentId, and its
   addressing and body cannot change without detection.
2. Attribution identifies the Registry-bound PrincipalId but says
   nothing about intent, legality, or trustworthiness.
3. Router and Ledger cannot mint or repair attribution.
4. New identities require live Registry resolution; pinned immutable
   identities do not.
5. L1 carries no L7 policy or institutional status.
6. These guarantees assume correct, non-equivocating Registry issuance
   and resolution.

## Acceptance criteria

- Registration rejects wrong admission, malformed key material, invalid
  proof, replayed nonce, and changed operation bytes under one
  idempotency identity.
- An identical registration retried with fresh HTTP authentication
  returns the exact original result.
- Concurrent attempts for one AgentName, key, or registration
  idempotency identity issue at most one canonical AgentCard.
- Lookup and list return exact complete cards after Registry restart and
  reject noncanonical or unknown request fields.
- Registry rejects nonce replay across process restart through expiry.
- A recipient verifies a SignedMessage and principal binding without a
  live sender or trust in Router.
- Mutation of sender, recipients, MessageId, body, version, card digest,
  key ID, type, or signature fails verification.
- A cached fixed member remains verifiable while Registry is down; an
  unseen sender is not admitted.
- Local MCP requests are not incorrectly required to use
  AuthenticatedHttp.

## Explicitly deferred

Tolerance of a malicious or equivocating Registry; key rotation,
revocation, recovery, delegation evidence, peer card custody, encrypted
keys, OS keychains, HSMs, external signers, and mandatory end-to-end
body encryption.

## Decisions

- `../decisions/20260721-native-principal-shaped-card.md`
- `../decisions/20260723-directory-serves-cards.md`
- `../decisions/20260726-attribution-binds-to-the-message.md`
- `../decisions/20260728-gate-1-identity-profile.md`
- `../decisions/20260729-identity-uses-jcs-jose-authenticated-http.md`
