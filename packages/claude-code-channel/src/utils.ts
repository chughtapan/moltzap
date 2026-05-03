/**
 * Internal utilities shared within @moltzap/claude-code-channel.
 * Not exported from the package index.
 */

/**
 * Serialize an unknown thrown value to a string for error messages.
 * Prefer `.message` on Error instances; fall back to JSON, then String.
 */
export function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch (jsonErr) {
    const reason = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    return `${String(cause)} (json serialization failed: ${reason})`;
  }
}
