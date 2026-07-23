---
status: accepted
date: 2026-07-22
decision-makers: Tapan Chugh
---

# Control-plane encoding: neutral spec, JSON-RPC interim, REST + OpenAPI target

## Context and Problem Statement

The physical split bound control-plane ops to HTTP request/response
but left the op encoding open (`docs/spec/control-plane.md`, its
then-open question 8, removed by this decision): JSON-RPC methods
on a single POST — the v1-compatible
path — or plain REST resource operations over the plane's nouns. The
op families and guarantees are encoding-neutral; both encodings
satisfy them. What does the spec bind, and what does the
implementation ride?

## Considered Options

- Bind JSON-RPC in the spec, normative.
- Bind REST in the spec, normative; implement REST from day one.
- The spec binds neither; the wire keeps JSON-RPC and its existing
  infrastructure for now, with REST + OpenAPI as the recorded
  target.

## Decision Outcome

Chosen: **encoding-neutral spec; interim JSON-RPC wire; REST +
OpenAPI target**. This is an implementation plan, not a design
binding: the spec's op families and guarantees stay
encoding-neutral, which is exactly what makes the later move a wire
change, not a spec change. For now the wire keeps JSON-RPC methods
on a single POST and the existing descriptor-based infrastructure —
schema-first catalogs, strict decode, doc generation — rebound from
the socket mux to HTTP (any v2 carry-forward is by re-implementation
against the spec, never by import — `20260721-v2-lives-top-level.md`;
the salvage analyses say which pieces are worth carrying). Naming
that machinery decides no open question: wire discipline — v1's
strict excess-key rejection — stays register-open (`v2/VISION.md`,
register item 9). The target is proper REST resource operations
with OpenAPI contracts the CLI integrates directly: the OpenAPI
document becomes the wire contract — the spec's guarantees stay the
governing interface — and clients are generated from it, instead of
keeping a separate hand-maintained protocol package.

Consequences: a hand-maintained protocol package is an interim
artifact of the current wire, never a fixture v2 owes; when the
move happens, schema and doc-generation duty migrate from the
descriptor catalogs to the OpenAPI contract.
