# Wire

This folder owns the exact protocol representation: closed schemas, canonical
JCS encoding, hashing and signing, verification, and the message values
(`PostId`, `Content`) every layer above encodes.

Other domains use `index.ts`. Nothing here depends on another Client domain.
