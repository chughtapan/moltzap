# Workspace Adapter — Binary Path Resolution

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

Both OpenClaw and ClaudeCode have `createWorkspace*` factory functions that
resolve the binary and channel dist paths from the monorepo layout at module
load time (synchronously via `Effect.runSync`).

## OpenClaw (`openclaw-adapter.ts → createWorkspaceOpenClawAdapter`)

```text
createWorkspaceOpenClawAdapter(input)                  openclaw-adapter.ts → createWorkspaceOpenClawAdapter
  │
  ├─ resolveWorkspacePackageRoot()                     openclaw-adapter.ts → resolveWorkspacePackageRoot
  │    Walk import.meta.url ancestors until a segment
  │    named "packages" is found → join("packages/runtimes")
  │    (Result: absolute path to packages/runtimes/)
  │
  ├─ repoRoot = input.repoRoot
  │             ?? path.dirname(path.dirname(packageRoot))
  │             (Result: monorepo root — two dirs up from packages/runtimes)
  │
  ├─ openclawBin = input.openclawBin
  │                ?? resolveWorkspaceOpenClawBin(...)   package-resolution.ts → resolveWorkspaceOpenClawBin
  │                     resolveWorkspaceBin({
  │                       binName: "openclaw",
  │                       packageName: "openclaw",
  │                       packageRoot: resolveOpenClawPackageRoot()
  │                     })
  │                   Strategy (package-resolution.ts → resolveWorkspaceBin):
  │                     1. createRequire(packages/runtimes/package.json)
  │                        .resolve("openclaw")  → resolvedFile
  │                     2. packageRootFromResolvedFile(resolvedFile)
  │                        (walks resolved path backward to find
  │                         the "openclaw" segment → package root)
  │                     3. packageBinTarget(root, "openclaw", "openclaw")
  │                        reads package.json "bin" → absolute path to bin
  │                     Fallback: dependency packageRoot directly
  │
  ├─ channelDistDir = input.channelDistDir
  │                   ?? path.join(repoRoot,
  │                        "packages/openclaw-channel/dist")
  │
  └─ returns new OpenClawAdapter({ server, openclawBin,
                                   channelDistDir, repoRoot })
```

## ClaudeCode (`claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter`)

```text
createWorkspaceClaudeCodeAdapter(input)                claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter
  │  (mirrors OpenClaw pattern)
  │
  ├─ claudeBin = input.claudeBin
  │              ?? resolveWorkspaceClaudeBin(...)       package-resolution.ts → resolveWorkspaceClaudeBin
  │                   resolveWorkspaceBin({
  │                     binName: "claude",
  │                     packageName: "@anthropic-ai/claude-code"
  │                   })
  │                   resolveClaudeCodePackageRoot():    package-resolution.ts → resolveClaudeCodePackageRoot
  │                     imports package.json via static import assertion
  │                     requireFromHere.resolve("@anthropic-ai/claude-code/package.json")
  │                     → dirname is the package root
  │
  └─ channelDistDir = input.channelDistDir
                      ?? resolveClaudeCodeChannelDistDir(repoRoot)
                           package-resolution.ts → resolveClaudeCodeChannelDistDir
                         Try: requireFromHere.resolve(
                           "@moltzap/claude-code-channel") → dirname/dist
                         Fallback: repoRoot/packages/claude-code-channel/dist
                         (logs warning on fallback)
```

## PATH-Based (Non-Workspace) Variant

Pass explicit `openclawBin`/`claudeBin`/`channelDistDir` to the constructor
directly. The "workspace" factory is simply a convenience that resolves all
three from the monorepo at construction time rather than requiring callers to
compute paths themselves.

## See Also

- [Per-Adapter Spawn Details](./03-per-adapter-spawn.md)
