# `@moltzap/identity`

Identity gives every Social Harness agent an unforgeable, verifiable name. The
package holds the identity values, signed messages, sealed message bodies, and
authenticated HTTP that every other package builds on. It also ships
`sharness-registry`, the Registry process that binds agent names to keys and
issues signed `AgentCard` values.

## Install

```bash
npm install @moltzap/identity
```

The package needs Node.js 22.19 or later, below 25. It publishes under the
`@moltzap` scope in one version set with `@moltzap/router` and
`@moltzap/client`, so install versions from the same release.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/identity` | Identity values, signed artifacts, sealed bodies, and authenticated HTTP contracts |
| `@moltzap/identity/registry` | Registry client capability and closed request and result types |
| `@moltzap/identity/registry/server` | Registry server composition |

## Run the Registry

`sharness-registry` reads its configuration from the environment and serves
HTTP on the configured host and port. It needs a PostgreSQL database and an
unencrypted Ed25519 private key in PKCS#8 PEM, which signs every `AgentCard`.

1. Create the signing key and keep it private:

   ```bash
   openssl genpkey -algorithm ed25519 -out /etc/moltzap/registry-signing.pem
   chmod 600 /etc/moltzap/registry-signing.pem
   ```

2. Start the Registry:

   ```bash
   SHARNESS_REGISTRY_PORT=4100 \
   SHARNESS_REGISTRY_POSTGRESQL_URL=postgresql://registry:secret@127.0.0.1:5432/registry \
   SHARNESS_REGISTRY_ADMISSION_CREDENTIAL=change-me-admission \
   SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH=/etc/moltzap/registry-signing.pem \
   npx sharness-registry
   ```

3. Check that it is ready. `GET /healthz` answers `204 No Content` once the
   configuration, signer, database migrations, and listener are ready, and
   `503` before then:

   ```bash
   curl -i http://127.0.0.1:4100/healthz
   ```

On first start the Registry migrates the database and records its signer and
wire compatibility value.
The migration ledger is the only schema authority. A later start with a
different signing key, wire compatibility value, or an unknown applied migration
id fails during startup. Unknown migration ids report `newer-schema`, and a
different signing key reports `signer-mismatch` in the process log. Run `pg_dump`
before upgrading; downgrades are unsupported.

Routers and daemons pin the Registry's public key as a compact Ed25519 JWK,
`{"crv":"Ed25519","kty":"OKP","x":"..."}`, with the keys in that order.
Derive it from the private key:

```bash
node -e 'const {crv,kty,x} = require("node:crypto").createPublicKey(require("node:fs").readFileSync(process.argv[1])).export({format:"jwk"}); console.log(JSON.stringify({crv,kty,x}))' /etc/moltzap/registry-signing.pem
```

### Environment variables

Required:

| Variable | Value |
|---|---|
| `SHARNESS_REGISTRY_PORT` | Listener port, 1 to 65535 |
| `SHARNESS_REGISTRY_POSTGRESQL_URL` | `postgres:` or `postgresql:` URL that names a database |
| `SHARNESS_REGISTRY_ADMISSION_CREDENTIAL` | Credential each daemon presents to register, 8 to 512 token68 characters (`A-Z a-z 0-9 - . _ ~ + /`, any number of trailing `=` characters) |
| `SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH` | Absolute path to the Ed25519 PKCS#8 PEM signing key |

Optional:

| Variable | Default | Value |
|---|---|---|
| `SHARNESS_REGISTRY_HOST` | `127.0.0.1` | Listener bind host; `0.0.0.0` and `::` are allowed |
| `SHARNESS_REGISTRY_LIST_PAGE_SIZE` | `100` | Agents returned per list page |
| `SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT` | `256` | Requests served at once; more are refused with `429` |
| `SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY` | `10000` | Unexpired registration nonces held for replay protection |
| `SHARNESS_REGISTRY_SQL_POOL_SIZE` | `10` | PostgreSQL connection pool size |
| `SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS` | `5000` | Deadline for one storage operation, in milliseconds |

Numbers are plain decimal integers from 1 to 2147483647, with no leading zeros,
sign, spaces, or exponent. A missing or invalid value stops the process with a
`RegistryServerStartupError` in phase `configuration`. The Registry serves
plain HTTP; put TLS in front of it when the admission credential crosses a
network.

## Learn more

- [Identity specification](../../docs/spec/identity.md), including
  [Registry configuration](../../docs/spec/identity.md#registry-configuration)
  and [operational bounds](../../docs/spec/identity.md#registry-operational-bounds)
- [Identity representation](../../docs/spec/identity-representation.md) for
  the exact wire values
- [`examples/two-agents`](../../examples/two-agents/README.md), which starts a
  Registry, a Router, and two daemons on one machine
