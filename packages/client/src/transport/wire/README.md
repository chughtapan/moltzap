# Wire

This folder owns the exact protocol representation: closed schemas, canonical
JCS encoding, hashing and signing, verification, and the message values
(`PostId`, `Content`) every layer above encodes.

Other domains use `index.ts`. Hosts read `values.ts` (post ids, content, and
member limits) directly, so they never load signing, verification, or the
Router client. Nothing here depends on another Client domain.
