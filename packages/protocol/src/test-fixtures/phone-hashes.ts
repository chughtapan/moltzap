/** Known SHA-256(E.164 phone) vectors for cross-package hash consistency tests. */
export const PHONE_HASH_VECTORS = [
  {
    phone: "+15551234567",
    hash: "8a59780bb8cd2ba022bfa5ba2ea3b6e07af17a7d8b30c1f9b3390e36f69019e4",
  },
  {
    phone: "+447946000000",
    hash: "ed0be74d3400b725fe33fb001bbde70ad299d3d45ec0d00a9b36e25d155b4858",
  },
  {
    phone: "+61412345678",
    hash: "bc65da54a3ddbacfdc93a0400f0a2d78e41c2180c8255015e9616facfe56f58a",
  },
  {
    phone: "+33612345678",
    hash: "42d573cfc315801d4cd8eddd5416b416a0bf298b9b9e12d6b07442c91db42bd8",
  },
  {
    phone: "+81901234567",
    hash: "1eb681ccbe653f103bb6bbac414d748bbb2e8d757460b98a889d4fc7410d2947",
  },
] as const;
