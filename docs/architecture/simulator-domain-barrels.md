# Simulator domain-owned barrels

## Status and scope

This document is the implementation plan for simplifying the Simulator source
layout. It is not an architecture decision record and does not change the
accepted Simulator package contract. The package continues to expose exactly
four public entry points:

- `@moltzap/simulator`
- `@moltzap/simulator/network`
- `@moltzap/simulator/ledger`
- `@moltzap/simulator/agents`

The work moves each subpath entry point into the directory that owns it. It also
finishes the lifecycle and live-path validation required to ship the current
Simulator implementation. npm publication and self-contained release assembly
remain deferred.

## Problem

The pre-change source tree places `src/network.ts` beside `src/network/`, and does
the same for Ledger and Agents. The file is the public package entry point while
the directory contains the domain's source. The filesystem does not make that
distinction visible. `src/index.ts` also re-exports a curated subset of Network,
which adds a third location from which the same declaration may be discovered.

The layout has four concrete costs:

1. A cold reader cannot tell whether `network.ts` or `network/` owns Network.
2. Architecture tooling sees `network/` as a folder with no explicit API because
   its public barrel lives outside the folder.
3. Package, pack-test, API-census, and documentation paths encode a special case
   for flat facade files.
4. The layout makes it easier to confuse experiment-facing network contracts
   with private run and platform machinery.

## Goals

1. Make each public subpath owned by its domain directory.
2. Preserve every public package import, exported name, value/type partition,
   runtime key, and declaration member.
3. Give internal code one explicit domain boundary without adding compatibility
   shims.
4. Keep barrels declarative: exports only, with no lifecycle or construction
   logic.
5. Keep run orchestration and platform mechanisms private.
6. Finish all static, package, process, and live-cluster validation before the
   candidate is pushed.

## Non-goals

- Do not add an `src/api/` or `src/facades/` directory.
- Do not add or remove a public package subpath.
- Do not add, remove, rename, or deprecate a public declaration.
- Do not redesign `RunSpec`, `Network`, `Endpoint`, `LinkController`, or the
  Router fixture contracts in this change.
- Do not make private implementation modules directly importable through the
  package export map.
- Do not implement the deferred self-contained npm artifact or publish any
  package.

## Target source layout

```text
packages/simulator/src/
├── index.ts                  # @moltzap/simulator
├── network/
│   ├── index.ts              # @moltzap/simulator/network
│   ├── participant.ts
│   ├── conversation.ts
│   ├── endpoint.ts
│   ├── failure.ts
│   ├── link.ts
│   └── router.ts
├── ledger/
│   ├── index.ts              # @moltzap/simulator/ledger
│   └── ...
├── agents/
│   ├── index.ts              # @moltzap/simulator/agents
│   └── ...
├── run/                      # private run kernel
├── cluster/                  # private platform implementations
├── events/                   # event definitions
└── definition.ts             # RunSpec and Run composition
```

The package export map points each public subpath at its owning compiled barrel:

```text
.          -> dist/index.js
./network  -> dist/network/index.js
./ledger   -> dist/ledger/index.js
./agents   -> dist/agents/index.js
```

## Ownership and import rules

### Domain barrels

`network/index.ts`, `ledger/index.ts`, and `agents/index.ts` own their public
subpaths. They contain only named exports and type exports. They do not execute
code, construct services, read configuration, or register side effects.

### Package root

`src/index.ts` remains the package-root barrel. It intentionally re-exports a
curated convenience subset rather than using `export *`. The root does not become
the owner of Network, Ledger, or Agents.

### Imports inside a domain

A module inside a domain imports a sibling module directly. It does not import
its own `index.ts`, which prevents barrel-induced cycles.

### Imports across domains

Code outside a domain imports the domain barrel when it consumes a published
name. A private mechanism that is deliberately not part of a domain boundary
stays behind an explicit private port in `run/` or `cluster/`; composition roots
may import that concrete port directly rather than exporting it merely to satisfy
an internal import.

### Public consumers

Consumers import only the four package subpaths. `dist/**` and
`@moltzap/simulator/<domain>/<file>` are not public contracts.

## Compatibility invariants

The migration is complete only when all of these remain true:

1. `packages/simulator/package.json` exposes exactly `.`, `./network`,
   `./ledger`, and `./agents`.
2. `packages/simulator/api-census.json` retains the exact checked-in declaration
   names, type-space names, and value-space names for all four subpaths.
3. Runtime imports of all four packed subpaths return the exact current key sets.
4. Strict downstream TypeScript imports compile from an isolated packed install.
5. The five admitted Simulator API removals remain absent.
6. Cross-owner Identity types remain assignable through the Simulator facades.
7. No flat `src/network.ts`, `src/ledger.ts`, or `src/agents.ts` compatibility
   shim remains.
8. No new public name is introduced to compensate for the move.

## Implementation sequence

### 1. Move the entry points

- Create `network/index.ts` from the exact export list in `src/network.ts` and
  make its relative imports domain-local.
- Create `ledger/index.ts` from the exact export list in `src/ledger.ts`.
- Create `agents/index.ts` from the exact export list in `src/agents.ts`.
- Delete the three flat source entry files.
- Update `src/index.ts` and every package-internal consumer of published names to
  the domain-owned barrel paths. Keep exact private-port and adapter-selection
  imports concrete at their owning composition roots.

### 2. Update package and compatibility machinery

- Point the package export map at `dist/<domain>/index.{js,d.ts}`.
- Update the package-export test, the immutable API census declaration paths,
  the packed-package verifier, and its isolated consumer.
- Update the exact-seven boundary gate and architecture configuration generator.
- Regenerate the checked-in architecture config rather than hand-editing its
  generated output.
- Update source-path assertions and documentation that describe the four
  facades.

### 3. Close source-lifecycle blockers

The barrel move does not make known lifecycle defects acceptable. Before the
candidate freezes:

- Make controlled-daemon acquisition atomically transfer ownership to a Scope,
  so interruption cannot leak a child process between startup and finalizer
  registration.
- Make Router fault-proxy listener acquisition atomically scoped.
- Supervise post-bind proxy errors and unexpected closure through the run's typed
  failure channel.
- Supervise each LinkFabric route worker so a defecting policy closes pending
  route operations with `NetworkError` instead of hanging.
- Remove the unused duplicate private delivery interpreter if its public
  compatibility type can remain without a second runtime path.

### 4. Complete composed-kernel coverage

Add direct composed tests for:

- program success and failure;
- caller interruption, durable finalization, and re-interruption;
- ledger allocation, append, and completion failure;
- cluster preparation and session failure;
- roster acquisition failure;
- controlled-daemon and proxy interruption-at-handoff;
- proxy post-bind failure;
- a defecting link policy and route-worker termination.

### 5. Regenerate derived surfaces

After source and tests stabilize:

- Run the canonical architecture-config generator.
- Run the canonical documentation generator exactly once.
- Verify generated module documentation, source links, constants, and import
  resolution.
- Do not hand-edit generated `MODULE.md` or generated module MDX pages.

### 6. Qualify the real data path

Build the final controller image and run an isolated local cluster whose
artifact mount and kube context belong to this worktree. The live scenario must:

1. start the Registry, Router, fault proxy, three endpoint daemons, and two
   autonomous runtimes plus one controller-owned endpoint;
2. send a real addressed DM and fixed-group post through the public
   Client/daemon boundary;
3. prove an unfaulted addressed conversation completes while another
   recipient is held,
   with unit coverage retaining the exact-byte and order invariant;
4. install one directed hold or delay through `LinkController`;
5. prove an unrelated sender can progress while the fault is active;
6. release the fault and observe the retained delivery;
7. inspect the completed run ledger and teardown all run-owned resources.

The qualification uses a new isolated cluster or kubeconfig. It does not delete
or repurpose another worktree's cluster.

### 7. Freeze and ship

- Verify the branch still contains the pinned final `main` integration required
  by the cutover contract. Classify every later `main` commit for deliberate
  porting; do not perform a routine forward merge after the freeze.
- Keep the post-freeze v1 release-only commit out of the candidate because it
  changes only retired or deliberately deferred publication/version surfaces.
- Rerun every final gate after lineage is settled and generated artifacts settle.
- Run the required pre-landing engineering review and address all blocking
  findings.
- Commit logical units with named paths, push without force, and open the cutover
  pull request.
- Keep release automation disabled or non-publishing until the separate package
  publication decision is made.

## Verification matrix

| Surface | Required evidence |
|---|---|
| Source layout | Flat facade files absent; three domain `index.ts` barrels present |
| Public API | Exact four-key export map and exact checked-in API census |
| Compile | Simulator build and test typecheck through Nx |
| Unit/integration | Full Simulator Vitest target through Nx |
| Packaging | Simulator packed isolated-consumer target through Nx |
| Architecture | Simulator architecture check and exact-seven workspace boundary gate |
| Lint/format | Simulator lint, repository formatter, and diff whitespace checks |
| Documentation | Canonical generation, drift, imports, Mermaid, and gate-document checks |
| Profiles | Local and GKE static profile checks |
| Processes | Client and workspace real-daemon integration targets |
| Live platform | Isolated local-cluster traffic, directed fault, ledger, and teardown scenario |
| Landing | Pinned-main lineage and reviewed non-ports, fresh review, final clean verification, pushed PR |

## Definition of done

The work is done when a cold reader can find every public Simulator subpath by
opening the matching domain directory, the public API and package behavior are
unchanged, all lifecycle failures terminate through typed channels, the complete
test and package matrix is green, the real local fault path is demonstrated, and
the reviewed candidate is available as a pull request. Package publication is not
part of this definition.
