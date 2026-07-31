import * as Identity from "@moltzap/v2-identity";
import { describe, expect, it } from "vitest";

describe("identity package", () => {
  it("exposes exactly the approved identity foundation", () => {
    expect(new Set(Object.keys(Identity))).toEqual(
      new Set([
        "AgentCard",
        "AgentCardDigest",
        "AgentCardVerificationError",
        "AgentId",
        "AgentName",
        "AgentSigningAuthority",
        "AgentSigningError",
        "AuthenticatedHttp",
        "AuthenticationFailedError",
        "Ed25519PublicKey",
        "InternalServerError",
        "InvalidAgentPrivateKeyError",
        "MOLTZAP_VERSION",
        "MalformedRequestError",
        "MessageId",
        "MethodNotAllowedError",
        "OperationId",
        "OverloadedError",
        "PayloadTooLargeError",
        "PrincipalId",
        "Registry",
        "RegistryConnectionError",
        "RegistryInvalidResponseError",
        "RegistryListRequest",
        "RegistryLookupRequest",
        "RegistryRegisterRequest",
        "RegistryRequestTimeoutError",
        "RouteNotFoundError",
        "SignedMessage",
        "SignedMessageSigningError",
        "SignedMessageVerificationError",
        "UnavailableError",
        "UnsupportedMediaTypeError",
        "VersionMismatchError",
      ]),
    );
  });
});
