import { Context, Data, Effect, Layer } from "effect";

export type UserId = string & { readonly __brand: "UserId" };
export type AppId = string & { readonly __brand: "AppId" };

export interface StoredGrant {
  readonly userId: UserId;
  readonly appId: AppId;
  readonly resource: string;
  readonly access: readonly string[];
  readonly grantedAt: string;
}

export class GrantStorageError extends Data.TaggedError("GrantStorageError")<{
  readonly cause: unknown;
}> {}

export interface GrantStore {
  readonly findCoveringGrant: (params: {
    readonly userId: UserId;
    readonly appId: AppId;
    readonly resource: string;
    readonly requiredAccess: readonly string[];
  }) => Effect.Effect<StoredGrant | null, GrantStorageError>;

  readonly upsertGrant: (params: {
    readonly userId: UserId;
    readonly appId: AppId;
    readonly resource: string;
    readonly access: readonly string[];
  }) => Effect.Effect<void, GrantStorageError>;

  readonly listGrants: (params: {
    readonly userId: UserId;
    readonly appId?: AppId;
  }) => Effect.Effect<readonly StoredGrant[], GrantStorageError>;

  readonly revokeGrant: (params: {
    readonly userId: UserId;
    readonly appId: AppId;
    readonly resource: string;
  }) => Effect.Effect<void, GrantStorageError>;
}

export class GrantStoreTag extends Context.Tag("@moltzap/server/GrantStore")<
  GrantStoreTag,
  GrantStore
>() {}

export const GrantStoreLive: Layer.Layer<GrantStoreTag, never, never> =
  Layer.effect(
    GrantStoreTag,
    Effect.sync(() => {
      throw new Error("not implemented");
    }),
  );
