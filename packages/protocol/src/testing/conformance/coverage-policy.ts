export type CoverageGapKind = "deferred" | "unavailable";

export interface AllowedCoverageGap {
  readonly kind: CoverageGapKind;
  readonly id: string;
  readonly reasonIncludes?: string;
}

export function isAllowedCoverageGap(
  allowed: ReadonlyArray<AllowedCoverageGap>,
  kind: CoverageGapKind,
  id: string,
  reason: string,
): boolean {
  return allowed.some((gap) => {
    if (gap.kind !== kind || gap.id !== id) return false;
    if (gap.reasonIncludes === undefined) return true;
    return reason.includes(gap.reasonIncludes);
  });
}
