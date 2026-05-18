# Workspace Adapter — Binary Path Resolution

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

Both OpenClaw and ClaudeCode have `createWorkspace*` factory functions that
resolve the binary and channel dist paths from the monorepo layout at module
load time (synchronously via `Effect.runSync`).

## OpenClaw (`openclaw-adapter.ts → createWorkspaceOpenClawAdapter`)

```mermaid
flowchart TD
    OCWF["createWorkspaceOpenClawAdapter(input)<br>openclaw-adapter.ts → createWorkspaceOpenClawAdapter"]
    OCPR["resolveWorkspacePackageRoot()<br>openclaw-adapter.ts → resolveWorkspacePackageRoot<br>Walk import.meta.url ancestors until &quot;packages&quot; segment found<br>→ join(&quot;packages/runtimes&quot;)<br>Result: absolute path to packages/runtimes/"]
    OCRR["repoRoot =<br>  input.repoRoot<br>  ?? path.dirname(path.dirname(packageRoot))<br>Result: monorepo root — two dirs up from packages/runtimes"]
    OCBIN["openclawBin =<br>  input.openclawBin<br>  ?? resolveWorkspaceOpenClawBin(...)<br>    package-resolution.ts → resolveWorkspaceOpenClawBin<br>    resolveWorkspaceBin({ binName: &quot;openclaw&quot;,<br>      packageName: &quot;openclaw&quot;,<br>      packageRoot: resolveOpenClawPackageRoot() })"]
    OCSTRAT["resolveWorkspaceBin strategy<br>package-resolution.ts → resolveWorkspaceBin<br>1. createRequire(packages/runtimes/package.json)<br>   .resolve(&quot;openclaw&quot;) → resolvedFile<br>2. packageRootFromResolvedFile(resolvedFile)<br>   (walk backward to &quot;openclaw&quot; segment → package root)<br>3. packageBinTarget(root, &quot;openclaw&quot;, &quot;openclaw&quot;)<br>   reads package.json &quot;bin&quot; → absolute path to bin<br>Fallback: dependency packageRoot directly"]
    OCCH["channelDistDir =<br>  input.channelDistDir<br>  ?? path.join(repoRoot, &quot;packages/openclaw-channel/dist&quot;)"]
    OCOUT["returns new OpenClawAdapter({<br>  server, openclawBin, channelDistDir, repoRoot<br>})"]

    OCWF --> OCPR --> OCRR --> OCBIN --> OCSTRAT --> OCCH --> OCOUT
```

## ClaudeCode (`claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter`)

```mermaid
flowchart TD
    CCWF["createWorkspaceClaudeCodeAdapter(input)<br>claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter<br>(mirrors OpenClaw pattern)"]
    CCBIN["claudeBin =<br>  input.claudeBin<br>  ?? resolveWorkspaceClaudeBin(...)<br>    package-resolution.ts → resolveWorkspaceClaudeBin<br>    resolveWorkspaceBin({ binName: &quot;claude&quot;,<br>      packageName: &quot;@anthropic-ai/claude-code&quot; })"]
    CCROOT["resolveClaudeCodePackageRoot()<br>package-resolution.ts → resolveClaudeCodePackageRoot<br>imports package.json via static import assertion<br>requireFromHere.resolve(&quot;@anthropic-ai/claude-code/package.json&quot;)<br>→ dirname is the package root"]
    CCCH["channelDistDir =<br>  input.channelDistDir<br>  ?? resolveClaudeCodeChannelDistDir(repoRoot)<br>    package-resolution.ts → resolveClaudeCodeChannelDistDir"]
    CCCHTRY["Try: requireFromHere.resolve(<br>  &quot;@moltzap/claude-code-channel&quot;) → dirname/dist"]
    CCCHFALL["Fallback: repoRoot/packages/claude-code-channel/dist<br>(logs warning on fallback)"]

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
