# Protocol source boundary

This tree owns MoltZap's wire contracts and endpoint socket machinery.

- Domain folders define branded values, RPC and notification descriptors,
  requirement tags, and domain error schemas.
- `transport/` supplies content-neutral descriptor, decoding, dispatch, mux,
  pagination, and wire-error primitives.
- `socket/` composes the catalogs into agent, app, and server endpoint
  lifecycles.
- `testing/` contains protocol fixtures and reusable conformance suites.

The protocol declares calls and guarantees. Handler implementations,
persistence, and runtime policy belong to consuming packages. Root and subpath
barrels expose curated surfaces instead of publishing implementation files
individually.
