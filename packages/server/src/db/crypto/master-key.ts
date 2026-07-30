// safer-arch-ignore no-trivial-sink-file: MasterKey must remain a distinct class because the one-non-trivial-class lint invariant prevents co-locating it with EnvelopeEncryption.
import { SymmetricKeyMaterial } from "./key-material.js";

/** Master key material derived from the operator-provided secret. */
export class MasterKey extends SymmetricKeyMaterial {
  /**
   * Constructs master-key material from validated bytes.
   * @param bytes Validated AES-256 key bytes owned by the caller.
   * @returns Master-key material.
   */
  static fromBytes(bytes: Buffer): MasterKey {
    return new MasterKey(bytes);
  }
}
