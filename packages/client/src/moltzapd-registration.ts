/**
 * Registry commit for a profile slot that has no identity yet.
 *
 * Registration is non-idempotent: the server generates the key and
 * `agents.name` is unique, so a lost response requires a new agent name rather
 * than a retry.
 */
import { Effect } from "effect";
import { registerAgent, type RegisterAgentError } from "./auth.js";
import { getHttpUrl, getServerUrl, type ServiceConfigError } from "./config.js";
import type {
  HarnessRegisterInput,
  HarnessRegisterResult,
} from "./harness/index.js";
import type { DaemonPhaseState } from "./moltzapd-catalog.js";
import {
  writeProfile,
  type ProfileName,
  type ProfileRecord,
} from "./profile.js";
import type { ServiceRpcError } from "./service.js";

/** The Registry call, the server address lookup, and the slot write. */
export type CommitError = RegisterAgentError | ServiceConfigError | Error;

/** A commit plus the activation it triggers. */
export type RegistrationError = CommitError | ServiceRpcError;

interface CommitRegistrationInput {
  readonly name: ProfileName;
  readonly record: ProfileRecord;
  readonly payload: HarnessRegisterInput;
}

const commitRegistration = ({
  name,
  record,
  payload,
}: CommitRegistrationInput): Effect.Effect<
  HarnessRegisterResult,
  CommitError
> =>
  Effect.gen(function* () {
    const httpUrl = yield* getHttpUrl;
    const serverUrl = yield* getServerUrl;
    const result = yield* registerAgent(httpUrl, record.agentName, {
      ...(payload.inviteCode === undefined
        ? {}
        : { inviteCode: payload.inviteCode }),
      ...(payload.description === undefined
        ? {}
        : { description: payload.description }),
    });
    // The slot keeps its name and port; commit only adds the identity pair.
    yield* writeProfile(name, {
      ...record,
      agentId: result.agentId,
      apiKey: result.apiKey,
    });
    // The key stays on disk. Callers get the identity and where to reach it.
    return {
      agentId: result.agentId,
      agentName: record.agentName,
      serverUrl,
    };
  }).pipe(Effect.withSpan("moltzapd.register"));

interface RegisterHandlerInput {
  readonly name: ProfileName;
  readonly record: ProfileRecord;
  readonly phase: DaemonPhaseState;
  readonly activation: Effect.Semaphore;
  readonly activate: () => Effect.Effect<
    void,
    ServiceConfigError | ServiceRpcError
  >;
  readonly onCatalogChanged: () => void;
}

/**
 * Builds the `register` tool handler for a slot catalog.
 * @param input Slot identity, phase holder, and the activation to run on commit.
 * @param input.name Profile name owning the slot.
 * @param input.record Slot record the commit writes back into.
 * @param input.phase Current catalog state.
 * @param input.activation Serializes commit with the activation it triggers.
 * @param input.activate Transition to the active catalog.
 * @param input.onCatalogChanged Announces the new catalog to open subscribers.
 * @returns The registration handler.
 */
export const makeRegisterHandler =
  ({
    name,
    record,
    phase,
    activation,
    activate,
    onCatalogChanged,
  }: RegisterHandlerInput) =>
  (
    payload: HarnessRegisterInput,
  ): Effect.Effect<HarnessRegisterResult, RegistrationError> =>
    activation.withPermits(1)(
      Effect.gen(function* () {
        if (phase.read().kind === "active") {
          // eslint-disable-next-line agent-code-guard/effect-error-erasure -- Local MCP validation stays on the established broad Error boundary without adding a portable protocol error.
          return yield* Effect.fail(
            new Error("This profile slot already has an agent identity"),
          );
        }
        const result = yield* commitRegistration({ name, record, payload });
        yield* activate();
        // Clients holding an open subscription learn the catalog changed; any
        // later tools/list re-reads the phase regardless.
        onCatalogChanged();
        return result;
      }).pipe(Effect.withSpan("makeRegisterHandler")),
    );
