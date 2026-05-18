# Workspace Adapter — Binary Path Resolution

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

Both OpenClaw and ClaudeCode have `createWorkspace*` factory functions that
resolve the binary and channel dist paths from the monorepo layout at module
load time (synchronously via `Effect.runSync`).

## OpenClaw (`openclaw-adapter.ts → createWorkspaceOpenClawAdapter`)

```mermaid
flowchart TD
    OCWF["createWorkspaceOpenClawAdapter(input)\nopenclaw-adapter.ts → createWorkspaceOpenClawAdapter"]
    OCPR["resolveWorkspacePackageRoot()\nopenclaw-adapter.ts → resolveWorkspacePackageRoot\nWalk import.meta.url ancestors until &quot;packages&quot; segment found\n→ join(&quot;packages/runtimes&quot;)\nResult: absolute path to packages/runtimes/"]
    OCRR["repoRoot =\n  input.repoRoot\n  ?? path.dirname(path.dirname(packageRoot))\nResult: monorepo root — two dirs up from packages/runtimes"]
    OCBIN["openclawBin =\n  input.openclawBin\n  ?? resolveWorkspaceOpenClawBin(...)\n    package-resolution.ts → resolveWorkspaceOpenClawBin\n    resolveWorkspaceBin({ binName: &quot;openclaw&quot;,\n      packageName: &quot;openclaw&quot;,\n      packageRoot: resolveOpenClawPackageRoot() })"]
    OCSTRAT["resolveWorkspaceBin strategy\npackage-resolution.ts → resolveWorkspaceBin\n1. createRequire(packages/runtimes/package.json)\n   .resolve(&quot;openclaw&quot;) → resolvedFile\n2. packageRootFromResolvedFile(resolvedFile)\n   (walk backward to &quot;openclaw&quot; segment → package root)\n3. packageBinTarget(root, &quot;openclaw&quot;, &quot;openclaw&quot;)\n   reads package.json &quot;bin&quot; → absolute path to bin\nFallback: dependency packageRoot directly"]
    OCCH["channelDistDir =\n  input.channelDistDir\n  ?? path.join(repoRoot, &quot;packages/openclaw-channel/dist&quot;)"]
    OCOUT["returns new OpenClawAdapter({\n  server, openclawBin, channelDistDir, repoRoot\n})"]

    OCWF --> OCPR --> OCRR --> OCBIN --> OCSTRAT --> OCCH --> OCOUT
```

## ClaudeCode (`claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter`)

```mermaid
flowchart TD
    CCWF["createWorkspaceClaudeCodeAdapter(input)\nclaude-code-adapter.ts → createWorkspaceClaudeCodeAdapter\n(mirrors OpenClaw pattern)"]
    CCBIN["claudeBin =\n  input.claudeBin\n  ?? resolveWorkspaceClaudeBin(...)\n    package-resolution.ts → resolveWorkspaceClaudeBin\n    resolveWorkspaceBin({ binName: &quot;claude&quot;,\n      packageName: &quot;@anthropic-ai/claude-code&quot; })"]
    CCROOT["resolveClaudeCodePackageRoot()\npackage-resolution.ts → resolveClaudeCodePackageRoot\nimports package.json via static import assertion\nrequireFromHere.resolve(&quot;@anthropic-ai/claude-code/package.json&quot;)\n→ dirname is the package root"]
    CCCH["channelDistDir =\n  input.channelDistDir\n  ?? resolveClaudeCodeChannelDistDir(repoRoot)\n    package-resolution.ts → resolveClaudeCodeChannelDistDir"]
    CCCHTRY["Try: requireFromHere.resolve(\n  &quot;@moltzap/claude-code-channel&quot;) → dirname/dist"]
    CCCHFALL["Fallback: repoRoot/packages/claude-code-channel/dist\n(logs warning on fallback)"]

    CCWF --> CCBIN --> CCROOT --> CCCH
    CCCH --> CCCHTRY
    CCCH --> CCCHFALL
```

## PATH-Based (Non-Workspace) Variant

Pass explicit `openclawBin`/`claudeBin`/`channelDistDir` to the constructor
directly. The "workspace" factory is simply a convenience that resolves all
three from the monorepo at construction time rather than requiring callers to
compute paths themselves.

## See Also

- [Per-Adapter Spawn Details](./03-per-adapter-spawn.md)
