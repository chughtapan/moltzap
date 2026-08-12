# Conversation history

This folder owns package-private, representation-neutral laws for endpoint
conversation history:

- durability threshold arithmetic;
- single-candidate staging and mergeable fixed-member vote evidence for Router
  re-anchors;
- quorum-gated current-anchor plans carrying an independent complete evidence
  snapshot;
- mergeable fixed-member durability-vote progress retaining complete verified
  evidence by signer;
- fail-closed selection of one verified descendant head before re-anchoring;
- head-bound single-child staging before an honest member may sign an
  action-certified record;
- nonempty, contiguous, duplicate-free certified catch-up suffix plans for one
  atomic local transaction without runtime attention;
  and
- predecessor- and quorum-gated plans carrying complete evidence into atomic
  certified-head advancement.

Callers verify signatures, membership descriptors, record ancestry, and
Router bindings before entering these helpers. The helpers do not select a
public `HarnessClient` result, recovery operation, history method, or concrete
hash representation.
