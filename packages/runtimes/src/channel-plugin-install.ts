/**
 * Shared plugin-install + workspace-seed helpers consumed by every
 * runtime adapter that needs to drop a moltzap channel package onto disk
 * for an external agent runtime to load (issue #272 item 8).
 *
 * Both `openclaw-adapter` and `claude-code-adapter` install a channel
 * package into a per-agent state dir, then either copy or symlink the
 * runtime imports the package resolves at load time. The two adapters
 * differ only in:
 *   - The extension subdirectory name (`openclaw-channel` vs
 *     `claude-code-channel`).
 *   - Whether the channel package ships an additional manifest file
 *     (`openclaw.plugin.json` for openclaw; cc-channel ships none).
 *   - Which runtime modules need to resolve from the plugin's local
 *     `node_modules` (openclaw symlinks `effect`; cc-channel additionally
 *     symlinks `@modelcontextprotocol/sdk`).
 *
 * Per the "minimize tech debt" team memory: factor the shared shape out
 * now that two live adapters consume it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SpawnInput } from "./runtime.js";

export interface PluginSymlinkSpec {
  /** Path inside the plugin's `node_modules/` (e.g. `effect`, `@x/y`). */
  readonly linkPath: string;
  /**
   * Ordered candidate source paths. The first existing candidate is used.
   * Throws if none exist — surface the missing dep as a config error
   * rather than a runtime ENOENT inside the spawned subprocess.
   */
  readonly candidates: ReadonlyArray<string>;
}

export interface InstallChannelPluginOpts {
  readonly stateDir: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
  /** Subdirectory under `<stateDir>/extensions/`. */
  readonly extName: string;
  /**
   * Extra files copied verbatim from the channel package root into the
   * installed extension dir. Each entry is a basename (e.g.
   * `openclaw.plugin.json`); silently skipped if not present.
   */
  readonly extraPackageFiles?: ReadonlyArray<string>;
  /**
   * Extra symlinks to create under `<extDir>/node_modules/`. Each is
   * tried against an ordered list of candidate sources; first hit wins.
   */
  readonly extraSymlinks?: ReadonlyArray<PluginSymlinkSpec>;
}

/**
 * Install a moltzap channel package into a per-agent state dir.
 *
 * Standard layout produced:
 *   <stateDir>/extensions/<extName>/dist/...      ← copied from channelDistDir
 *   <stateDir>/extensions/<extName>/package.json  ← copied from channel pkg root
 *   <stateDir>/extensions/<extName>/node_modules/@moltzap/protocol → repoRoot/packages/protocol
 *   <stateDir>/extensions/<extName>/node_modules/@moltzap/client   → repoRoot/packages/client
 *   <stateDir>/extensions/<extName>/<extraPackageFiles[i]>         (when present)
 *   <stateDir>/extensions/<extName>/node_modules/<extraSymlinks[i].linkPath> → first existing candidate
 *
 * Returns the absolute path to the installed extension dir.
 */
export function installChannelPlugin(opts: InstallChannelPluginOpts): string {
  const extDir = path.join(opts.stateDir, "extensions", opts.extName);
  const channelPackageDir = path.dirname(opts.channelDistDir);

  // `recursive: true` creates parent dirs as needed — one mkdir is enough.
  fs.mkdirSync(extDir, { recursive: true });

  // Copy the plugin's `dist/` (skip nested node_modules + src so the copy
  // stays small and the runtime resolves through the symlinks below).
  fs.cpSync(opts.channelDistDir, path.join(extDir, "dist"), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(opts.channelDistDir, src);
      return !rel.startsWith("node_modules") && !rel.startsWith("src");
    },
  });

  // Copy package.json + any extra package-level manifests (e.g. openclaw's
  // plugin manifest). Missing extras are silently skipped — this is a
  // best-effort copy, not a hard requirement.
  const packageJsonPath = path.join(channelPackageDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    fs.copyFileSync(packageJsonPath, path.join(extDir, "package.json"));
  }
  for (const extra of opts.extraPackageFiles ?? []) {
    const src = path.join(channelPackageDir, extra);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(extDir, extra));
    }
  }

  // Standard workspace symlinks: every channel resolves @moltzap/protocol
  // and @moltzap/client at runtime. (The protocol + client packages are
  // workspace siblings; symlinking lets the plugin pick them up without
  // a redundant copy.)
  const pluginNm = path.join(extDir, "node_modules");
  fs.mkdirSync(path.join(pluginNm, "@moltzap"), { recursive: true });
  fs.symlinkSync(
    path.join(opts.repoRoot, "packages/protocol"),
    path.join(pluginNm, "@moltzap/protocol"),
    "dir",
  );
  fs.symlinkSync(
    path.join(opts.repoRoot, "packages/client"),
    path.join(pluginNm, "@moltzap/client"),
    "dir",
  );

  for (const spec of opts.extraSymlinks ?? []) {
    const linkTarget = path.join(pluginNm, spec.linkPath);
    fs.mkdirSync(path.dirname(linkTarget), { recursive: true });
    symlinkPreferring(spec.candidates, linkTarget);
  }

  return extDir;
}

/**
 * Drop SpawnInput.workspaceFiles into `<stateDir>/workspace/`. Identical
 * shape between adapters; lifted here so they share one implementation.
 */
export function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): void {
  if (workspaceFiles === undefined) {
    return;
  }
  const workspaceDir = path.join(stateDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const file of workspaceFiles) {
    const destination = path.join(workspaceDir, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
}

function symlinkPreferring(
  candidates: ReadonlyArray<string>,
  target: string,
): void {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      fs.symlinkSync(candidate, target, "dir");
      return;
    }
  }
  throw new Error(
    `channel-plugin-install: none of the candidate paths exist for ${target}: ${candidates.join(", ")}`,
  );
}
