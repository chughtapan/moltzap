// safer-arch-ignore no-trivial-sink-file: MasterKey is a distinct nominal key-material type that prevents the envelope from accepting DEKs or KEKs as the root key.

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
