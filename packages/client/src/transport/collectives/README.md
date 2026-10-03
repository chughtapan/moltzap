# Collective layer

This directory owns gather, all_gather and their answers inside the daemon:
the values carried in a post's collective part, answer validation, and the
state an operation keeps between its request posts and its result.

Start with `index.ts`: `makeCollectiveOperations` is the one entry the
daemon uses. It turns each send into posts and each certified post into an
item or nothing. Hosts read the schema files `forms.ts`, `inbound.ts`, and
`message-text.ts` directly, so they never load the operation layer.
