# Contact services

This folder implements contact request, acceptance, and listing behavior.
`ContactsService` owns database-backed state transitions, `handlers.ts` adapts
the contact RPCs and notifications, and `layer.ts` exposes the service.

`contact-policy.ts` is the narrow reach-policy contract consumed by app
endpoint routing; `webhook-contact-service.ts` provides its fail-closed remote
implementation. Contact wire schemas and errors remain in
`@moltzap/protocol/identity`.
