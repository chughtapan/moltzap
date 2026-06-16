const MasterKeyTypeId = Symbol("@moltzap/server/MasterKey");

export class MasterKey {
  readonly [MasterKeyTypeId] = MasterKeyTypeId;

  private constructor(readonly bytes: Buffer) {}

  static fromBytes(bytes: Buffer): MasterKey {
    return new MasterKey(bytes);
  }
}
