/** @file Builds the daemon firewall a message-policy document describes. */

import { Effect, Option } from "effect";
import { createHash } from "node:crypto";
import type { FirewallOptions } from "../../delivery/index.js";
import type {
  CheckInputError,
  DecisionProvider,
  MessageMiddleware,
} from "../../firewall/index.js";
import type {
  DaemonConfigurationError,
  DaemonProcessConfiguration,
} from "../bootstrap.js";
import type {
  IncomingMiddlewareEntry,
  MessagePolicy,
  OutgoingMiddlewareEntry,
} from "./policy.js";
import { packageVersion } from "../../endpoint/implementation.js";
import {
  acknowledgementsPolicy,
  allowedSendersPolicy,
  credentialsPolicy,
  plainLanguagePolicy,
} from "./builtin.js";
import { type CollectiveNorms, collectiveNorms } from "./collective-norms.js";
import { loadMessagePolicy, policyConfigurationError } from "./load.js";

/** The firewall a daemon installs, if any, and where its audit goes. */
export interface FirewallInstallation {
  readonly options?: FirewallOptions;
  readonly auditExport?: string;
}

/**
 * The firewall installation of one message-policy document: its built-in
 * middleware in chain order, its English rules assessed by `provider`, and
 * its settings. `codeDigest` identifies the document and the Client release
 * that interprets it.
 * @param policy The decoded document.
 * @param provider The service that assesses its English rules and the
 *     collective norms; unused when the document installs neither.
 * @returns The options `Daemon.withFirewall` installs.
 */
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
);

/**
 * The firewall a composition installs, or else the one the environment's
 * message-policy file describes, which is logged with its registrations. A
 * composition with its own firewall refuses that file.
 * @param configuration The daemon's loaded process configuration.
 * @param composed The firewall the composition installs itself, if any.
 * @returns What the daemon installs; neither field is set without a firewall.
 */
export const firewallInstallation = (
  configuration: DaemonProcessConfiguration,
  composed?: FirewallInstallation,
): Effect.Effect<FirewallInstallation, DaemonConfigurationError> =>
  loadMessagePolicy(configuration).pipe(
    Effect.flatMap((configured) =>
      Option.match(configured, {
        onNone: () => Effect.succeed(composed ?? {}),
        onSome: ({ policy, provider, auditExport }) =>
          composed === undefined
            ? messagePolicyFirewall(policy, provider).pipe(
                Effect.mapError(() =>
                  policyConfigurationError("message-policy"),
                ),
                Effect.tap(logInstalled),
                Effect.map((options) => ({ options, auditExport })),
              )
            : Effect.fail(policyConfigurationError("message-policy-composed")),
      }),
    ),
  );

function logInstalled(options: FirewallOptions) {
  const registrations = new Set(
    [...options.incoming, ...options.outgoing].map(
      (entry) => `${entry.id} at ${entry.revision}`,
    ),
  );
  const middleware =
    registrations.size === 0
      ? "no code middleware"
      : [...registrations].join(", ");
  const english = options.english === undefined ? "" : " and English rules";
  return Effect.logInfo(
    `Message policy installed in ${options.mode} mode with ${middleware}${english}.`,
  );
}

/** The bundle, built once for the first entry that names it. */
type Bundle = Effect.Effect<CollectiveNorms, CheckInputError>;

function incoming(
  entry: IncomingMiddlewareEntry,
  bundle: Bundle,
): Effect.Effect<MessageMiddleware, CheckInputError> {
  switch (entry.use) {
    case "acknowledgements":
      return Effect.succeed(acknowledgementsPolicy());
    case "allowed-senders":
      return Effect.succeed(allowedSendersPolicy(entry.agentIds));
    case "collective-norms":
      return Effect.map(bundle, (norms) => norms.incoming);
    default:
      return entry satisfies never;
  }
}

function outgoing(
  entry: OutgoingMiddlewareEntry,
  bundle: Bundle,
): Effect.Effect<MessageMiddleware, CheckInputError> {
  switch (entry.use) {
    case "credentials":
      return Effect.succeed(credentialsPolicy());
    case "plain-language":
      return Effect.succeed(plainLanguagePolicy(entry));
    case "collective-norms":
      return Effect.map(bundle, (norms) => norms.outgoing(entry.facilitator));
    default:
      return entry satisfies never;
  }
}
