import { SymmetricKeyMaterial } from "./key-material.js";

const DekTypeId = Symbol("@moltzap/server/Dek");

export class Dek extends SymmetricKeyMaterial {
  readonly [DekTypeId] = DekTypeId;

  private constructor(bytes: Buffer) {
    super(bytes);
  }

  static fromBytes(bytes: Buffer): Dek {
    return new Dek(bytes);
  }
}
