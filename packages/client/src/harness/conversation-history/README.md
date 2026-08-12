# Conversation history

This folder owns package-private, representation-neutral laws for endpoint
conversation history. It currently separates three concerns:

- durability threshold arithmetic;
- mergeable fixed-member vote progress for records and Router re-anchors; and
- fail-closed selection of one verified descendant head before re-anchoring.

Callers verify signatures, membership descriptors, record ancestry, and
Router bindings before entering these helpers. The helpers do not select a
public `HarnessClient` result, recovery operation, history method, or concrete
hash representation.
