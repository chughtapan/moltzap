import { SymmetricKeyMaterial } from "./key-material.js";

const KekTypeId = Symbol("@moltzap/server/Kek");

export class Kek extends SymmetricKeyMaterial {
  readonly [KekTypeId] = KekTypeId;

  private constructor(bytes: Buffer) {
    super(bytes);
  }

  static fromBytes(bytes: Buffer): Kek {
    return new Kek(bytes);
  }
}
