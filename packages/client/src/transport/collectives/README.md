# Collective layer

This directory owns gather, all_gather and their answers inside the daemon:
the values carried in a post's collective part, answer validation, and the
state an operation keeps between its request posts and its result.

The service enters through `index.ts`, which exports
`operation.ts → makeCollectiveOperations`: it turns each send into posts and
each certified post into an item or nothing. Hosts and other domains read the
schema entrypoints `forms.ts` (send forms and collective errors), `inbound.ts`
(inbound items) and `message-text.ts` (the text parser) directly, so they never
load the operation layer. The other modules are private: `wire.ts` encodes and
decodes the collective part, `validation.ts` checks answers against a form,
`request-sends.ts` resolves members and settles a gather's request posts,
`received-request.ts` matches an answer to the one request open in its
conversation, and `shared-answers.ts` builds an all_gather's agreed result.
