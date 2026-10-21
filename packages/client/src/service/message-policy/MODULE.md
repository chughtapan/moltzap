# client/service/message-policy

_`packages/client/src/service/message-policy`_

## Purpose

The message-policy document `sharnessd` reads and the firewall it builds from one.

## Public surface

### [`decodeMessagePolicy`](./policy.ts#L154)

_Variable_

```ts
export const decodeMessagePolicy = Schema.decodeUnknown(
  Schema.parseJson(MessagePolicy),
  { onExcessProperty: "error" },
)
```

Decodes the text of a message-policy document, refusing any property it
does not name, so a misspelled or newer setting never silently weakens the
policy.

### [`MessagePolicy`](./policy.ts#L145)

_TypeAlias_

```ts
export type MessagePolicy = typeof MessagePolicy.Type;
```

One decoded message-policy document, with Client's defaults filled in.

### [`MessagePolicy`](./policy.ts#L133)

_Variable_

```ts
export const MessagePolicy = document.pipe(
  Schema.filter(
    (policy) =>
      policy.decisionProvider !== undefined || !needsDecisionProvider(policy),
    {
      message: () =>
        "decisionProvider is required for English rules and the collective norms",
    },
  ),
)
```

The message policy of one daemon: its firewall mode, the built-in code
middleware of each direction in chain order, its fixed and initial
editable English rules, the decision provider those rules and the
collective norms need, and the check bounds. Absent settings take Client's
defaults. English rules or the collective norms without a decision provider
are refused.

### [`messagePolicyFirewall`](./compose.ts#L46)

_Variable_

```ts
export const messagePolicyFirewall = Effect.fn("messagePolicyFirewall")(
  function* (
    policy: MessagePolicy,
    provider: DecisionProvider,
  ): Effect.fn.Return<FirewallOptions, CheckInputError> {
    const bundle = yield* Effect.cached(
      collectiveNorms(provider, policy.englishSettings),
    );
    return {
      mode: policy.mode,
      incoming: yield* Effect.forEach(
        policy.incoming,
        (entry) => incoming(entry, bundle),
        { concurrency: 1 },
      ),
      outgoing: yield* Effect.forEach(
        policy.outgoing,
        (entry) => outgoing(entry, bundle),
        { concurrency: 1 },
      ),
      settings: policy.settings,
      facts: policy.facts,
      codeDigest: createHash("sha256")
        .update(JSON.stringify({ client: packageVersion, policy }))
        .digest("hex"),
      maximumHistoryRecords: policy.maximumHistoryRecords,
      maximumConcurrentChecks: policy.maximumConcurrentChecks,
      english:
        policy.english === undefined
          ? undefined
          : {
              fixedRules: policy.english.fixedRules,
              initialRules: policy.english.initialRules,
              provider,
              settings: policy.englishSettings,
            },
    };
  },
)
```

The firewall installation of one message-policy document: its built-in
middleware in chain order, its English rules assessed by `provider`, and
its settings. `codeDigest` identifies the document and the Client release
that interprets it.

### [`messagePolicyFormat`](./policy.ts#L13)

_Variable_

```ts
export const messagePolicyFormat = "org.social-harness/message-policy/v1"
```

The `format` every message-policy document names.

## Files

- `compose.ts`
- `policy.ts`
