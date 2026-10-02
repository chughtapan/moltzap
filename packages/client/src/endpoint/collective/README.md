# Collective layer

This directory owns gather, all_gather and their answers inside the daemon:
the values carried in a post's collective part, answer validation, and the
state an operation keeps between its request posts and its result.

Start with `operation.ts`. `makeCollectiveOperations` is the one entry the
daemon uses: it turns each send into posts and each certified post into an
item or nothing. The other modules are private to it: `wire.ts` encodes and
decodes the collective part, `validation.ts` checks answers against a form,
`request-sends.ts` resolves members and settles a gather's request posts,
`received-request.ts` matches an answer to the one request open in its
conversation, and `shared-answers.ts` builds an all_gather's agreed result.
