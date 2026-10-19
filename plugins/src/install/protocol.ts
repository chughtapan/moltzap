/** @file One bounded attempt uses fixed deployment enrollment routes; redirects and untrusted response diagnostics never cross installer custody. */

import {
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
} from "@effect/platform";
import { Effect, Match, Option, Redacted, Schema } from "effect";
import {
  decodeInstall,
  encodeNativeSetup,
  InstallFailure,
  type InstallReceipt,
  type NativeSetup,
  RegistrationResponse,
  runtimeCredential,
  setupIdentity,
} from "./model.js";

const progress = Schema.Struct({
  state: Schema.Literal("pending", "retry", "unavailable"),
});
const setupResponse = Schema.Struct({
  state: Schema.Literal("pending", "ready"),
  identity: Schema.String,
  platform: Schema.Literal("instinct", "grokbot"),
  destination: Schema.String,
});
const bootstrapResponse = Schema.Struct({
  state: Schema.Literal("ready"),
  resource: Schema.String,
  credential: runtimeCredential,
});

/** The raw original claim link is accepted only when it exactly reproduces this retained request. */
export const registerInstallation = Effect.fn("Installer.registerInstallation")(
  function* (receipt: InstallReceipt) {
    const response = yield* post(
      receipt,
      "/enrollment/registrations",
      {
        target: receipt.target,
        name: receipt.name,
        expiresAt: receipt.expiresAt,
        claimToken: Redacted.value(receipt.claimToken),
      },
      false,
    );
    if (response.status !== 200) {
      return yield* registrationRefusal(response.status);
    }
    const value = yield* decodeInstall(
      RegistrationResponse,
      response.body,
      "response",
    );
    if (
      JSON.stringify(value.target) !== JSON.stringify(receipt.target) ||
      value.name !== receipt.name ||
      value.expiresAt !== receipt.expiresAt ||
      Redacted.value(value.claimUrl) !== claimUrl(receipt)
    ) {
      return yield* Effect.fail(new InstallFailure({ reason: "response" }));
    }
    return {
      state: "registered" as const,
      installationId: value.installationId,
      claimed: value.claimed,
    };
  },
);

/** Configuration replay checks the server's receipt against the already retained exact destination and key identity. */
export const prepareNativeSetup = Effect.fn("Installer.prepareNativeSetup")(
  function* (receipt: InstallReceipt, setup: NativeSetup) {
    const body = yield* encodeNativeSetup(setup);
    const response = yield* post(
      receipt,
      "/enrollment/native-setup",
      body,
      true,
    );
    if (response.status !== 200 && response.status !== 202) {
      return yield* responseProgress(response);
    }
    const value = yield* decodeInstall(
      setupResponse,
      response.body,
      "response",
    );
    if (!matchesSetup(value, response.status, setup)) {
      return yield* Effect.fail(new InstallFailure({ reason: "response" }));
    }
    return { state: value.state };
  },
);

/** Collection returns redacted authority only for the one explicitly trusted MCP resource. */
export const collectRuntimeCredential = Effect.fn(
  "Installer.collectRuntimeCredential",
)(function* (receipt: InstallReceipt) {
  const response = yield* post(
    receipt,
    "/enrollment/bootstrap",
    undefined,
    true,
  );
  if (response.status !== 200) {
    return yield* responseProgress(response);
  }
  const value = yield* decodeInstall(
    bootstrapResponse,
    response.body,
    "response",
  );
  if (value.resource !== receipt.resource) {
    return yield* Effect.fail(new InstallFailure({ reason: "response" }));
  }
  return value;
});

/** The fragment is private enrollment authority, so only the explicit private-file command may release it. */
export function claimUrl(receipt: InstallReceipt): string {
  return `${receipt.origin}enrollment/claim#${Redacted.value(receipt.claimToken)}`;
}

function post(
  receipt: InstallReceipt,
  route: string,
  body: unknown,
  authenticated: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const base = HttpClientRequest.post(new URL(route, receipt.origin));
      const request =
        body === undefined
          ? base
          : yield* HttpClientRequest.bodyJson(base, body);
      const response = yield* client
        .pipe(HttpClient.withTracerDisabledWhen(() => true))
        .execute(
          authenticated
            ? HttpClientRequest.bearerToken(request, receipt.claimToken)
            : request,
        );
      if (route === "/enrollment/registrations" && response.status !== 200) {
        return { status: response.status, body: undefined };
      }
      if (![200, 202, 404, 503].includes(response.status)) {
        return yield* Effect.fail(new InstallFailure({ reason: "response" }));
      }
      return { status: response.status, body: yield* response.json };
    }),
  ).pipe(
    HttpIncomingMessage.withMaxBodySize(Option.some(4096)),
    Effect.timeoutFail({
      duration: "15 seconds",
      onTimeout: () => new InstallFailure({ reason: "transport" }),
    }),
    Effect.catchTags({
      RequestError: () =>
        Effect.fail(new InstallFailure({ reason: "transport" })),
      ResponseError: () =>
        Effect.fail(new InstallFailure({ reason: "response" })),
      HttpBodyError: () => Effect.fail(new InstallFailure({ reason: "usage" })),
    }),
  );
}

/** Registration's browser-facing refusal is HTML; its fixed status, never that private body, determines machine progress. */
function registrationRefusal(status: number) {
  if (status === 503) {
    return Effect.succeed({ state: "retry" as const });
  }
  if (status === 404) {
    return Effect.succeed({ state: "unavailable" as const });
  }
  const reason = Match.value(status).pipe(
    Match.when(409, () => "conflict" as const),
    Match.when(400, () => "usage" as const),
    Match.orElse(() => "response" as const),
  );
  return Effect.fail(new InstallFailure({ reason }));
}

function responseProgress(response: {
  readonly status: number;
  readonly body: unknown;
}) {
  return decodeInstall(progress, response.body, "response").pipe(
    Effect.flatMap((value) => {
      const expectedState = Match.value(response.status).pipe(
        Match.when(202, () => "pending"),
        Match.when(503, () => "retry"),
        Match.when(404, () => "unavailable"),
        Match.orElse(() => undefined),
      );
      return value.state === expectedState
        ? Effect.succeed(value)
        : Effect.fail(new InstallFailure({ reason: "response" }));
    }),
  );
}

function matchesSetup(
  value: typeof setupResponse.Type,
  status: number,
  setup: NativeSetup,
): boolean {
  const expectedState = status === 200 ? "ready" : "pending";
  const destination =
    setup.platform === "instinct" ? setup.recipient : setup.routineUrl;
  return (
    value.state === expectedState &&
    value.platform === setup.platform &&
    value.destination === destination &&
    value.identity === setupIdentity(setup)
  );
}
