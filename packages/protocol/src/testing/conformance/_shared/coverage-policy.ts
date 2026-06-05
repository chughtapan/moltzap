export interface AllowedCoverageGap {
  readonly id: string;
  readonly reasonIncludes?: string;
}

export function isAllowedCoverageGap(
  allowed: ReadonlyArray<AllowedCoverageGap>,
  id: string,
  reason: string,
): boolean {
  return allowed.some((gap) => {
    if (gap.id !== id) return false;
    if (gap.reasonIncludes === undefined) return true;
    return reason.includes(gap.reasonIncludes);
  });
}
