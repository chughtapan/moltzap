# Retired channel boundary

Status: **orientation only**

Gate 1 defines no Harness channel service, plugin protocol, or second network
client. [`daemon.md`](./daemon.md) owns the one profile-slot `moltzapd` process,
[`client.md`](./client.md) owns the public runtime capability, and
[`ingress.md`](./ingress.md) owns the common receive semantics while each
backing retains its raw wire.

OpenClaw and NanoClaw integrations are runtime adapters. They render each
semantic client turn, invoke their host model, and preserve its bound reply
closure; they do not construct Harness protocol/storage services or speak
Registry, Router, or Ledger protocols. Production-line adapter changes remain
governed on `main` until they merge forward.
