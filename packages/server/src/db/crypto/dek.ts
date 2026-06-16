const DekTypeId = Symbol("@moltzap/server/Dek");

export class Dek {
  readonly [DekTypeId] = DekTypeId;

  private constructor(readonly bytes: Buffer) {}

  static fromBytes(bytes: Buffer): Dek {
    return new Dek(bytes);
  }
}
