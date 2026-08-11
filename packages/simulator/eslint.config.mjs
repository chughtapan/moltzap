import { packageEslintConfig } from "../../eslint.shared.mjs";

// The simulator's cluster is one implementation of a mechanism-neutral port, and
// the ADR anticipates a different scheduler behind the same boundary. That stays
// true only while the vendor SDKs are confined to their adapters: every other
// module has to be swappable without touching a Kubernetes or Temporal type.
const SOURCE = ["src/**/*.ts", "src/**/*.cts", "src/**/*.mts"];
const KUBERNETES_ADAPTER = "src/cluster/kubernetes/*.ts";
const TEMPORAL_ADAPTER = "src/cluster/temporal.ts";
const TEMPORAL_WORKFLOW = "src/cluster/reclaim.ts";
const LIVE_CLUSTER_SUITES = "src/**/*.cluster.test.ts";

const noKubernetes = {
  group: ["@kubernetes/*"],
  message: `Kubernetes objects and API calls belong in ${KUBERNETES_ADAPTER}; consume the typed helpers it exports.`,
};
const noTemporal = {
  group: ["@temporalio/*"],
  message: `Temporal clients, workers, and activities belong in ${TEMPORAL_ADAPTER}; consume the typed helpers it exports.`,
};
// `group` is matched gitignore-style, so a trailing `!` entry re-permits one
// package. Extglobs and brace expansion are silently ignored here and would
// leave the whole vendor unrestricted.
const noTemporalBesidesWorkflow = {
  group: ["@temporalio/*", "!@temporalio/workflow"],
  message: `Temporal clients, workers, and activities belong in ${TEMPORAL_ADAPTER}; only the workflow surface may appear here.`,
};

// One rule name cannot be spread across config objects: a later object replaces
// the earlier one's options rather than merging with them. So each class of file
// below restates its position on *both* vendors, and a carve-out for one SDK can
// never silently widen access to the other.
const vendorSdks = (files, patterns) => ({
  files,
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

export default [
  {
    ignores: ["nanoclaw-assets/**"],
  },
  ...packageEslintConfig({ tsconfigRootDir: import.meta.dirname }),

  // Every module reaches both vendors through an adapter.
  vendorSdks(SOURCE, [noKubernetes, noTemporal]),

  // The two adapters. Each owns exactly one vendor and is still held to the
  // boundary on the other.
  vendorSdks([KUBERNETES_ADAPTER], [noTemporal]),
  vendorSdks([TEMPORAL_ADAPTER], [noKubernetes]),

  // A Temporal workflow is defined by importing @temporalio/workflow: the SDK
  // bundles this module into its deterministic sandbox, and proxyActivities and
  // CancellationScope are the only way to declare activity stubs and a cleanup
  // scope that survives cancellation. Reaching them through the adapter instead
  // would pull that adapter's worker, client, Node, and Kubernetes surfaces into
  // the sandbox bundle, which is what the sandbox exists to forbid. The carve-out
  // is the workflow surface alone; the client and worker SDKs stay out.
  vendorSdks([TEMPORAL_WORKFLOW], [noKubernetes, noTemporalBesidesWorkflow]),

  // Live-cluster suites observe a real cluster through a client the code under
  // test does not own. Routing that observer through the adapter it exists to
  // validate would make the assertion hold whether or not the adapter works.
  vendorSdks([LIVE_CLUSTER_SUITES], [noTemporal]),
];
