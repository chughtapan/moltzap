/**
 * @file Public L3 storage contracts: closed action certificates and
 * self-contained canonical TranscriptRecords. The Ledger validates
 * certificate format, bindings, signer set, and signatures mechanically;
 * it never evaluates grant precedence, content, task legality, or policy.
 *
 * This package depends on Router contracts only to retain Router
 * evidence.
 * It never depends on a Router implementation.
 */

export {};
