# Registry client and contract

The public Registry capability in `../registry.ts` owns bootstrap registration,
immutable card lookup, listing, and closed client failures. `contract.ts` owns
the exact shared request and response representations. The private
`@moltzap/registry` workspace package owns the service process and persistence.
