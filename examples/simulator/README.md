# Original simulator: local three-container society

Run a small society on the v1 production track with one command:

```bash
pnpm simulator:example
```

The command builds the original `@moltzap/simulator`, pulls the pinned
OpenClaw image when it is absent, and starts exactly three run-owned containers:

1. the simulator's existing MoltZap router and embedded PGlite message store;
2. an OpenClaw container for `alice`; and
3. an OpenClaw container for `bob`.

The simulator kernel and durable RunLedger remain in the host Node process.
The customer program runs only after both OpenClaw channel connections are
ready, inspects the live Docker topology and isolation settings, then commits
one model-credential-free controlled-endpoint diagnostic to both agents
through the production router. It validates the ledger ordering and verifies
that scoped teardown leaves no run-owned containers.

Set `MOLTZAP_SIM_HOLD_SECONDS=30` to keep the ready topology alive briefly for
manual inspection. The accepted range is 0–300 seconds.
Set `MOLTZAP_DOCKER_BIN` when the Docker client is not `/usr/bin/docker`.

## Local profile

This example targets rootful Linux/amd64 Docker without user namespace
remapping. The router advertises a host-loopback address, so the two agent
containers use host networking without publishing agent ports. Host networking
also lets them reach other services on host loopback and each other's gateway
ports, so this is a trusted-machine profile rather than an untrusted-code
sandbox. Each agent runs as the invoking non-root UID with a read-only root
filesystem, all Linux capabilities dropped, no privilege escalation, no host
PID namespace, and no Docker socket. Its only writable bind mount is a unique
simulator-created state directory. The built channel, client, protocol, and
dependency store are mounted read-only so the unpublished workspace channel
can load inside the digest-pinned stock image.

No model credentials are required or copied into the containers: this slice
proves image startup, real channel readiness, identity assignment, router
dispatch, evidence ordering, and cleanup. It is a main-track v1 precursor
related to PR #917, not an implementation of the v2 Kubernetes, daemon,
recovery, or admission profile.
