import { Type, type TNumber, type TString } from "@sinclair/typebox";
import type { Brand } from "effect";

export type BrandedString<BrandName extends string> = string &
  Brand.Brand<BrandName>;
export type BrandedNumber<BrandName extends string> = number &
  Brand.Brand<BrandName>;

export function brandedString<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.String>[0] = {},
) {
  return Type.String({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TString & { static: BrandedString<BrandName> };
}

export function brandedNumber<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.Number>[0] = {},
) {
  return Type.Number({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TNumber & { static: BrandedNumber<BrandName> };
}
