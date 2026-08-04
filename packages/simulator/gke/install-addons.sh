#!/usr/bin/env bash
set -euo pipefail

readonly KUEUE_VERSION="0.17.8"
readonly AGENT_SANDBOX_VERSION="v0.5.4"
readonly AGENT_SANDBOX_COMMIT="6e2b7617310e3bf084b6d1a1cffbeb141a5e37fe"
readonly AGENT_SANDBOX_REPOSITORY="https://github.com/kubernetes-sigs/agent-sandbox.git"

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 KUBE_CONTEXT" >&2
  exit 64
fi

readonly kube_context="$1"
readonly profile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/moltzap-agent-sandbox.XXXXXXXX")"

cleanup() {
  rm -r -- "$temporary_root"
}
trap cleanup EXIT

for executable in git helm; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "required executable is unavailable: $executable" >&2
    exit 69
  fi
done

git -C "$temporary_root" init --quiet
git -C "$temporary_root" remote add origin "$AGENT_SANDBOX_REPOSITORY"
git -C "$temporary_root" fetch --quiet --depth 1 origin "$AGENT_SANDBOX_COMMIT"
git -C "$temporary_root" checkout --quiet --detach FETCH_HEAD

if [[ "$(git -C "$temporary_root" rev-parse HEAD)" != "$AGENT_SANDBOX_COMMIT" ]]; then
  echo "Agent Sandbox source did not resolve to the pinned commit" >&2
  exit 65
fi

helm upgrade --install kueue \
  oci://registry.k8s.io/kueue/charts/kueue \
  --version "$KUEUE_VERSION" \
  --namespace kueue-system \
  --create-namespace \
  --kube-context "$kube_context" \
  --values "$profile_root/helm/kueue-values.yaml" \
  --atomic \
  --wait \
  --timeout 5m

# Agent Sandbox publishes a release chart in its source tree rather than a
# packaged chart artifact. The immutable release commit above is the chart
# source; Helm still owns the installed CRDs, controller, webhook, and RBAC.
helm upgrade --install agent-sandbox \
  "$temporary_root/helm" \
  --namespace agent-sandbox-system \
  --create-namespace \
  --kube-context "$kube_context" \
  --values "$profile_root/helm/agent-sandbox-values.yaml" \
  --atomic \
  --wait \
  --timeout 5m

helm upgrade --install moltzap-simulator-gke-profile \
  "$profile_root/helm/profile" \
  --namespace kueue-system \
  --kube-context "$kube_context" \
  --atomic \
  --wait \
  --timeout 5m

printf 'installed Kueue v%s, Agent Sandbox %s, and ClusterQueue/moltzap in context %s\n' \
  "$KUEUE_VERSION" "$AGENT_SANDBOX_VERSION" "$kube_context"
