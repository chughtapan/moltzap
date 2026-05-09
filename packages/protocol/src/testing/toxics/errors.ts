/**
 * Toxiproxy control-plane errors. Co-located with `./client.ts` because
 * that is the only call site that raises this tag.
 */
import { Data } from "effect";

/** Toxiproxy HTTP API returned a non-2xx, or the control endpoint is down. */
export class ToxicControlError extends Data.TaggedError(
  "TestingToxicControlError",
)<{
  readonly op: "create-proxy" | "delete-proxy" | "add-toxic" | "remove-toxic";
  readonly status: number;
  readonly body: string;
}> {}
