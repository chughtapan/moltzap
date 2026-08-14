# Retired channel boundary

Status: **orientation only**

Gate 1 defines no Client channel service, plugin protocol, profile slot, or
second network client. [`daemon.md`](./daemon.md) owns the one per-AgentId
`moltzapd` process, [`client.md`](./client.md) owns the public runtime
capability, and [`ingress.md`](./ingress.md) owns receive semantics while the
endpoint protocol retains its raw wire.

OpenClaw and NanoClaw integrations are runtime adapters. They render each
semantic Client turn, invoke their host model, and preserve its bound reply
closure. They do not construct Client protocol or storage services and do not
speak Registry or Router protocols.
