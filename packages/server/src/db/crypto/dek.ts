import { SymmetricKeyMaterial } from "./key-material.js";

const dekTypeId = Symbol("@moltzap/server/Dek");

/** Implements dek. */
export class Dek extends SymmetricKeyMaterial {
  readonly [dekTypeId] = dekTypeId;

  private constructor(bytes: Buffer) {
    super(bytes);
  }

  static fromBytes(bytes: Buffer): Dek {
    return new Dek(bytes);
  }
}
