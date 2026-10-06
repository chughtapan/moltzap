/** @file A daemon ignores a peer's outer body that does not open for it, and its Router worker keeps accepting sealed traffic. */

import type { Registry } from "@moltzap/identity/registry";
import type { Router } from "@moltzap/router";
import {
  type AgentSigningAuthority,
  MessageId,
  MOLTZAP_VERSION,
  SealedBody,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  type Context,
  Deferred,
  Effect,
  Queue,
  Ref,
  Schema,
  Scope,
} from "effect";
import { describe, expect, it } from "vitest";
import type { EndpointEngine } from "../../transport/messaging/index.js";
import type { DaemonRuntimeError } from "../errors.js";
import { digest, identifier } from "../../__tests__/agent-card-fixtures.js";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import { makeStore } from "../../__tests__/daemon-runtime-harness.js";
import {
  batch,
  emptyBatch,
  makeIdentityFixture,
  pollCursor,
  routerInstanceId,
} from "../../__tests__/router-worker-fixtures.js";
import {
  makeRouterWorker,
  type RouterWorker,
} from "../../transport/router/index.js";
import {
  type CatchUpRequest,
  ConversationId,
  type DecodedOuterBody,
  DirectPacket,
  encodeCanonical,
  MembershipHash,
  signOuterPacket,
} from "../../transport/wire/index.js";
import { acquireProtocol } from "./protocol.js";

interface Member {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

/** The daemon's identity, the peer it shares a conversation with, and an agent outside it. */
interface Members {
  readonly local: Member;
  readonly peer: Member;
  readonly outsider: Member;
}

/** Builds one envelope from the peer side that the daemon must not open. */
type RefusedEnvelope = (
  members: Members,
  plaintext: Uint8Array,
) => Effect.Effect<SignedMessage, unknown>;

const instance = routerInstanceId(21);

const messageId = (byte: number) =>
  Schema.decodeUnknownSync(MessageId)(identifier("msg_", byte));

const catchUpRequestFrom = (requester: VerifiedAgentCard): CatchUpRequest => ({
  moltzapVersion: MOLTZAP_VERSION,
  kind: "catch_up_request",
  conversationId: Schema.decodeUnknownSync(ConversationId)(digest("cnv_", 22)),
  membershipHash: Schema.decodeUnknownSync(MembershipHash)(digest("mbr_", 23)),
  requesterAgentId: requester.agentId,
  knownRecordHash: null,
  knownAnchorHash: null,
});

/** Signs `body` as `sender` to the daemon and the peer. */
const signToConversation = (
  sender: Member,
  members: Members,
  id: MessageId,
  body: Uint8Array,
) =>
  SignedMessage.sign({
    agentCard: sender.card,
    signingAuthority: sender.authority,
    recipientAgentIds: new Set([
      members.local.card.agentId,
      members.peer.card.agentId,
    ]),
    messageId: id,
    body,
  });

/** Seals `plaintext` from the peer to `recipients` under `id`. */
const sealFromPeer = (
  members: Members,
  recipients: readonly VerifiedAgentCard[],
  id: MessageId,
  plaintext: Uint8Array,
) =>
  SealedBody.seal({
    senderAgentId: members.peer.card.agentId,
    recipientAgentCards: recipients,
    messageId: id,
    plaintext,
  });

const plaintextBody: RefusedEnvelope = (members, plaintext) =>
  signToConversation(members.peer, members, messageId(31), plaintext);

const bodySealedToOtherRecipients: RefusedEnvelope = (members, plaintext) =>
  sealFromPeer(
    members,
    [members.peer.card, members.outsider.card],
    messageId(32),
    plaintext,
  ).pipe(
    Effect.flatMap((sealed) =>
      signToConversation(members.peer, members, messageId(32), sealed),
    ),
  );

const bodyResignedByAnotherSender: RefusedEnvelope = (members, plaintext) =>
  sealFromPeer(
    members,
    [members.local.card, members.peer.card],
    messageId(33),
    plaintext,
  ).pipe(
    Effect.flatMap((sealed) =>
      signToConversation(members.outsider, members, messageId(33), sealed),
    ),
  );

const bodyResignedUnderAnotherMessageId: RefusedEnvelope = (
  members,
  plaintext,
) =>
  sealFromPeer(
    members,
    [members.local.card, members.peer.card],
    messageId(34),
    plaintext,
  ).pipe(
    Effect.flatMap((sealed) =>
      signToConversation(members.peer, members, messageId(35), sealed),
    ),
  );

const memberOf = (byte: number, name: string): Effect.Effect<Member> =>
  makeIdentityFixture(byte, name).pipe(
    Effect.map((fixture) => ({
      card: fixture.localCard,
      authority: fixture.localAuthority,
    })),
  );

/** Resolves exactly the named cards, as the Registry does for registered agents. */
const registryOf = (
  cards: readonly VerifiedAgentCard[],
): Context.Tag.Service<typeof Registry> => ({
  lookup: (request) => {
    const card = cards.find((candidate) =>
      "agentId" in request
        ? candidate.agentId === request.agentId
        : candidate.agentName === request.agentName,
    );
    return Effect.succeed(
      card === undefined
        ? { kind: "not_found" }
        : { kind: "found", agentCard: card },
    );
  },
  list: () => Effect.dieMessage("the daemon lists no agents in this test"),
  register: () => Effect.dieMessage("the daemon registers nothing here"),
});

/**
 * A Router whose tail probe answers at once and whose cursor polls wait for
 * `released`. The first released poll carries `feed`; every later poll
 * signals `polledAgain` and stays open, as a held long poll does.
 */
const routerFeeding = (input: {
  readonly feed: readonly SignedMessage[];
  readonly released: Deferred.Deferred<undefined>;
  readonly polledAgain: Deferred.Deferred<undefined>;
  readonly fed: Ref.Ref<boolean>;
}): Context.Tag.Service<typeof Router> => ({
  poll: (call) =>
    call.request.pollCursor === undefined
      ? Effect.succeed(emptyBatch(instance, pollCursor(24)))
      : Deferred.await(input.released).pipe(
          Effect.zipRight(Ref.getAndSet(input.fed, true)),
          Effect.flatMap((alreadyFed) =>
            alreadyFed
              ? Deferred.succeed(input.polledAgain, undefined).pipe(
                  Effect.zipRight(Effect.never),
                )
              : Effect.succeed(batch(instance, pollCursor(25), input.feed)),
          ),
        ),
  send: () => Effect.dieMessage("the daemon sends nothing in this test"),
});

/** An engine that records every payload its Router worker hands it. */
const recordingEngine = (
  accepted: Queue.Queue<DecodedOuterBody>,
): EndpointEngine => ({
  send: () => Effect.dieMessage("the daemon sends nothing in this test"),
  resolveAddress: () => Effect.dieMessage("no address is resolved here"),
  readPendingMessages: () => Effect.succeed([]),
  acknowledgeMessage: () => Effect.dieMessage("nothing is delivered here"),
  acceptRouterIngress: (ingress) =>
    Queue.offer(accepted, ingress.payload).pipe(Effect.as("accepted" as const)),
  acceptRecoveryIngress: (ingress) =>
    Queue.offer(accepted, ingress.payload).pipe(Effect.as("accepted" as const)),
  recoverCertifiedHistory: () => Effect.void,
  drainOutbound: Effect.void,
  runOutbound: Effect.never,
  abandonVolatileFolds: () => Effect.void,
  rearmCatchUp: Effect.void,
});

/** What a running daemon protocol exposes to the test that started it. */
interface RunningProtocol {
  readonly worker: RouterWorker;
  readonly accepted: Queue.Queue<DecodedOuterBody>;
  readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
}

/**
 * Acquire the daemon's protocol over a real Router worker, a Router that
 * carries `feed` once `released` resolves and signals `polledAgain` on the
 * poll after it, and an engine that records every payload it accepts.
 */
const runProtocol = (input: {
  readonly fixture: Effect.Effect.Success<typeof makeFixture>;
  readonly members: Members;
  readonly feed: readonly SignedMessage[];
  readonly released: Deferred.Deferred<undefined>;
  readonly polledAgain: Deferred.Deferred<undefined>;
}): Effect.Effect<RunningProtocol, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const workerReady = yield* Deferred.make<RouterWorker>();
    const accepted = yield* Queue.unbounded<DecodedOuterBody>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    yield* acquireProtocol(
      {
        store: makeStore(input.fixture, true),
        bootstrap: input.fixture.bootstrap,
        edges: {
          makeWorker: (workerInput) =>
            makeRouterWorker(workerInput).pipe(
              Effect.tap((worker) => Deferred.succeed(workerReady, worker)),
            ),
          makeEngine: () => Effect.succeed(recordingEngine(accepted)),
        },
        registry: registryOf([
          input.members.local.card,
          input.members.peer.card,
          input.members.outsider.card,
        ]),
        router: routerFeeding({
          feed: input.feed,
          released: input.released,
          polledAgain: input.polledAgain,
          fed: yield* Ref.make(false),
        }),
        daemonScope: yield* Scope.Scope,
        fatal,
      },
      {
        retain: () => undefined,
        publishPending: Effect.void,
        emit: () => Effect.void,
      },
      input.fixture.localCard,
    );
    return { worker: yield* Deferred.await(workerReady), accepted, fatal };
  });

const ignoresRefusedBodyAndKeepsRunning = (refused: RefusedEnvelope) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const members: Members = {
          local: {
            card: fixture.localCard,
            authority: fixture.bootstrap.signingAuthority,
          },
          peer: yield* memberOf(2, "sealed-peer"),
          outsider: yield* memberOf(3, "sealed-outsider"),
        };
        const packet = catchUpRequestFrom(members.peer.card);
        const plaintext = yield* encodeCanonical(DirectPacket, packet);
        const sealed = yield* signOuterPacket({
          packet,
          membership: { members: [members.local.card, members.peer.card] },
          agentCard: members.peer.card,
          signingAuthority: members.peer.authority,
        });
        const released = yield* Deferred.make<undefined>();
        const polledAgain = yield* Deferred.make<undefined>();
        const running = yield* runProtocol({
          fixture,
          members,
          feed: [yield* refused(members, plaintext), sealed],
          released,
          polledAgain,
        });

        yield* running.worker.awaitAnchor;
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(polledAgain).pipe(Effect.timeout("5 seconds"));

        expect(
          Array.from(yield* Queue.takeAll(running.accepted)),
        ).toStrictEqual([{ kind: "direct", packet }]);
        expect(yield* Deferred.isDone(running.fatal)).toBe(false);
      }),
    ),
  );

describe("daemon ingress of outer bodies", () => {
  it.each([
    { body: "a plaintext body", refused: plaintextBody },
    {
      body: "a body sealed to other recipients",
      refused: bodySealedToOtherRecipients,
    },
    {
      body: "a sealed body re-signed by another sender",
      refused: bodyResignedByAnotherSender,
    },
    {
      body: "a sealed body re-signed under another MessageId",
      refused: bodyResignedUnderAnotherMessageId,
    },
  ])("ignores $body and goes on accepting sealed traffic", ({ refused }) =>
    ignoresRefusedBodyAndKeepsRunning(refused),
  );
});
