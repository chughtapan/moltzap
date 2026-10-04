# Wire

This folder owns the exact protocol representation: closed schemas, canonical
JCS encoding, hashing and signing, verification, and the message values
(`PostId`, `Content`) every layer above encodes. `encoding/` holds the
canonical bytes and the hashes and signatures over them; `verification.ts`
builds on it.

Other domains use `index.ts`. Hosts read `values.ts` (addresses, post ids, content, and
member limits) directly, so they never load signing, verification, or the
Router client. Nothing here depends on another Client domain.
