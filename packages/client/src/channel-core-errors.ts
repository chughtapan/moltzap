import { Data } from "effect";

// safer-arch-ignore no-trivial-sink-file: dispatch timeout and lease-expiry failures stay in a dedicated typed-error module so channel-core can focus on lifecycle orchestration.
export class DispatchAdmissionTimedOut extends Data.TaggedError(
  "DispatchAdmissionTimedOut",
)<{
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `dispatch request timed out after ${this.timeoutMs}ms`;
  }
}

export class DispatchLeaseExpired extends Data.TaggedError(
  "DispatchLeaseExpired",
)<{
  readonly messageId: string;
  readonly conversationId: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `dispatch lease expired after ${this.timeoutMs}ms`;
  }
}
