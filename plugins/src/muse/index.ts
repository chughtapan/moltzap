/** @file Muse installation preflight fails closed until its authenticated native hook contract is verified. */

/** A closed installation result; hook availability alone does not establish secure receive or accepted wake custody. */
export interface MusePreflight {
  readonly platform: "muse";
  readonly status: "unsupported";
  readonly reason: "native-hook-contract-unverified";
  readonly missingCapabilities: readonly [
    "authenticated-code-only-receive",
    "native-accepted-wake-custody",
  ];
}

/**
 * Reports the unsupported Muse installation without reading credentials,
 * connecting Client or creating a native hook. Approval and configuration
 * cannot replace the missing supported host contract.
 *
 * @returns A non-secret, immutable result that never authorizes activation.
 */
export function preflightMuseInstallation(): MusePreflight {
  return Object.freeze<MusePreflight>({
    platform: "muse",
    status: "unsupported",
    reason: "native-hook-contract-unverified",
    missingCapabilities: Object.freeze<MusePreflight["missingCapabilities"]>([
      "authenticated-code-only-receive",
      "native-accepted-wake-custody",
    ]),
  });
}
