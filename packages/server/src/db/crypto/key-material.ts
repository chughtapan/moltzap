export abstract class SymmetricKeyMaterial {
  private readonly bytes: Buffer;

  protected constructor(bytes: Buffer) {
    this.bytes = Buffer.from(bytes);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}
