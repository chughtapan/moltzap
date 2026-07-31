import { String as StringOps } from "effect";

/** Describes allowed coverage gap. */
export interface AllowedCoverageGap {
  readonly id: string;
  readonly reasonIncludes?: string;
}

/**
 * Checks whether allowed coverage gap.
 * @param allowed Value supplied to the operation.
 * @param id Value supplied to the operation.
 * @param reason Value supplied to the operation.
 * @returns Whether allowed coverage gap.
 */
export function isAllowedCoverageGap(
  allowed: readonly AllowedCoverageGap[],
  id: string,
  reason: string,
): boolean {
  return allowed.some((gap) => {
    if (gap.id !== id) {
      return false;
    }
    if (gap.reasonIncludes === undefined) {
      return true;
    }
    return StringOps.includes(gap.reasonIncludes)(reason);
  });
}
