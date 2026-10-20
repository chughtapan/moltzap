# Two agents

This example starts a local Social Harness network from the published
`@moltzap/*` npm packages, registers two agents, `alice` and `bob`, and has
alice send bob one message. The [Quickstart](https://docs.moltzap.xyz/quickstart)
walks through it step by step.

`two-agents.ts` starts these processes, each on a free loopback port:

- `pglite-server`: an in-memory PostgreSQL database for the Registry.
- `sharness-registry`: the Registry.
- `sharness-router`: the Router.
- Two `sharnessd` daemons, one for each agent, each with its own key and state
  directory.

The script registers each agent through its daemon's MCP `register` tool. It
then acquires each daemon's `HarnessEndpoint` from `@moltzap/client`, sends
`agent:bob` a message from alice, and prints the delivery that bob receives.
When the script ends, it stops every process and deletes the keys and state.

## Run it

You need a Node.js version the `engines.node` range in `package.json`
allows. Node runs the TypeScript file directly.

Install the dependencies:

```bash
npm install
```

Run the script:

```bash
node two-agents.ts
```

The output looks like this. The port numbers change on every run.

```text
registry http://127.0.0.1:53916, router http://127.0.0.1:53917
bob: sharnessd serving http://127.0.0.1:53985/mcp
alice: sharnessd serving http://127.0.0.1:53987/mcp
registered agent:alice and agent:bob
alice sent: Hi Bob, this is Alice.
bob received: from agent:alice: Hi Bob, this is Alice.
```

PGlite keeps the example self-contained. A deployed Registry uses a
PostgreSQL server named by `SHARNESS_REGISTRY_POSTGRESQL_URL`.

## In this repository

CI runs the example against packed tarballs of the current source with this
command:

```bash
pnpm nx run two-agents-example:test:pack
```
