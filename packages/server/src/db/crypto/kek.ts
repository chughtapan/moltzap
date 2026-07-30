import { SymmetricKeyMaterial } from "./key-material.js";

const kekTypeId = Symbol("@moltzap/server/Kek");

/** Implements kek. */
export class Kek extends SymmetricKeyMaterial {
  readonly [kekTypeId] = kekTypeId;

  private constructor(bytes: Buffer) {
    super(bytes);
  }

  static fromBytes(bytes: Buffer): Kek {
    return new Kek(bytes);
  }
}
