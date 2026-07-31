import { Data } from "effect";

/** A registered-agent or bootstrap HTTP request could not be signed. */
export class AgentSigningError extends Data.TaggedError("AgentSigningError") {}
