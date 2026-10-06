`AgentSigningAuthority.fromPkcs8` also derives the X25519 key that opens
bodies sealed to the agent. Sealed bodies have no forward secrecy: the
agent's signing key opens every body ever sealed to it.
