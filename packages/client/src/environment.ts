/** @file Host configuration validation through the Client boundary. */

import { legacyKeys as identityLegacyKeys } from "@moltzap/identity";

/** Returns retired key names, including empty settings, without exposing values. */
export function legacyKeys(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return identityLegacyKeys(environment);
}
