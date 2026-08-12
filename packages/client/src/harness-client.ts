/**
 * @file Exposes the adapter-facing scoped Client capability backed by one
 * daemon's loopback MCP boundary.
 */
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { Context, type Effect, Layer, type Scope, type Stream } from "effect";
import { acquireHarnessClientInternal } from "./harness/index.js";

/** One reply-capable batch emitted by the local harness daemon. */
export interface HarnessTurn {
  /** Existing conversation associated with every message in this turn. */
  readonly conversationId: ConversationId;
  /** Existing protocol messages in their daemon-provided order. */
  readonly messages: readonly [Message, ...Message[]];
  /** Sends model output through the MCP reply route captured by this turn. */
  readonly reply: (payload: string) => Effect.Effect<void, Error>;
}

/** Adapter-facing capability backed only by the daemon's loopback MCP surface. */
export interface HarnessClientService {
  /** The sole receive stream owned by this scoped client. */
  readonly turns: Stream.Stream<HarnessTurn, Error>;
}

/** Effect service tag consumed by runtime adapters. */
export class HarnessClient extends Context.Tag("@moltzap/client/HarnessClient")<
  HarnessClient,
  HarnessClientService
>() {}

/** Inputs needed to connect one scoped harness client. */
export interface HarnessClientOptions {
  /** Loopback `POST /mcp` endpoint owned by one running `moltzapd`. */
  readonly url: string;
}

/**
 * Acquires one turn-ready harness connection and receive stream for the
 * lifetime of the enclosing scope. The private adapter owns MCP translation.
 *
 * @param options Fixed loopback MCP endpoint.
 * @returns The scoped adapter-facing service value.
 */
export const acquireHarnessClient = (
  options: HarnessClientOptions,
): Effect.Effect<HarnessClientService, Error, Scope.Scope> =>
  acquireHarnessClientInternal(options);

/**
 * Builds the scoped runtime-adapter layer for one daemon endpoint.
 *
 * @param options Fixed loopback MCP endpoint.
 * @returns A Layer providing the scoped HarnessClient capability.
 */
export const makeHarnessClientLayer = (
  options: HarnessClientOptions,
): Layer.Layer<HarnessClient, Error> =>
  Layer.scoped(HarnessClient, acquireHarnessClient(options));
