# v2 design origins, 2026-07-20 through 2026-07-27

This is a non-normative source-event ledger. It records located source events
and repository effects; it does not supply missing rationale or infer user
intent.

## Source manifest

- **S1** — local Claude JSONL session archive; session
  `bcba8e38-c0b9-42f9-af6b-6deda9655478`; basename
  `bcba8e38-c0b9-42f9-af6b-6deda9655478.jsonl`.
- **S2** — local Claude JSONL session archive; session
  `a3c74293-d31a-48de-8b36-e05ca97e989d`; basename
  `a3c74293-d31a-48de-8b36-e05ca97e989d.jsonl`.
- **S3** — local Claude JSONL session archive; session
  `19cdb5cb-a6e1-4514-8b82-e9e1e1313cc2`; basename
  `19cdb5cb-a6e1-4514-8b82-e9e1e1313cc2.jsonl`.
- Event roles below are the roles stored in the JSONL. UUID, `parentUuid`,
  `promptId` for stored user events, `requestId` and `message.id` for stored
  assistant events, and timestamp are copied from the stored event.
- Omitted from this compaction: system messages, tool results, task
  notifications, and file-history deltas except the AskUser answer needed to
  preserve a stored user selection; hidden thinking; subagent transcripts;
  external or private URLs; and unrelated turns. Literal excerpts are
  delimited as text blocks. One structured tool-use event is projected as JSON
  and labels its display-only whitespace. Every bracketed `[omitted: …]`
  marker is editorial, is not source text, and states whether surrounding
  source text was excluded.

<a id="20260720-the-network-is-a-router"></a>

## The network is a router

[ADR](../decisions/20260720-the-network-is-a-router.md)

- Source event — S1; UUID `951a5f64-0b09-46e1-be6d-dc8663fae0a4`;
  `parentUuid` `a3c5ce75-c259-48fe-a614-99f7e7aaae3c`;
  `promptId` `408e8619-7024-4e32-b8fd-f1f0374ff302`;
  `2026-07-20T19:58:39.303Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  TaskMasters dissolve. The network is basically a router.
  ```

- Source event — S1; UUID `ee36714a-0e0d-4561-a951-7b1f5a5b387c`;
  `parentUuid` `6db3b064-9156-45b6-9360-c36a4be59c8d`;
  `promptId` `c1b32610-8caf-45d9-804a-df50bbb08b6c`;
  `2026-07-21T21:59:18.738Z`; stored role `user`.

  ```text
  I think 20260721-v2-lives-top-level.md is the first thing
  20260721-agents-md-single-source.md is the second thing
  20260720-the-network-is-a-router.md is the third thing and that's about  it. I decide what goes in there.
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `696fce60df7e2567dd2af118b65e21df49d500ce`.
- Source gap — **No stored user event located** that states the ADR's complete list
  of removed machinery or its full attribute/order/deliver/record duty list.

<a id="20260721-agents-md-single-source"></a>

## AGENTS.md is the single source of agent instructions

[ADR](../decisions/20260721-agents-md-single-source.md)

- Source event — S1; UUID `bd4209f5-9cdc-4173-a6e6-d4b519d6b122`;
  `parentUuid` `7a3b0d83-8259-45e4-ba74-7aadcf703754`;
  `promptId` `025f3837-e880-4060-bb35-117f16aa83e8`;
  `2026-07-20T20:42:16.168Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  and CLAUDE.md and AGENTS.md should not be separate. All CLAUDE.md should just point to AGENTS.md
  [omitted: later source text]
  ```

- Source event — S1; UUID `ee36714a-0e0d-4561-a951-7b1f5a5b387c`;
  `parentUuid` `6db3b064-9156-45b6-9360-c36a4be59c8d`;
  `promptId` `c1b32610-8caf-45d9-804a-df50bbb08b6c`;
  `2026-07-21T21:59:18.738Z`; stored role `user`.

  ```text
  I think 20260721-v2-lives-top-level.md is the first thing
  20260721-agents-md-single-source.md is the second thing
  20260720-the-network-is-a-router.md is the third thing and that's about  it. I decide what goes in there.
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `696fce60df7e2567dd2af118b65e21df49d500ce`.
- Source gap — **No stored user event located** that states the nearest-file or
  package-specific extension mechanics recorded in the ADR.

<a id="20260721-native-principal-shaped-card"></a>

## The identity card is moltzap-native and principal-shaped

[ADR](../decisions/20260721-native-principal-shaped-card.md)

- Source event — S1; UUID `11cbac3e-ebec-48b4-92f2-4fb9c81cc5c3`;
  `parentUuid` `09cc78e0-6fa1-4e95-a904-c6200850692c`;
  `promptId` `4cdab1a4-4793-4883-9e2e-50131f2ca3b5`;
  `2026-07-21T22:54:12.263Z`; stored role `user`.

  ```text
  I looked at the AgentCard: I don't like it because it's not really principal shaped for personal agents. Reading through what we have right now and what the paper asks for what's the min version of our own AgentCard that we can create
  [omitted: nothing; full stored message]
  ```

- Source event — S1; UUID `024bb731-6d05-4560-a31f-7c58d6b28a3a`;
  `parentUuid` `61dbbff6-b284-4d52-b766-983f00141762`;
  `promptId` `513ff63c-058f-4c1d-ace0-6b43f43ebeab`;
  `2026-07-21T22:57:37.893Z`; stored role `user`.

  ```text
  lets use a branded / refined type for name? one question is key + issuedAt + signature? is that a lot? do crypto designs usually carry that?
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S1; UUID
  `d4fd08ac-d591-412b-8c66-c7ddf02b4b3c`; `parentUuid`
  `c67de57d-e370-4833-826d-5fce358e5e4b`;
  `requestId` `req_011CdG3eAPYvEzgg32mnECt2`;
  `message.id` `msg_011CdG3eFA3gkqsJQd3sTnnV`;
  `2026-07-21T23:10:14.561Z`; stored role `assistant`.

  ```text
  Done and pushed (`bc256184`). The card is now settled the way you called it — native shape, X.509 as the container beneath it:

  - **Normative text stays container-neutral:** the card binds agent, principal, name, verification key, and issue time, and is self-attributing (verifiable from published material, tamper- and substitution-evident). The Card fields table states each field's *binding* at guarantee level, plus the deliberately-absent list (service endpoints, capability flags, skills catalog, transport creds) so the minimalism reads as chosen.
  - **X.509 lives in Implementation notes as your decision,** with the fields→cert mapping spelled out: agent/principal as subject/SAN URIs (`moltzap://agent/<id>`, `moltzap://principal/<id>` — the SPIFFE pattern), verification key as subject public key, issued-at as `notBefore`, registry attestation as the issuer signature, and the one real friction handled — our no-expiry guarantee expressed through RFC 5280's own `notAfter = 99991231235959Z` convention rather than fighting the format.
  - **A2A and AGNTCY inverted to projections** — consume our card as content later (A2A via its extension slot, AGNTCY badges wrap arbitrary content), zero native dependency, watch-list only.
  - **`name` is branded/refined,** salvaged from v1's agent-name rule.

  One thing left to your gate: this is now two recorded decisions living only in the identity doc — *the card is principal-shaped and moltzap-native* and *X.509 is the container*. Whether either earns a `docs/decisions/` entry is your call (the log is maintainer-admitted). The identity/framing shape being self-standing here is exactly the "principal-shaped for personal agents" gap you spotted in A2A — the card now leads with the principal binding A2A can't express.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S1; UUID `95d0e577-d632-45fe-acb5-6886d569e31d`;
  `parentUuid` `895e844e-d9d6-4eb8-acd3-ed841ab3a04f`;
  `promptId` `41976273-a341-45c5-9029-52a2ecd2cc42`;
  `2026-07-21T23:11:13.474Z`; stored role `user`.

  ```text
  yes, go for them
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `39779bb712113f5e3469a2488becc2dd8b045517`.
- Source gap — **No stored user event located** in which the user independently
  states the projection rules or every recorded field exclusion.

<a id="20260721-physical-plane-split"></a>

## The planes split at the transport

[ADR](../decisions/20260721-physical-plane-split.md)

- Source event — S1; UUID `bbd19f99-6bd2-4194-9818-45ed785b42f4`;
  `parentUuid` `129ddb07-642a-4fb8-9528-e061cf5899e3`;
  `promptId` `0b8a5f71-0ad0-42d9-8869-a4a9e635e853`;
  `2026-07-21T22:08:07.119Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  3. tranport: should be linked back to the identity; I think the current protocol and the server are becoming the control plane rather than the data-plane.
  [omitted: intervening source text]
  4. network + leases + app + conversation + task
  [normalization: one trailing space removed]
  needs to be split from control into data plane separately; app layer needs to dissolve.
  [omitted: later source text]
  ```

- Source event — S3; UUID `6e420dbc-3b40-4570-af05-a7a7c5320b00`;
  `parentUuid` `95859917-29ae-4ad9-bd2a-30d4df7b2e38`;
  `requestId` `req_011CdJ1JLzkPiXVo24JtugRm`;
  `message.id` `msg_011CdJ1JNbVUvWa5EdWc3RAn`;
  `2026-07-23T00:00:48.515Z`; stored role `assistant`.

  ```text
  [omitted: earlier source text]
  `control-plane.md` claims every op is "exercisable with curl alone," but single-credential requires every request to carry a card-key signature over method/path/body — curl alone can't sign.
  [omitted: later source text]
  ```

- Source event — S3; UUID `fd141995-49eb-4aa8-95ad-cf42624fc02f`;
  `parentUuid` `9ccacf2d-d350-42cc-9e1c-90b0414c01f7`;
  `promptId` `ba19c65e-078c-4b22-ba8f-5e08d6617725`;
  `2026-07-23T00:17:48.561Z`; stored role `user`.

  ```text
  yes, the curl bit is false
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `efbd8aabb5e4d2826188f21c4fe0746e6bcb7b98`.
- Source gap — **No stored user event located** that states the ADR's exact physical
  boundary, HTTP mechanism, no-cross-plane rule, or recovery consequences.

<a id="20260721-sessionless-network"></a>

## The network is sessionless

[ADR](../decisions/20260721-sessionless-network.md)

- Source event — S2; UUID `d5563071-bafb-4b01-a872-f8092885849e`;
  `parentUuid` `25e24b41-4efb-4f61-829c-cb7b39b2015a`;
  `promptId` `11ddaa8a-a5e8-41e3-84c3-2ef866b38a9b`;
  `2026-07-22T02:13:41.240Z`; stored role `user`.

  ```text
  actually why is anything sessionfull. I want everything to be sessionless as much as possible.
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `efbd8aabb5e4d2826188f21c4fe0746e6bcb7b98`.
- Source gap — **No stored user event located** that separately states the recorded
  position-resumability, per-request version, or bounded-TTL consequences.

<a id="20260721-single-credential"></a>

## One credential: the card key authenticates everything

[ADR](../decisions/20260721-single-credential.md)

- Source event — S2; UUID `2068804d-4f58-4c87-a605-da87cf029cc7`;
  `parentUuid` `71a46b0e-afa4-47e8-8212-16ac5e7cf67e`;
  `requestId` `req_011CdGJDMmxasiddxdAhjYpW`;
  `message.id` `msg_011CdGJDQJmLuE541HKMFmjr`;
  `2026-07-22T02:21:39.913Z`; stored role `assistant`.

  ```text
  [omitted: earlier source text]
  authenticate requests by **proof-of-possession of the card key** (sign each request, HTTP Message Signatures style — per-request, so it stays sessionless; mTLS is the connection-level variant X.509 would also make trivial).
  [omitted: intervening source text]
  - One credential per identity; bearer keys never exist.
  [omitted: later source text]
  ```

- Source event — S2; UUID `65a54dfc-be77-42e9-947e-7c43d2c7a491`;
  `parentUuid` `23850e07-2e2a-4e06-952e-b941d9b17b53`;
  `promptId` `a006eea5-11e7-4a7d-8247-7ad9b69dc3e6`;
  `2026-07-22T02:24:27.107Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  This single credential design is the correct design, we should go for that.
  [omitted: later source text]
  ```

- Repository effect — the ADR was introduced by commit
  `efbd8aabb5e4d2826188f21c4fe0746e6bcb7b98`.
- Source gap — **No stored user event located** in which the user separately
  restates each detailed consequence recorded in the ADR.

<a id="20260721-v2-lives-top-level"></a>

## v2 code lives in a top-level `v2/*` workspace

[ADR](../decisions/20260721-v2-lives-top-level.md)

- Source event — S1; UUID `f1663c0b-d382-41cb-8314-55f99ec37196`;
  `parentUuid` `632916f6-71e3-41a6-b007-de10fbaa0acb`;
  `promptId` `0579caa0-8629-43b4-ab47-2d5f6561eb8e`;
  `2026-07-21T03:56:33.320Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I'm thinking this is wrong. Maybe we should just create v2 folders in
  [omitted: one source space and line break]
  every package instead.
  [omitted: later source text]
  ```

- Source event — S1; UUID `ee36714a-0e0d-4561-a951-7b1f5a5b387c`;
  `parentUuid` `6db3b064-9156-45b6-9360-c36a4be59c8d`;
  `promptId` `c1b32610-8caf-45d9-804a-df50bbb08b6c`;
  `2026-07-21T21:59:18.738Z`; stored role `user`.

  ```text
  I think 20260721-v2-lives-top-level.md is the first thing
  20260721-agents-md-single-source.md is the second thing
  20260720-the-network-is-a-router.md is the third thing and that's about  it. I decide what goes in there.
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `696fce60df7e2567dd2af118b65e21df49d500ce`.
- Source gap — **No stored user event located** that explains the reversal from the
  package-local proposal or states the exact layout, import, and branch
  mechanics.

<a id="20260721-x509-card-container"></a>

## X.509 is the identity card container

[ADR](../decisions/20260721-x509-card-container.md)

- Source event — S1; UUID `68e8a3e8-1842-4316-902c-9a1eb6b26ac9`;
  `parentUuid` `1ee25a5d-5dd9-4418-b19e-ed916054e51c`;
  `promptId` `9351f4fe-9eb4-4f49-b616-c9dd7f44c0d5`;
  `2026-07-21T23:07:22.084Z`; stored role `user`.

  ```text
  I want to use X.509. Like that's an implementation choice.
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S1; UUID
  `d4fd08ac-d591-412b-8c66-c7ddf02b4b3c`; `parentUuid`
  `c67de57d-e370-4833-826d-5fce358e5e4b`;
  `requestId` `req_011CdG3eAPYvEzgg32mnECt2`;
  `message.id` `msg_011CdG3eFA3gkqsJQd3sTnnV`;
  `2026-07-21T23:10:14.561Z`; stored role `assistant`.

  ```text
  Done and pushed (`bc256184`). The card is now settled the way you called it — native shape, X.509 as the container beneath it:

  - **Normative text stays container-neutral:** the card binds agent, principal, name, verification key, and issue time, and is self-attributing (verifiable from published material, tamper- and substitution-evident). The Card fields table states each field's *binding* at guarantee level, plus the deliberately-absent list (service endpoints, capability flags, skills catalog, transport creds) so the minimalism reads as chosen.
  - **X.509 lives in Implementation notes as your decision,** with the fields→cert mapping spelled out: agent/principal as subject/SAN URIs (`moltzap://agent/<id>`, `moltzap://principal/<id>` — the SPIFFE pattern), verification key as subject public key, issued-at as `notBefore`, registry attestation as the issuer signature, and the one real friction handled — our no-expiry guarantee expressed through RFC 5280's own `notAfter = 99991231235959Z` convention rather than fighting the format.
  - **A2A and AGNTCY inverted to projections** — consume our card as content later (A2A via its extension slot, AGNTCY badges wrap arbitrary content), zero native dependency, watch-list only.
  - **`name` is branded/refined,** salvaged from v1's agent-name rule.

  One thing left to your gate: this is now two recorded decisions living only in the identity doc — *the card is principal-shaped and moltzap-native* and *X.509 is the container*. Whether either earns a `docs/decisions/` entry is your call (the log is maintainer-admitted). The identity/framing shape being self-standing here is exactly the "principal-shaped for personal agents" gap you spotted in A2A — the card now leads with the principal binding A2A can't express.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S1; UUID `95d0e577-d632-45fe-acb5-6886d569e31d`;
  `parentUuid` `895e844e-d9d6-4eb8-acd3-ed841ab3a04f`;
  `promptId` `41976273-a341-45c5-9029-52a2ecd2cc42`;
  `2026-07-21T23:11:13.474Z`; stored role `user`.

  ```text
  yes, go for them
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `39779bb712113f5e3469a2488becc2dd8b045517`.
- Source gap — **No stored user event located** in which the user separately
  accepts the recorded RFC mappings or no-expiry representation.

<a id="20260722-control-plane-encoding"></a>

## Control-plane encoding: neutral spec, JSON-RPC interim, REST + OpenAPI target

[ADR](../decisions/20260722-control-plane-encoding.md)

- Source event — S2; UUID `65a54dfc-be77-42e9-947e-7c43d2c7a491`;
  `parentUuid` `23850e07-2e2a-4e06-952e-b941d9b17b53`;
  `promptId` `a006eea5-11e7-4a7d-8247-7ad9b69dc3e6`;
  `2026-07-22T02:24:27.107Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I'm also good / prefer to remove the JSON-RPC now for the control ops if they can be purely REST.
  [omitted: later source text]
  ```

- Source event — S3; UUID `28db3402-d85d-4123-a24e-2544b74ced77`;
  `parentUuid` `9cb748c3-815f-48fe-bac0-7add0bc8d2f7`;
  `promptId` `fe16ea6a-a844-475d-8328-8ac39544a242`;
  `2026-07-22T23:07:12.441Z`; stored role `user`.

  ```text
  For control plane: the wire (implementation, not the design) plan is to keep JSON-RPC and existing infrafor now; future can move towards a proper REST RPC + OpenAPI contracts that the CLI can integrate, instead of keeping a separate protocol package
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `4a641f822d98648bf896681f01fca008bfadf13d`.
- Source gap — **No stored user event located** that separately states every
  encoding-neutral, strict-decoding, or compatibility consequence in the ADR.

<a id="20260722-data-plane-layering"></a>

## Data-plane layering: atomic multicast, transactional collectives

[ADR](../decisions/20260722-data-plane-layering.md)

- Source event — S2; UUID `b9e0d789-a610-4755-83e2-8de413be4fa3`;
  `parentUuid` `7c188b12-b02c-45f3-b021-fb3d28c4b84a`;
  `promptId` `26ffa727-9114-4edb-93af-7f4ed763c572`;
  `2026-07-22T02:43:56.845Z`; stored role `user`.

  ```text
  okay you know what. Just rewrite the data plane behavior to say not defined yet.
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `92cea75a-356a-4fc6-8d66-467aca1eb403`;
  `parentUuid` `1948a788-258b-4be9-a91c-40746cdc1a8b`;
  `promptId` `995b229a-bfac-44fa-b89f-14878ebb9ae4`;
  `2026-07-23T02:28:48.989Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  the second layer is a network delivery layer that provides atomic multicast as a primitive
  [omitted: intervening source text]
  the third layer is the messaging layer: here, we have conversations which are basically like port numbers in a traditional network; we also have a transcript
  [omitted: intervening source text]
  we basically use the previous layer to implement collectives as transactions voer the transcript per conversation
  [omitted: later source text]
  ```

- Source event — S3; UUID `a17a3e01-4739-42f7-a5de-5feec0c29e65`;
  `parentUuid` `8e143ea9-3c68-417b-9ad0-5a908b36b292`;
  `promptId` `57c7bc86-c38c-410d-8dc4-f217f045a2d9`;
  `2026-07-23T03:13:36.233Z`; stored role `user`.

  ```text
  delivery is an id-bearing reverse-channel RPC fired fork-and-forget, not a strict JSON-RPC notification.? we should fix this? L3 should just have notifications and the reverse thing (e.g., acks) should be a separate network send call
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `60f2e33c-843e-40cb-861b-9ec070287a7d`;
  `parentUuid` `6cba7eb7-2cda-47df-bb51-6803a9695208`;
  `promptId` `ff98f4e7-15d7-4d31-b2c5-5060f2585311`;
  `2026-07-25T18:18:40.120Z`; stored role `user`.

  ```text
  A plain message is L2, nothign about L3.
  What the router checks on append: nothing. the router just delivers messages it does not handle appends to the chain. that's through the chain..like the begin / commit / etc., are handled by the endpoint to the chain, not by the router
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `1f8a9802-8212-4a33-8517-f9719b6d2443`;
  `parentUuid` `d3b61ab2-f19e-4f43-b83c-103ca788dfe1`;
  `promptId` `d87fd828-7bf7-457d-8137-d31aaf283ac6`;
  `2026-07-26T15:40:36.038Z`; stored role `user`.

  ```text
  actually maybe L2 is message, L3 is action. ALL_GATEHER is an action that requires multiple evnts. like to run that action requires a PROTOCOL
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `b333bdaade8196cf13132333bf7df265f651b27c`.
- Source gap — **No stored user event located** that states the ADR's exact
  all-or-none and ordering guarantees or its complete migration catalog.

<a id="20260722-spec-lives-on-main"></a>

## The spec set lives on main

[ADR](../decisions/20260722-spec-lives-on-main.md)

- Source event — S3; UUID `e8ce297e-5a99-4f37-96b0-4bb68b21d274`;
  `parentUuid` `fb53ce60-7ae1-435d-9631-47cec9bf04b6`;
  `promptId` `456bb049-cff2-4e6b-a89e-b93b58a3053f`;
  `2026-07-23T03:40:52.384Z`; stored role `user`.

  ```text
  change the doctrine; spec l;ives on main. catch up the wriitng backlog.do a few /simplify and /dogfood passses to check coldreader and then /ship this PR
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `b333bdaade8196cf13132333bf7df265f651b27c`.
- Source gap — **No stored user event located** that separately states the ADR's
  branch and review mechanics.

<a id="20260723-directory-serves-cards"></a>

## Directory read serves cards

[ADR](../decisions/20260723-directory-serves-cards.md)

- Source event — S3; UUID `a53cf9d7-7393-44d7-99e1-42fcd15b442b`;
  `parentUuid` `fecd3a26-90f4-4de6-95e9-ca2bc1b0e1d5`;
  `requestId` `req_011CdKiFN2x5vQkujERSzej8`;
  `message.id` `msg_011CdKiFRESFsqGxmtpQRxLo`;
  `2026-07-23T21:38:49.516Z`; stored role `assistant`.

  ```text
  [omitted: earlier source text]
  My recommendation: cards, full stop — the card is the directory entry.
  [omitted: later source text]
  ```

- Prompt for the terse reply below — S3; UUID
  `482ee4bc-ce2a-4ed1-a438-87df9c516ac1`; `parentUuid`
  `125dd9c7-cc16-4625-8871-65455d37db25`;
  `requestId` `req_011CdKvpJPjvANEsNHJz51sS`;
  `message.id` `msg_011CdKvpMyJRsJWY9gv9CTKs`;
  `2026-07-24T00:23:04.564Z`; stored role `assistant`.

  ```text
  (A5's commit landed cleanly — the branch now carries all three of today's records.)

  Waiting on your explicit call for **A2** (protocol `2026.723`, `moltzap-protocol` signed header, decoupled from package versions) and **A3** (directory read serves cards). Then I'll draft the v0-slice decision and the epic.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `b0e4293a-bdcc-4716-9651-9bd29b2ee809`;
  `parentUuid` `b506bceb-f54c-4173-bce4-047bedaf5dc0`;
  `promptId` `63c63fe9-bff9-4d10-9aab-ecf5d2a993ea`;
  `2026-07-24T00:23:24.808Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  - A3: yes, that's good for now
  ```

- Repository effect — the ADR was introduced by commit
  `d4d0c41cd083bb241ee9123f6b54234d9f2b3b3d`.
- Source gap — **No stored user event located** in which the user separately
  accepts the later cache and maximum-age consequences.

<a id="20260723-eight-layer-stack"></a>

## The eight-layer stack: communication layers under trust layers

[ADR](../decisions/20260723-eight-layer-stack.md)

- Source event — S3; UUID `37d50a9c-665c-482c-8fc8-7c9594f71b89`;
  `parentUuid` `2223be5f-dfae-43fc-8893-9da4c70bfd74`;
  `promptId` `47c6b2c2-47aa-4ef1-b2cd-2e7eaaa95da9`;
  `2026-07-23T19:06:03.093Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I think the data plane level one should just be, like, you know, um, like, you know, ordered multicast.
  [omitted: intervening source text]
  So, yeah, let's just call it messaging maybe.
  [omitted: intervening source text]
  messages are stored in a transcript.
  [omitted: intervening source text]
  the conversation ID is basically like a port number.
  [omitted: later source text]
  ```

- Source event — S3; UUID `014bc77f-9a30-48ba-bc32-3879f89c39aa`;
  `parentUuid` `71ba461a-fd7b-411b-89eb-dff4e4c8946e`;
  `promptId` `3481c98a-fc6b-4d90-a876-f27752e2eeb3`;
  `2026-07-23T19:12:44.316Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I think maybe maybe starvation freedom lies at the task there.
  [omitted: intervening source text]
  tasks are kind of the norms layer.
  [omitted: later source text]
  ```

- Source event — S3; UUID `1e80c8c3-9d3b-4375-9e02-18b8390fd4d9`;
  `parentUuid` `844dcebe-364a-44cb-bd46-e0f4cd6d6929`;
  `promptId` `1831266e-81ea-49de-b312-915283201899`;
  `2026-07-23T19:26:13.807Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I think we kind of talked about firewalls, and then oversight is kinda, like, monitors maybe.
  [omitted: intervening source text]
  And then institutional trust, then kind of governance is kind of okay.
  [omitted: later source text]
  ```

- Source event — S3; UUID `ef6b9581-0f2c-4b08-8731-26187a6602be`;
  `parentUuid` `1b29f2dd-690d-4e6e-8618-b8fc1a7be0de`;
  `promptId` `147f500e-8225-4297-aff7-89904c2c478f`;
  `2026-07-23T20:04:59.346Z`; stored role `user`.

  ```text
  I meant now look at the diffs and edit the two-stack harness now. One  thing I'd maybe do is: layer the trust stack over the communication stack, and basically like: guarantees flow up, configuration flows down? is that right?
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `890c562a-e1b0-408e-8672-189f359ebf8e`;
  `parentUuid` `9bb2da27-c56c-4d45-98c3-2a7f411fd71e`;
  `promptId` `a648582d-3b9c-4494-86c3-62e5298ee152`;
  `2026-07-23T20:10:05.170Z`; stored role `user`.

  ```text
  I'm also not sure if I want to have two separate C1-C4 and T1-T4; better to just have L1-L8
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `561aff6ad291de280d8f33697895c4754d8eaa0f`.
- Source gap — **No stored user event located** that states every exact guarantee,
  fault assumption, or propagation rule recorded in the ADR.

<a id="20260723-eval-plane-is-testbed"></a>

## The eval seam is a testbed data-plane implementation

[ADR](../decisions/20260723-eval-plane-is-testbed.md)

- Source event — S3; UUID `88a4d022-ded6-449d-bf4c-de72cfe43df2`;
  `parentUuid` `239e5a27-e771-402f-bd87-b652a538e413`;
  `promptId` `44ebff4e-4cf9-4aa9-9314-07d55accf4ac`;
  `2026-07-24T00:19:28.622Z`; stored role `user`.

  ```text
  I think we migrate that as an alternative data-plane impl for testing and evals but not requirement for the server; parallel effort will migrate it from core to testbed
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `d4d0c41cd083bb241ee9123f6b54234d9f2b3b3d`.
- Source gap — **No stored user event located** that separately states the ADR's
  same-guarantee, observation, and fault-injection requirements.

<a id="20260723-interim-signature-profile"></a>

## Interim request-signature profile: RFC 9421 with Ed25519

[ADR](../decisions/20260723-interim-signature-profile.md)

- Prompt for the terse reply below — S3; UUID
  `64df175d-e829-4f62-9bd4-074705437415`; `parentUuid`
  `34f93009-ddb5-4e5b-97d6-505909ccd766`;
  `requestId` `req_011CdKhMJD4jTU9qXgdTRcQh`;
  `message.id` `msg_011CdKhMM9v9juityYQ5punv`;
  `2026-07-23T21:26:41.346Z`; stored role `assistant`.

  ```text
  Good news: the record already binds the *shape* — "HTTP message-signature shape — method, path, body digest; the exact profile is key-model work." So A1 is filling in four blanks, plus the agent-id syntax that rides along. Here's each with my recommendation:

  **1. The standard: RFC 9421 (HTTP Message Signatures).** The record's phrasing — method, path, body digest — is describing RFC 9421 almost verbatim, so this is barely a choice. It's the IETF standard, it signs named components (`@method`, `@target-uri`, `Content-Digest`), carries `keyid`/`created`/`expires` parameters natively, and has usable TypeScript implementations (the Interledger/Open Payments ecosystem runs on it in production). The alternative — a bespoke sign-the-canonical-string scheme — is less work short-term and a compatibility dead end long-term. Boring parts boring: take the standard.
     - Proposed component set: `@method`, `@target-uri`, `content-digest` (required whenever a body exists), with `keyid`, `created`, `expires` as required signature parameters.

  **2. The algorithm: Ed25519.** Deterministic, no nonce-reuse footguns, small keys and signatures, first-class in RFC 9421's algorithm registry and in X.509 (RFC 8410), so the card is an Ed25519 SPKI certificate. Node has had it in crypto/WebCrypto for years. The only argument for P-256 is FIPS/HSM compatibility, which isn't a constraint you have. This choice also quietly serves the *target* binding — the same key later signs frames, and Ed25519 is what you want for high-volume frame signing.

  **3. The keyid: the agent id URI.** `keyid="moltzap://agent/<id>"` — verification is then exactly one registry lookup, and it matches the card's X.509 SAN URI form already decided. The operator key gets `moltzap://operator`, provisioned as deployment configuration per the record.

  **4. Replay bounds: `created`/`expires` with a short window.** Sessionless per-request auth needs freshness; require `expires − created ≤ 300s` and reject outside the window. No server-side nonce store (that would be session-shaped state); the transcript's immutability covers post-facto evidence, and a five-minute replay window on idempotent-or-refused ops is an acceptable interim posture — tightening it is register-5 work if ever needed.

  **5. The rider — agent-id syntax (what's inside `moltzap://agent/<id>`):** two real options.
     - **Opaque registry-minted id** (recommended): a branded string the registry mints — v1's salvaged branded-ID pattern, boring, and crucially *rotation-compatible*: the id survives a key change, which matters when register 5 eventually does rotation.
     - **Key-derived (self-certifying) id** — hash of the public key, libp2p-style. Elegant: the id-to-key binding verifies without trusting the registry, which would strengthen the L6 evidence story. But it welds the id to the key, making rotation a rename — exactly the corner register 5 shouldn't be pre-painted into. Worth recording as the key-model alternative, not taking now.

  Net: **RFC 9421 + Ed25519 + agent-id keyid + 300s window + opaque minted ids**, recorded as the interim profile in a small decision record (non-normative interim, same pattern as the encoding decision — superseded only by the register-5 key-model work).

  Your call — take the bundle as-is, or adjust any of the five? Then we move to A2 (protocol version field and value), which is a one-liner.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `9335233e-3b01-458e-ba5f-6097d6cbfaf8`;
  `parentUuid` `461801eb-7409-4dff-9816-106e98c03671`;
  `promptId` `ef274345-a520-4d6a-b41d-90aef27d7871`;
  `2026-07-23T21:27:47.481Z`; stored role `user`.

  ```text
  yes, I like this bundle
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `d4d0c41cd083bb241ee9123f6b54234d9f2b3b3d`.
- Source gap — **No stored user event located** that records separate user assent
  to the later nonce or freshness details.

<a id="20260723-lifecycle-rides-l3"></a>

## Conversation lifecycle rides in-band at L3

[ADR](../decisions/20260723-lifecycle-rides-l3.md)

- Source event — S3; UUID `e5f1a7b8-c490-4c27-8270-ad9a89ac04bc`;
  `parentUuid` `f4f8029a-b36d-4329-bf91-8982ba855d36`;
  `promptId` `50d3a848-ba5c-4e56-908d-39d079114e49`;
  `2026-07-24T00:05:08.055Z`; stored role `user`.

  ```text
  I think conversation create would become another type of L4 thing now like contacts? or maybe a special case on on L3 like a TCP connection initiation or termination? like basically the transcript holds it in escrow or something (following PCC?)
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S3; UUID
  `dfdeb2e3-cab6-4f05-9c4c-bb9f20ef86b2`; `parentUuid`
  `2c88162f-ddf3-4161-bdf8-c2f36cbbc039`;
  `requestId` `req_011CdKuTimk8GsRyTs1oc1H6`;
  `message.id` `msg_011CdKuU3uRjfUDR1RXTQFoa`;
  `2026-07-24T00:06:13.648Z`; stored role `assistant`.

  ```text
  Both — and the TCP analogy resolves *which part goes where*. It splits exactly like everything else in the stack has been splitting:

  **The mechanics are L3, and TCP is the right model.** In TCP, connection establishment isn't an API call to a connection registry — SYN and FIN are *in-band segments*; the connection comes into existence through the protocol's own first message. Map that over: **CONVERSATION-START is the genesis entry of the transcript itself.** A frame addressed to a fresh conversation id, whose admission creates the transcript with that frame as entry zero. No control-plane create op at all. This works because — like a SYN addressed to host:port rather than to an existing connection — the message doesn't need a conversation to ride in; it *is* the conversation's first record. Membership changes were already decided to be in-band ordered events; this just extends the same treatment to birth and death. The conversation "registry" then stops being an op surface and becomes an *index the store derives from lifecycle entries*.

  **Your escrow instinct is the half-open state.** SYN-RECEIVED, agentically: the START (with its invitee list) is durable in the transcript, but invitees haven't spoken. Each invitee's gate (L5) screens the invitation; acceptance is the invitee's *own in-band entry* — the SYN-ACK. Until then the conversation is half-open, and it expires by bounded timeout — which is precisely the one form of standing state the sessionless decision already blesses: "per-conversation coordination state, which expires by bounded timeout." The escrow isn't new machinery; it's the transcript being the handshake. And yes, it composes with PCC naturally — the genesis and the acceptances are just admitted writes.

  **The authority and meaning are L4, exactly like contacts.** *Which* creations are legitimate, what an invitation protocol looks like, introduction etiquette — task norms, published upward, screened at L5. So the plane-side answer to A4 gets even dumber than my recommendation: admission of a genesis entry checks attribution and id-freshness, **nothing else** — no authority check exists in the plane, because authority was never the plane's.

  Two consequences worth naming:

  1. **This flips part of control-plane.md.** The lifecycle op family (create / membership change / archive as control ops) dissolves into L3 message types; the first dogfood round actually flagged those dissolution-table rows as internally contradictory ("control" but "becomes in-band, transcript-ordered") — this resolves that tension the honest way. The control plane keeps identity ops and transcript *reads*; conversation ids become client-minted (UUID-class, collision-free by size — like QUIC connection IDs).
  2. **It answers charter cluster 9 in direction** — lifecycle rides as L3 message types — leaving the charter the details: escrow/half-open semantics, acceptance quorums, what ARCHIVE means to non-archivers.

  The one decision left inside this: **the v0 interim.** Option (a): record lifecycle-as-L3 as the design, but let v0 keep create-as-a-control-op as migration baseline (v1 salvage, same pattern as the WS wire). Option (b): v0 implements genesis entries directly — more new code, but it deletes the conversation-create op before it's ever built in v2, and the half-open/timeout machinery is roughly the lease machinery you're salvaging anyway. I lean (b): unlike the wire, there's no v1 investment worth carrying here — v1's create was app-authored and dies regardless.

  Record it that way — lifecycle as L3 genesis/in-band entries, escrow as half-open state under bounded timeout, authority at L4, screening at L5, v0 implements genesis entries directly?
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `a6023558-7338-42ae-944f-5380cf6ca9c7`;
  `parentUuid` `aa3f2d52-34e2-44fb-91c4-c44651f691e8`;
  `promptId` `cdf3f435-46e8-45e8-8ca8-b82e785db173`;
  `2026-07-24T00:10:18.705Z`; stored role `user`.

  ```text
  b
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `d4d0c41cd083bb241ee9123f6b54234d9f2b3b3d`.
- Source gap — **No stored user event located** in which the user separately
  states every lifecycle verb or archive consequence.

<a id="20260723-protocol-version-carriage"></a>

## Protocol version: the package version, carried per request

[ADR](../decisions/20260723-protocol-version-carriage.md)

- Prompt for the terse reply below — S3; UUID
  `af8d4974-d325-4bfe-a78e-056ae11252bc`; `parentUuid`
  `80b0ccff-682f-48a9-9a18-3058edbde097`;
  `requestId` `req_011CdKvuyiG8AqSxjC4HZ2EZ`;
  `message.id` `msg_011CdKvv2GnxvfFwap4daX8Y`;
  `2026-07-24T00:24:43.521Z`; stored role `assistant`.

  ```text
  Read it all — and you're right to make me look again, because the existing machinery is better than what I proposed. What actually exists:

  - **Minting is already automated and calendar-based**: `scripts/compute-next-version.sh` produces `YYYY.MDD.N` (month×100+day, N = same-day build counter), and publish.yml runs it *whenever a package's source changes on main*. Nobody hand-mints anything; no decision-record ceremony exists or is needed.
  - **Matching is already exact in practice**: the client sends `min = max =` its own bundled protocol version, so `checkProtocolRange` degenerates to point equality. The "range" is vestigial — v1 is already the exact-match world the constitution asks for.
  - **The comparator zero-fills**: [omitted: source comparator example containing version-shaped literals] — segment-wise numeric with missing segments as 0. My "two segments, no patch" invention was solving a non-problem; the third segment is a same-day build counter, not semver patch.

  So the corrected A2, which is mostly *keep the convention, change only the carriage*:

  - **Value:** the v2 protocol package's version — "the published package version is also the wire-protocol version" carries forward, minted by the existing pipeline. No standalone constant, no record-minted dates. This is clause 14 verbatim: a calendar date, matched simply, reusing the existing publish pipeline.
  - **Carriage (the only real change):** the `min`/`max` connect params die with connect; the version rides per-request as the `moltzap-protocol` header on control-plane requests — included in A1's signed components — and as the envelope's `protocol` field on frames. Exact match via the salvaged comparator.
  - **Accepted over-approximation, named honestly:** the version bumps on any protocol-package source change, not only wire changes — so a refactor-only publish forks old from new endpoints. That's conservative in the safe direction (refuses maybe-compatible, never accepts incompatible) and is today's behavior already. If independent endpoint upgrade cadence ever makes it too brittle, *that's* the future refinement — noted in the record, not solved now.

  That's the bundle. Yes on this, and I'll record A2 and A3 together, then draft the v0-slice decision.
  [omitted: comparator example marked inline; all other source text retained]
  ```

- Stored user reply — S3; UUID `b6009335-3c17-4896-96b4-f321dc0df4e0`;
  `parentUuid` `5344231c-fdf5-4a98-9763-dd5a5ba4abae`;
  `promptId` `7982b3af-a091-43f9-b53c-7718201bac2f`;
  `2026-07-24T00:25:58.396Z`; stored role `user`.

  ```text
  yes, that's fine for now
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `d4d0c41cd083bb241ee9123f6b54234d9f2b3b3d`.

<a id="20260724-collectives-are-ledger-transactions"></a>

## Collectives are ledger transactions, assembled by rounds over L2

[ADR](../decisions/20260724-collectives-are-ledger-transactions.md)

- Source event — S3; UUID `dc499600-1b70-49c2-b41d-415f78964260`;
  `parentUuid` `41fc88f3-9e0e-4158-b92d-568a2969e061`;
  `promptId` `6cdca3a5-0aa5-413c-ace3-5f056cc8295e`;
  `2026-07-24T18:03:32.693Z`; stored role `user`.

  ```text
  I think the point is that each collective should be implemented as a trasaction: so lets implement this in rounds properly?
  1. Leader (w/ turn initiates a collective)
  2. Everyone acks the collective (+ we don't need gossip here because ordered multicasts)
  3. Leader initiates the actual collective op
  4. everyone sends their things (again, it's uing ordered multicats), so everyone can compute the final result
  5. Leader gets everyone to sign the transaction before it's written on the ledger
  So the LEDGER is not in the critical path?
  [omitted: later source text]
  ```

- Source event — S3; UUID `f53a7857-51b1-47cc-baad-02b00c9676c6`;
  `parentUuid` `278129ad-f40b-4eab-b8c2-df623860acd7`;
  `promptId` `9d80647e-cb62-42d5-94fd-0eb7ef5b19b4`;
  `2026-07-24T18:09:19.715Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  I think the durable then deliver is wrong and should be fixed. It's just meant to be atomic.
  [omitted: later source text]
  ```

- Source event — S3; UUID `25da8d37-ce1c-4cf9-8386-a5efd03c96e2`;
  `parentUuid` `8cabbd85-6b26-4992-9b57-af384f2b7b3d`;
  `promptId` `bb474b11-e8d9-44cc-9d43-a703186b9051`;
  `2026-07-25T04:04:36.244Z`; stored role `user`.

  ```text
  no. I think begin | update | commit | abort are instead of append? like the Transcript shouldd give a database interface?
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `ee519211-5f11-4322-87fc-267d75ad2ff9`;
  `parentUuid` `61c30a79-cc6f-42d4-b9ae-5fb15cf2b1b5`;
  `promptId` `f2ef129a-ad7b-439f-96b8-46cb78f14388`;
  `2026-07-25T04:07:28.340Z`; stored role `user`.

  ```text
  I don't think youa are getting it. I was trying to propose that instead of simply append and read, transcript should enable PCC + database semantics, so someone first locks the next turn before actually starting to get the messages and all that..
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S3; UUID
  `417d3342-1778-4cb3-ae2d-a5c92c985a77`; `parentUuid`
  `2cd4014d-c8b7-4887-b977-b7c44c78b5df`;
  `requestId` `req_011CdN8kqN7jLcBkqcxeEM1p`;
  `message.id` `msg_011CdN8kt3LzU74QayNSRJq6`;
  `2026-07-25T04:20:45.163Z`; stored role `assistant`.

  ```text
  All clean and pushed — `5d7d9523` on PR #790, working tree clear. The branch now carries the complete arc through the pessimistic-database model. One open item on the table: your call on folding the correctness skeleton (grant-as-fold, txn-id-as-BEGIN-hash, bound updates, the SIGN digest, order-resolved supersession, restart-by-refold, txn-id dedup) into the collectives record and data-plane — or iterating the model further first.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `ac0a0dcf-223c-43ea-bc53-308660bdbde7`;
  `parentUuid` `add6d8ea-02ed-413a-9e2a-6e772dc93888`;
  `promptId` `4fc327ea-59ac-42cf-840a-4243ae52beba`;
  `2026-07-25T04:21:06.937Z`; stored role `user`.

  ```text
  yes, update all of this
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `47da7290-50b4-49fe-b1fc-334353480e9f`;
  `parentUuid` `fc43157d-4dce-462c-8b8f-7bc4867e9eb3`;
  `promptId` `4cdaf0ce-1113-4447-974e-975a65d96349`;
  `2026-07-25T18:14:10.571Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  Your log looks like a WAL. Mine is a blockhain.
  [omitted: intervening source text]
  all quorum management and stuff happens in-band and only then are things commited to the transaction store.
  [omitted: later source text]
  ```

- Source event — S3; UUID `003ce7e7-f81f-4737-9544-bae02f3e6546`;
  `parentUuid` `55822943-0a4a-43b9-a18a-f8fbc10058c3`;
  `promptId` `c253d90b-b3d0-4878-9956-f9398a5bf221`;
  `2026-07-26T15:55:55.259Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  We should actually fix this now. We have figured out how to implement all the collectives right? so this constraint no longer makes sense
  ```

- Repository effect — the ADR was introduced by commit
  `8198a4e4f0d9790a5b69481d90237b4fb52649b4`.
- Source gap — **No stored user event located** that states the complete later
  consequence set: embedded contributions, one transaction per conversation,
  holder-only abort, deciding-ack cut, sealed rounds, monotone
  quorum/unanimity, and every invalid-resolution rule.

<a id="20260724-firewall-starts-as-mcp-middleware"></a>

## The firewall starts as MCP middleware; screening logic is deferred

[ADR](../decisions/20260724-firewall-starts-as-mcp-middleware.md)

- Source event — S3; UUID `3844b1d6-60a7-4f3e-8b74-56ce6f30b719`;
  `parentUuid` `65fa0a04-726e-452a-a773-e732353144b0`;
  `promptId` `9941ff91-3320-4efe-9553-64f42c1e35e9`;
  `2026-07-25T04:47:26.578Z`; stored role `user`.

  ```text
  I think if everything is MCP, then we shouldbe trying to use existing MCP middleware / firewall / observability patterns?
  [omitted: nothing; full stored message]
  ```

- Source event — S3; UUID `392c126a-7415-4069-85f7-1f728206378c`;
  `parentUuid` `09137ac6-df49-4f9d-81a9-5804585fcd35`;
  `promptId` `8b2715c2-d6b9-4eb5-9a02-1a27ae78470c`;
  `2026-07-25T04:50:21.029Z`; stored role `user`.

  ```text
  yeah, look that recieving messages can also be MCP (see MCP triggers and events WG?) and their open progress.
  I think the point is you need to START by building the middleware interception capabilities; we defer the logic until we need it remember? you are early binding the shape beyond basic things like contacts and IAM that you might now
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `e8216e7844d02ba85f228444fca0f1eb702a697a`.
- Source gap — **No stored user event located** that separately states the exact v0
  logic or every three-proposal convergence detail recorded in the ADR.

<a id="20260724-firewall-two-directions"></a>

## The firewall is the agent's boundary: two directions, everything crosses

[ADR](../decisions/20260724-firewall-two-directions.md)

- Prompt for the terse reply below — S3; UUID
  `80fe41fe-f540-4f86-a6bb-df458df020b3`; `parentUuid`
  `cb7df151-cd7a-4643-99fc-0ff471771013`;
  `requestId` `req_011CdN3SGA1SfSZdLwPFE4W7`;
  `message.id` `msg_011CdN3SJfaAaDA98YVSmTKT`;
  `2026-07-25T03:11:35.331Z`; stored role `assistant`.

  ```text
  Yes — you're right, and your framing is better than mine. If the two hooks are defined by **direction across the agent's boundary** rather than by what kind of payload crosses, the third slot collapses:

  - **Hook 2 (leaving)** = everything the agent *does*: plain sends **and tool calls**. A tool call is just the agent acting — same direction, checked at the same gate, before anything compiles.
  - **Hook 1 (entering)** = everything reaching the agent's *attention*: peer messages **and tool results coming back from the bundle** — which neatly covers the "bundle is third-party code" worry, since tool-poisoned results are inbound content like any other untrusted input.

  My "third slot" was the special case; yours is the general mechanism. It also avoids slot inflation — tomorrow's new counterparty type doesn't get its own hook either; there's one boundary, two directions.

  Two things the collapse must keep, or the problems I flagged come back — both are one-sentence amendments to the existing two-slot text, not new slots:

  1. **Say explicitly that tool calls and tool results cross the hooks.** Otherwise read-only queries (which never become messages) silently bypass every promised guarantee.
  2. **One ordering law**: an illegal committing action is refused *before compilation begins* — so refusal happens at the intent, never by stranding a half-run round.

  So the recording is: keep two slots, generalized — "the firewall mounts on the agent's boundary, inbound and outbound; peer messages, tool calls, and tool results all cross it" — plus the pre-compilation refusal law. Shall I record it that way?
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `c59738ba-4816-466a-8385-c8f688d35f12`;
  `parentUuid` `3ec1a94b-906b-407b-b296-fda5f07c51d9`;
  `promptId` `b780d3ae-8f0f-4aba-a1a7-56e2c3ba0ad5`;
  `2026-07-25T03:11:35.582Z`; stored role `user`.

  ```text
  1+2 are the actual spec; 3 is the impl
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `df34df63b81767f132a0c1fcd158541dfc6a9e17`.

<a id="20260724-l7-is-policy-attached-to-identity"></a>

## L7 is institutional policy attached to identity

[ADR](../decisions/20260724-l7-is-policy-attached-to-identity.md)

- Source event — S3; UUID `7226502c-b0b3-4e5c-857e-83c7ed3fc799`;
  `parentUuid` `36cd85ca-4eef-4432-82d0-0fa2c1c02e62`;
  `promptId` `fa00de17-c8eb-4bd2-8165-657c11414035`;
  `2026-07-25T03:44:39.233Z`; stored role `user`.

  ```text
  I think L7 is maybe like IAM policies attached to the identity rather than true certificate revocation; it's kinda like in an institution, what are you allowed to do
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S3; UUID
  `50dbfb64-995d-4e6c-a12d-eb8957920e13`; `parentUuid`
  `58bb5c30-9975-4279-9f65-56a0e06489d8`;
  `requestId` `req_011CdN61YUBdeUTnE8eSokht`;
  `message.id` `msg_011CdN61bCtScdTQ1a721jSJ`;
  `2026-07-25T03:45:31.779Z`; stored role `assistant`.

  ```text
  That reframing is better than the revocation-centric one — and the corpus has been quietly assuming it already. Three places it's latent:

  - The L5 clause *already says* rules key off "institutional facts, **which L7 records at L1** for every layer to read" — institutional facts attached to the identity is IAM-policy-attached-to-identity, verbatim.
  - Clause 11 always said "revoking **or quarantining**" — quarantine never made sense as binary revocation; it's a *restricted policy*. Revocation is just the zero policy — the limit case, not the model.
  - Your own L6 call last hour — "setting up monitors can require credentials provided through L7" — only works if credentials are *entitlements* ("may operate a monitor," "may lead this norm," clause 12's "agents can become senators"), not existence bits.

  So the model becomes: **the directory entry is identity + attached institutional facts.** The card answers *who* (L1, immutable-ish, key binding); the facts answer *what are you allowed to do in this institution* (L7, mutable, versioned, attributed to the institution). Consequence machinery generalizes from "cease to vouch" to "change the policy" — and "L7 reconfigures L1" gains its full meaning: every layer reads the facts at L1, each enforcing its own slice.

  Two things this does **not** change, worth saying because they're load-bearing:

  1. **The router stays dumb.** The plane's admission floor is already exactly right: "sender exists **and is active**" — one institutional bit. Everything richer is read and enforced at *endpoints*: L5 firewalls key off the facts (recorded), L4 norms require credentials, L8 decides what policies say. IAM's "policy evaluated at every enforcement point" maps onto our architecture with the enforcement points being agents, not the network — clause 2 survives untouched.
  2. **The L7 research conclusion strengthens rather than changes.** A key directory generalizes cleanly to an identity+facts directory; KT-style transparency now matters *more*, because split-view **policies** are a sharper attack than split-view keys (show verifier A the permissive policy, verifier B the restrictive one). And the cache max-age correction we just recorded now covers policy freshness too — arguably its more important application. Bonus convergence: Cedar surfaced in the L5 research as the leading agent-authz policy language — the same vocabulary *family* could express institutional policy and firewall rules, with the crucial difference that the institution authors one and the agent authors the other. Same engine shelf, different sovereigns.

  What must stay open (not early-binding this time): the policy language itself, the fact vocabulary, and evaluation semantics — those are L8-adjacent and firewall-plan-adjacent; the model only fixes the *shape* — facts attached to the identity, served with the lookup, changed as the consequence mechanism, auditable through the same transparency story.

  Want me to record it? The record would be small: "L7 is institutional policy attached to identity" — directory entry = card + facts; consequences are policy changes with revocation as the limit case; the plane's floor stays existence/active; policy vocabulary and evaluation open. It would also retitle the enforcement.md consequence bullets and the clause-11 framing. Say the word.
  [omitted: nothing; full stored message]
  ```

- Immediate public prompt before the terse reply — S3; UUID
  `cdeb7a7c-23e1-4949-a57c-c4d8a74853f1`; `parentUuid`
  `8bd82fd9-8b6a-4250-b4bb-ff4466c74980`;
  `requestId` `req_011CdN66XK8BsNPSEECYxP2W`;
  `message.id` `msg_011CdN66aD12yDmuSbm6wgy5`;
  `2026-07-25T03:45:52.309Z`; stored role `assistant`.

  ```text
  The audit drift fixes landed clean and are pushed — `31596fb3` on PR #790. The corpus is now consistent end to end per the audit's checklist. Open with you: the L7-as-IAM-policy record from my last message (say the word and I'll write it), plus the three implementation-gate calls from the synthesis.
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `40f82e32-6bb5-47c6-8343-d03781cbad66`;
  `parentUuid` `6f7a6bcd-fc5e-4c4f-9e25-0721ec6da380`;
  `promptId` `991609cb-0dbb-4b96-b026-6fc8cfcc6f18`;
  `2026-07-25T03:48:22.534Z`; stored role `user`.

  ```text
  sure
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `dbf397c7e70fb9e54e2e65c54b9c225e940a74c7`.
- Source gap — **No stored user event located** in which the user separately
  accepts the cache, transparency, or active-bit details.

<a id="20260724-monitors-are-deterministic-contracts"></a>

## Monitors are deterministic contracts over the ledger; judgment is testimony

[ADR](../decisions/20260724-monitors-are-deterministic-contracts.md)

- Source event — S3; UUID `f0e949dc-d4b7-4609-b58a-16e8cf37cedf`;
  `parentUuid` `a1adaf28-e768-4ee1-97cc-57b5e964ce03`;
  `promptId` `d8d37995-6c8a-4b16-aec9-efce8be3b660`;
  `2026-07-25T02:38:05.032Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  For L6 I'm wondering if we can monitors are smart contracts over the transcript folds?
  [omitted: later source text]
  ```

- Source event — S3; UUID `e85e6aff-f5fa-4624-b6f9-47dbee486553`;
  `parentUuid` `20f8a935-4e0d-4a52-a1a6-b6805f850744`;
  `requestId` `req_011CdN47sHTnZ7T2GxVmHSTF`;
  `message.id` `msg_011CdN4827XYi9RgEcgkcsq4`;
  `2026-07-25T03:20:43.813Z`; stored role `assistant`.

  ```text
  [omitted: earlier source text]
     │ MONITOR = pinned deterministic program               │   layer 1: the CERTIFICATE
     │   finding = { monitor-hash, fold-lib-hash,           │   anyone re-executes over the
     │               chain-range, fired-pattern, refs }     │   same chain → identical bits
  [omitted: intervening source text]
     │ JUDGE = LLM/human evaluating the semantic residue    │   layer 2: TESTIMONY
  [omitted: later source text]
  ```

- Source event — S3; UUID `b40aac58-8384-4b6c-b4ce-5e3d73250641`;
  `parentUuid` `25a4b93f-d85f-4027-b8eb-3140e79b3051`;
  `promptId` `2d73f75d-eab9-4824-9ca6-fb3b4918cd85`;
  `2026-07-25T03:26:01.503Z`; stored role `user`.

  ```text
  I don't think so: i think setting up monitors should be a norm, and that can require credentials that are provided through L7. that's fine. the question is how would you impleemnt things. you are trying to early bind again?
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `0b47b0e2cf6164744816157b9f67b59717e6843e`.
- Source gap — **No stored user event located** that records user acceptance of
  the deterministic-certificate/testimony contract, its exact finding fields,
  or the fold-library trusted-computing-base consequence. The located stored
  user event addresses monitor setup and authority.

<a id="20260724-norms-are-mcp-skill-bundles"></a>

## Norms are MCP-served skill bundles (initial hypothesis)

[ADR](../decisions/20260724-norms-are-mcp-skill-bundles.md)

- Source event — S3; UUID `f0e949dc-d4b7-4609-b58a-16e8cf37cedf`;
  `parentUuid` `a1adaf28-e768-4ee1-97cc-57b5e964ce03`;
  `promptId` `d8d37995-6c8a-4b16-aec9-efce8be3b660`;
  `2026-07-25T02:38:05.032Z`; stored role `user`.

  ```text
  [omitted: earlier source text]
  each norm basically is an MCP server; tools are actions, and executing a tool compiles to some collective(s?) maybe?
  [omitted: intervening source text]
  Just do this research for now; DO NOT change anything in the docs yet until we discuss
  ```

- Source event — S3; UUID `60242bb1-f26f-4bef-831f-f2a414e3a448`;
  `parentUuid` `799a94a8-e635-4d79-8943-4e4e3aa5587c`;
  `promptId` `d6ead56a-d224-48b0-8bf6-6b37f75e8d59`;
  `2026-07-25T02:57:45.187Z`; stored role `user`.

  ```text
  yes, I'm fine to record L4 as initial hypotheisis; for now we can compute legal moves and prevent them using hooks but we don't have to change them from the prompts
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `22137ad88f207128969eb302b12297e8a1aaf968`.
- Source gap — **No stored user event located** that separately states every
  digest, citation, upstream, or placement detail recorded in the ADR.

<a id="20260726-attribution-binds-to-the-message"></a>

## Attribution binds to the message, not to the request

[ADR](../decisions/20260726-attribution-binds-to-the-message.md)

- Source event — S3; UUID `83aac32b-4938-4adb-b292-7cc52f266cb7`;
  `parentUuid` `5a418dce-e34b-4d9b-bf4c-628d195ea5b9`;
  `promptId` `f0aef46f-b08d-4a55-bf34-b42bbe6aa595`;
  `2026-07-26T20:05:13.220Z`; stored role `user`.

  ```text
  I think the coupling is wrong. we have L2 depending upon L1 not theother way  round
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S3; UUID
  `ed80c7a0-0c88-4548-b0fc-bf4df3bdbffe`; `parentUuid`
  `2ed76fbb-77cf-4e2e-adb6-084866fb7a11`;
  `requestId` `req_011CdRGbfh9CVoqfSmT9mQJe`;
  `message.id` `msg_011CdRGbjcnPePgmicRAS8du`;
  `2026-07-26T20:06:00.720Z`; stored role `assistant`.

  ```text
  You're right, and that's a sharper diagnosis than the one I was working from.

  The layering rule is that L2 depends on L1 — L2 delivers messages that L1 already attributed. But the interim binding makes attribution a property of *the request that carried it*, which means **L1's guarantee depends on L2's carriage shape**. Inverted. And that inversion is precisely why a transport question was landing on evidence and oversight — the symptom I kept describing without naming the cause.

  Seen that way, both of my options were wrong, because both accept the inversion and then argue about which carriage makes it least painful.

  **The fix is to sign the message, not the request.** Then L1 is self-contained: a message carries its own attribution, verifiable from the message and the card, and L2 may carry it however it likes — socket frames, HTTP, anything later. The carriage question doesn't get resolved; it stops existing.

  And the reason this was deferred doesn't survive scrutiny. Per-message signing was parked with the key model, I think out of a worry about canonicalization — but that worry applies to signing *structured* data, where two implementations must agree on key order and number formats. We already decided a message crosses as **one opaque byte string, byte-exact at every hop**. Signing opaque bytes has no canonicalization problem at all. So per-message signing is Ed25519 over the message bytes, signature alongside the signed part — simpler than RFC 9421, not harder.

  What it costs: the interim/target distinction mostly collapses, so a chunk of recorded interim machinery — the covered-components list, the freshness window, the retained request material, the `nonce` addendum I just recorded, the whole "recipients inherit the router's admission-time check" concession — becomes unnecessary rather than temporary. That's a real simplification, and it also restores the acceptance criterion the corpus keeps hedging: *a recipient verifies the sender from the message and the card alone, with no trust in the router*, true in round one rather than promised for later.

  What register item 5 would still own: rotation and revocation — the actual key model. Not "how does a signature bind to a message," which turns out to be trivial once messages are opaque bytes.

  Want me to record that — attribution binds to the message, the interim request-signing binding retires, and the carriage question closes with it?
  [omitted: nothing; full stored message]
  ```

- Stored user reply — S3; UUID `85715455-3cc2-4e3b-bcde-f324a0e9beca`;
  `parentUuid` `17e5cf93-8e81-4452-b98f-66ab9f51f9f6`;
  `promptId` `296ac55d-109f-4083-b9ff-3ce04abb5ad9`;
  `2026-07-26T20:06:40.826Z`; stored role `user`.

  ```text
  yes
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `10a672e891b970b90977e24a7dcf846f81f18333`.

<a id="20260726-the-engine-dispatches"></a>

## The engine dispatches to the harness after the grant

[ADR](../decisions/20260726-the-engine-dispatches.md)

- Source event — S3; UUID `6f2567ca-8265-47c2-a40f-86cafaa6a676`;
  `parentUuid` `38ad85f0-4cb0-4aec-87d4-6f7032f451f1`;
  `requestId` `req_011CdQzj5REaw4HrVxQB3e2g`;
  `message.id` `msg_011CdQzj8bUofp5Z2YuRQ7Zf`;
  `2026-07-26T16:37:57.318Z`; stored role `assistant`.

  ```text
  [omitted: earlier source text]
  the engine is autonomous; the firewall supplies the judgment; the agent supplies only content.
  [omitted: later source text]
  ```

- Source event — S3; UUID `7c345617-98a7-4ace-9192-f18cb99a568b`;
  `parentUuid` `26b5414a-f4ec-4cc3-9e6c-11baa79e65ce`;
  `promptId` `da107b1d-27e1-4456-8751-e87082c5f093`;
  `2026-07-26T16:42:27.924Z`; stored role `user`.

  ```text
  it's almost like LLM dispatch what we are calling it right now
  [omitted: nothing; full stored message]
  ```

- Prompt for the terse reply below — S3; UUID
  `9347ddea-4c1f-48e2-8793-bd0c16d7d5bd`; `parentUuid`
  `c739b982-c3ca-4eee-823f-07fcf3638941`;
  `requestId` `req_011CdR18jpSGJNdSiFxtHU6L`;
  `message.id` `msg_011CdR18yGZcGePkYKfpPkeg`;
  `2026-07-26T16:43:02.463Z`; stored role `assistant`.

  ````text
  Yes — and it's already the corpus's word. The paper's PCC sentence is literally about dispatch: *"the harness **dispatches an LLM request** only after the group reaches consensus on the next collective operation and the next speaker."* And control-plane.md's dissolution table says v1's `agent/dispatch/request` dies with "the pessimistic-concurrency role is reborn as **L3 consensus dispatch**."

  So the verb isn't the agent calling in — it's the engine calling out, and the direction inverts:

  ```
    intent      the agent wants a turn (or a protocol needs its part)
       │
       ▼
    grant       the group agrees it speaks next
       │
       ▼
    DISPATCH    the engine invokes the harness — this is the moment the LLM runs
       │
       ▼
    content     the harness returns what was generated
       │
       ▼
    commit      the engine carries it into the protocol and records the action
  ```

  That's the whole reason PCC exists, stated as an interface: **dispatch happens only after the grant.** Generating is the irreversible act, so the grant gates the dispatch, not the send.

  Three things fall out:

  - **No `speak`, no `contribute`, no participant verb at all.** The plugin doesn't call the channel to produce content; the engine calls the plugin. `Harness` becomes dispatch-shaped — the engine hands it a request, it returns a body. Inversion of control, which is also why "plugins are pure consumers" was always the right instinct: they respond, they don't drive.
  - **Initiating and participating stop being different cases.** An agent wanting to say something unprompted still shouldn't generate before its turn — so it signals intent, gets granted, and *then* gets dispatched. Same path as contributing to someone else's collective. One flow, no special case.
  - **"Observe admission before generating" gets a mechanism.** It was a discipline nobody could point at; now it's structural — the engine simply has no reason to dispatch before it holds the grant, and the harness has no way to generate unbidden.

  It also lands the v1 salvage cleanly: v1's dispatch leases and dispatch-authorize hooks dissolve into exactly this — the grant is the dispatch permission, and the authorization that used to be a network-side hook is now the endpoint's own firewall screening what the engine emits.

  Record it as: the engine dispatches to the harness after the grant; the harness SPI is dispatch-shaped; there is no participant-side verb?
  [omitted: nothing; full stored message]
  ````

- Stored user reply — S3; UUID `39df3d09-cd38-4b60-b578-0ca7c7031680`;
  `parentUuid` `f0f21a54-5416-4960-90f0-fba565ee8022`;
  `promptId` `fe5a07a0-8cd5-4448-a907-df21d9b3c7a4`;
  `2026-07-26T16:44:20.114Z`; stored role `user`.

  ```text
  yes
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `d632a1f2b0458383a62a08f5ec137805de184a94`.

<a id="20260727-registration-is-out-of-band"></a>

## Registration is out of band; the plane knows one caller

[ADR](../decisions/20260727-registration-is-out-of-band.md)

- Source event — S3; UUID `4a076f50-b905-4e37-b1b6-57e99e5ef17c`;
  `parentUuid` `103d514d-3c66-4bab-bf1b-fadd06dc9bd8`;
  `promptId` `93701018-9c22-4095-a440-c19bc50ddedc`;
  `2026-07-27T23:44:23.573Z`; stored role `user`.

  ```text
  I think there is something major wrong here. CLI is for the agent. not the operator. Nothing in this arch is for the operator
  [omitted: nothing; full stored message]
  ```

- Structured prompt event for the selection below — S3; UUID
  `757d2b45-63ce-48ff-900d-bc1917e7b446`; `parentUuid`
  `4780bef0-1cb1-48ea-9187-9b889759394d`;
  `requestId` `req_011CdTTL6Xxrgm3psnXFSCnv`;
  `message.id` `msg_011CdTTL8Q5YCATa5zMeoFqA`;
  `2026-07-27T23:47:44.807Z`; stored role `assistant`.

  The stored `message.content[0]` object follows. JSON whitespace is added
  only for display; no fields from that object are omitted.

  ```json
  {
    "type": "tool_use",
    "id": "toolu_011qNAQRjMsatj8X73gL3uLf",
    "name": "AskUserQuestion",
    "input": {
      "questions": [
        {
          "question": "\"Nothing in this arch is for the operator\" — does that reframe the CLI only, or does it also dissolve the operator caller arm?",
          "header": "Operator arm",
          "multiSelect": false,
          "options": [
            {
              "label": "Reframe only; keep the gate (Recommended)",
              "description": "The CLI becomes the agent's control-plane client throughout. `register` stays operator-gated as a deployment bootstrap fact, `Caller` keeps its two arms, and law L7.1 stands. Fixes the six files above with no law change and no new register item. This is the reading your evidence directly supports: the framing was wrong, the admission gate is real."
            },
            {
              "label": "Dissolve it — one caller class",
              "description": "Registration becomes agent-driven too (invite-based, or an existing identity vouches), the operator arm disappears, and the plane knows exactly one caller class: agents. Changes law L7.1 and control-plane invariant 7, and needs a decision record. `cli.md` open question 2 already gestures at this, and the v1 invite-gated registration route is a recorded carry-forward candidate."
            },
            {
              "label": "Reframe now, register stays open",
              "description": "Do the CLI reframe immediately, and register the operator-arm question as an open question rather than answering it either way — consistent with \"questions stay questions\" if you don't yet have evidence for dissolving the gate. Slower to converge, but binds nothing prematurely."
            }
          ]
        }
      ]
    },
    "caller": {
      "type": "direct"
    }
  }
  ```

- Stored user selection — S3; UUID `05e9747b-67b0-42cd-8ff8-9fa1fbe5d43f`;
  `parentUuid` `757d2b45-63ce-48ff-900d-bc1917e7b446`;
  `promptId` `93701018-9c22-4095-a440-c19bc50ddedc`;
  `2026-07-27T23:48:48.286Z`; stored role `user`.

  ```text
  Your questions have been answered: ""Nothing in this arch is for the operator" — does that reframe the CLI only, or does it also dissolve the operator caller arm?"="Dissolve it — one caller class". You can now continue with these answers in mind.
  [omitted: nothing; full stored answer]
  ```

- Source event — S3; UUID `f891a119-fca9-41e8-9868-77fcf91223cc`;
  `parentUuid` `2bdba072-664b-4165-a534-dccb6c29bf4c`;
  `requestId` `req_011CdTTX6x5AUesAaYN9e5WJ`;
  `message.id` `msg_011CdTTX983os9FuGVa1kSC7`;
  `2026-07-27T23:50:28.852Z`; stored role `assistant`.

  ```text
  Registration out of band is the cleaner cut — with no operator-gated op left, there's no admission-fact machinery to design either. Let me see VISION clause 3.
  [omitted: nothing; full stored message]
  ```

- Repository effect — the ADR was introduced by commit
  `40b236d771b216b9e6e117e536e74947e2efce8d`.
- Source gap — **No stored user event located** in which the user selects
  out-of-band registration, removal of admission facts, a read-only Registry,
  or removal of the operator key. The located stored user selection says
  registration becomes agent-driven and selects “Dissolve it — one caller
  class.”
