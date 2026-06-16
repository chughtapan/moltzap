const KekTypeId = Symbol("@moltzap/server/Kek");

export class Kek {
  readonly [KekTypeId] = KekTypeId;

  private constructor(readonly bytes: Buffer) {}

  static fromBytes(bytes: Buffer): Kek {
    return new Kek(bytes);
  }
}
