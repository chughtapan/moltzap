`@moltzap/identity` exports `SealedBody`, which encrypts a SignedMessage body
to its recipients' AgentCard keys and opens a verified sealed body. Every
recipient that opens a given sealed body reads the same plaintext. The body
names its sender and the MessageId of the SignedMessage that carries it, so
a member cannot present another member's sealed bytes under its own
signature, and the sealed bytes do not open under any other MessageId; a
retry that resends the stored SignedMessage opens. A
recipient that reads a body can still seal the same plaintext again as its
own. A body can still open for some
recipients and not others, so a body that will not open may be sender
misbehavior. Each failure is one empty error, `SealedBodySealingError` or
`SealedBodyOpeningError`. `SealedBody.sealedByteLength` and
`SealedBody.maximumPlaintextByteLength` report the exact sealed size; at 32
recipients the largest plaintext is 192,180 bytes.
