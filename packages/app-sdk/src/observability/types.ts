import type { Brand, Effect } from "effect";

export type SessionId = string & Brand.Brand<"SessionId">;
export type BufferLimitInput = number | "unbounded";

export type HookMethod =
  | "apps/onBeforeDispatch"
  | "apps/onBeforeMessageDelivery"
  | "apps/onSessionActive"
  | "apps/onJoin"
  | "apps/onClose";

export type VerdictTag = "grant" | "deny" | "hold" | "allow" | "block" | "void";

export interface ReplayEvent {
  readonly sessionId: SessionId;
  readonly method: HookMethod;
  readonly requestId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly params: unknown;
  readonly outcome:
    | {
        readonly kind: "ok";
        readonly verdictTag: VerdictTag;
        readonly verdict: unknown;
      }
    | {
        readonly kind: "fail-closed";
        readonly verdictTag: VerdictTag;
        readonly errorMessage: string;
        readonly errorTag?: string;
      };
}

export type SessionSnapshot = Readonly<Record<string, unknown>>;

export type SnapshotCallback = (
  sessionId: SessionId,
) => Effect.Effect<SessionSnapshot, never>;

export const REPLAY_BUNDLE_SCHEMA_VERSION = 1;

export interface ReplayBundle {
  readonly schemaVersion: typeof REPLAY_BUNDLE_SCHEMA_VERSION;
  readonly sessionId: SessionId;
  readonly appId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly traceEvents: readonly ReplayEvent[];
  readonly truncated: boolean;
  readonly appData: SessionSnapshot;
}

export interface TracerInitOptions {
  readonly serviceName: string;
  readonly appId: string;
  readonly otlpEndpoint: string | undefined;
  readonly shutdownTimeoutMs: number;
}

export type TranscriptMeta =
  | {
      readonly kind: "arena-live";
      readonly model: string;
      readonly playerCount: number;
      readonly gameNumber: number;
      readonly status: string;
    }
  | {
      readonly kind: "generic";
      readonly attributes: Readonly<Record<string, unknown>>;
    };
