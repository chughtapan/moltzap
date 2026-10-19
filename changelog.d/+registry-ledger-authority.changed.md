Registry uses its migration ledger as the only schema authority and refuses unknown applied migration ids with `newer-schema` in startup diagnostics.
Registry retains the wire-version metadata gate and reports a mismatched signing key as `signer-mismatch`.
