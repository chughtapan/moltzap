import { Data } from "effect";

// `MalformedFrameError` is now protocol-side (`@moltzap/protocol`); both
// client and server share the same class. Re-exported here for the
// existing client-package import surface.
export { MalformedFrameError } from "@moltzap/protocol";

/** A name→agent lookup returned no results. */
export class AgentNotFoundError extends Data.TaggedError("AgentNotFoundError")<{
  readonly agentName: string;
}> {
  override get message(): string {
    return `Agent not found: ${this.agentName}`;
  }
}
