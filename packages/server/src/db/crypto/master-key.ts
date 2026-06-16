import { SymmetricKeyMaterial } from "./key-material.js";

const MasterKeyTypeId = Symbol("@moltzap/server/MasterKey");

export class MasterKey extends SymmetricKeyMaterial {
  readonly [MasterKeyTypeId] = MasterKeyTypeId;

  private constructor(bytes: Buffer) {
    super(bytes);
  }

  static fromBytes(bytes: Buffer): MasterKey {
    return new MasterKey(bytes);
  }
}
