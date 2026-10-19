/** @file Serialized owner edits replace immutable chains without replacing daemon resources. */

import { Clock, Effect, Schema } from "effect";
import type { InstalledFirewall } from "./firewall-checks.js";
import {
  decodeFrozen,
  EnglishPolicySettings,
  EnglishRule,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  makeEnglishPolicy,
  policyReadSchema,
  policyUpdateSchema,
  PrivateCheckTrace,
} from "../firewall/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  type FirewallActivation,
  type FirewallAuditEntry,
} from "../store/index.js";
import { decodeFirewallAuditEntry } from "./firewall-values.js";
import {
  captureRegistration,
  type FirewallOptions,
  installFirewall,
} from "./firewall.js";

const editableRules = policyReadSchema.fields.rules.pipe(Schema.maxItems(256));
const englishId = "moltzap.english";

const persistenceFailure = () =>
  new FirewallPolicyError({ reason: "persistence-failed" });
const invalidRule = () => new FirewallPolicyError({ reason: "invalid-rule" });

const captureEnglish = Effect.fn("captureEnglishOptions")(function* (
  english: FirewallOptions["english"],
) {
  if (english === undefined) {
    return undefined;
  }
  const fixedRules = yield* decodeFrozen(
    Schema.Array(EnglishRule),
    english.fixedRules ?? [],
  );
  const initialRules = yield* decodeFrozen(
    editableRules,
    english.initialRules ?? [],
  );
  const settings = yield* decodeFrozen(EnglishPolicySettings, english.settings);
  const provenance =
    english.provider.provenance === undefined
      ? undefined
      : yield* decodeFrozen(PrivateCheckTrace, english.provider.provenance);
  return {
    fixedRules,
    initialRules,
    settings,
    provider: {
      decide: english.provider.decide.bind(english.provider),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
});

/** Fixed code and provider identity are captured once, before any owner operation can run. */
const captureOptions = Effect.fn("capturePolicyOptions")(function* (
  options: FirewallOptions,
) {
  const incoming = yield* Effect.forEach(
    options.incoming,
    captureRegistration,
    { concurrency: 1 },
  );
  const outgoing = yield* Effect.forEach(
    options.outgoing,
    captureRegistration,
    { concurrency: 1 },
  );
  const base = yield* installFirewall({ ...options, incoming, outgoing });
  return {
    base,
    fixed: {
      ...base.configuration,
      settings: base.metadata.settings,
      incoming,
      outgoing,
    },
    english: yield* captureEnglish(options.english),
  };
});

type CapturedOptions = Effect.Effect.Success<ReturnType<typeof captureOptions>>;

/** Build failures, including trusted factory defects, leave the active reference untouched. */
function buildPolicy(options: CapturedOptions, rules: readonly EnglishRule[]) {
  return Effect.gen(function* () {
    const documents = [...(options.english?.fixedRules ?? []), ...rules];
    if (documents.length === 0) {
      return options.base;
    }
    if (options.english === undefined) {
      return yield* new FirewallPolicyError({ reason: "not-configured" });
    }
    const english = yield* makeEnglishPolicy({
      id: englishId,
      rules: documents,
      provider: options.english.provider,
      settings: options.english.settings,
    });
    return yield* installFirewall({
      ...options.fixed,
      incoming: [...options.fixed.incoming, english],
      outgoing: [...options.fixed.outgoing, english],
    });
  }).pipe(
    Effect.catchTag("CheckInputError", () =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
    Effect.catchAllDefect(() =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
  );
}

function fixedIds(options: CapturedOptions): readonly string[] {
  return [
    ...new Set([
      ...options.fixed.incoming.flatMap((middleware) =>
        middleware.rules.map((rule) => rule.id),
      ),
      ...options.fixed.outgoing.flatMap((middleware) =>
        middleware.rules.map((rule) => rule.id),
      ),
      ...(options.english?.fixedRules.map((rule) => rule.id) ?? []),
    ]),
  ];
}

function validateIds(
  rules: readonly EnglishRule[],
  fixedRuleIds: readonly string[],
) {
  if (rules.some((rule) => fixedRuleIds.includes(rule.id))) {
    return Effect.fail(new FirewallPolicyError({ reason: "fixed-rule" }));
  }
  return new Set(rules.map((rule) => rule.id)).size === rules.length
    ? Effect.void
    : Effect.fail(invalidRule());
}

interface PolicyState {
  rules: typeof editableRules.Type;
  readonly fixedRuleIds: readonly string[];
  active: InstalledFirewall;
}

/** Persist-before-swap is uninterruptible; cancellation cannot split desired and active state. */
export const installEditableFirewall = Effect.fn("installEditableFirewall")(
  function* (options: FirewallOptions, store: EndpointStore) {
    const captured = yield* captureOptions(options).pipe(
      Effect.catchTags({
        CheckInputError: () =>
          Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
        ParseError: () =>
          Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
      }),
    );
    const fixedRuleIds = fixedIds(captured);
    const stored = yield* store
      .readFirewallPolicy()
      .pipe(Effect.mapError(persistenceFailure));
    const rules =
      stored === undefined
        ? (captured.english?.initialRules ?? [])
        : yield* decodeRuntimeValue(editableRules, stored).pipe(
            Effect.mapError(persistenceFailure),
          );
    yield* validateIds(rules, fixedRuleIds);
    const active = yield* buildPolicy(captured, rules);
    const state: PolicyState = { rules, active, fixedRuleIds };
    if (stored === undefined) {
      yield* persistRules(store, rules);
    }
    const gate = yield* Effect.makeSemaphore(1);
    const policy: FirewallPolicyOperations = {
      read: () =>
        Effect.sync(() => ({
          rules: state.rules,
          fixedRuleIds,
          activeRevision: state.active.configurationDigest,
        })),
      update: (request) =>
        gate.withPermits(1)(updatePolicy(captured, store, state, request)),
      decisions: (request) => readDecisions(store, request),
    };
    return Object.freeze({
      ...active,
      permits: captured.base.permits,
      current: () => state.active,
      policy,
    }) satisfies InstalledFirewall;
  },
);

function persistRules(
  store: EndpointStore,
  rules: readonly EnglishRule[],
  activation?: FirewallActivation,
) {
  return encodeRuntimeValue(rules).pipe(
    Effect.flatMap((bytes) => store.writeFirewallPolicy(bytes, activation)),
    Effect.mapError(persistenceFailure),
  );
}

function editedRules(
  rules: readonly EnglishRule[],
  fixedRuleIds: readonly string[],
  request: typeof policyUpdateSchema.Type,
) {
  return Effect.gen(function* () {
    const remove = request.remove ?? [];
    if (remove.some((id) => fixedRuleIds.includes(id))) {
      return yield* new FirewallPolicyError({ reason: "fixed-rule" });
    }
    if (remove.some((id) => !rules.some((rule) => rule.id === id))) {
      return yield* invalidRule();
    }
    const next = yield* decodeFrozen(editableRules, [
      ...rules.filter((rule) => !remove.includes(rule.id)),
      ...(request.add ?? []),
    ]).pipe(Effect.mapError(invalidRule));
    yield* validateIds(next, fixedRuleIds);
    return next;
  });
}

function updatePolicy(
  captured: CapturedOptions,
  store: EndpointStore,
  state: PolicyState,
  request: typeof policyUpdateSchema.Type,
) {
  return Effect.gen(function* () {
    const change = yield* decodeFrozen(policyUpdateSchema, request).pipe(
      Effect.mapError(invalidRule),
    );
    const next = yield* editedRules(state.rules, state.fixedRuleIds, change);
    const replacement = yield* buildPolicy(captured, next);
    return yield* Effect.uninterruptible(
      persistRules(store, next, {
        time: yield* Clock.currentTimeMillis,
        activeRevision: replacement.configurationDigest,
        addedRuleIds: (change.add ?? []).map((rule) => rule.id),
        removedRuleIds: change.remove ?? [],
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            state.active = replacement;
            state.rules = next;
            return {
              activeRevision: replacement.configurationDigest,
              retroactive: false as const,
            };
          }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("updateFirewallPolicy"));
}

/** Explicit projection prevents private input, diagnostics and registered text escaping through this feed. */
function readDecisions(
  store: EndpointStore,
  request: { readonly since?: number },
) {
  return Effect.gen(function* () {
    const entries = yield* store.readFirewallDecisions(request.since);
    const rows = yield* Effect.forEach(entries, decisionRows, {
      concurrency: 1,
    });
    return yield* Schema.decodeUnknown(firewallDecisionsSchema)({
      decisions: rows.flat(),
      activations: (yield* store.readFirewallActivations(request)).map(
        (entry) => entry.activation,
      ),
    });
  }).pipe(Effect.mapError(persistenceFailure));
}

function decisionRows(entry: FirewallAuditEntry & { readonly time: number }) {
  return decodeFirewallAuditEntry(entry).pipe(
    Effect.map((check) => projectDecision(check, entry.time)),
  );
}

type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;

function projectDecision(check: DecodedCheck, time: number) {
  const result = check.result;
  if (
    result === null ||
    check.disposition === "checking" ||
    check.disposition === "interrupted"
  ) {
    return [];
  }
  const message = check.input.message;
  const peers =
    message === null ? [null] : decisionPeers(message, check.direction);
  const ruleIds = [
    ...new Set(
      result.checks.flatMap((middleware) =>
        middleware.findings.map((finding) => finding.ruleId),
      ),
    ),
  ];
  return peers.map((peerAgentId) => ({
    checkId: check.checkId,
    time,
    direction: check.direction,
    peerAgentId,
    outcome: result.judgment,
    disposition: check.disposition,
    ruleIds,
    activeRevision: check.input.configurationDigest,
  }));
}

/**
 * The agents a check's decision rows name: each recipient of an outgoing
 * message, the verified author of an incoming one, and no agent for a result
 * or failure, whose text is the endpoint's own.
 */
function decisionPeers(
  message: NonNullable<DecodedCheck["input"]["message"]>,
  direction: "incoming" | "outgoing",
): ReadonlyArray<string | null> {
  if (direction === "outgoing") {
    return message.recipients;
  }
  const kind = message.operation?.kind;
  return kind === "result" || kind === "failure" ? [null] : [message.sender];
}
