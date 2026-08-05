#!/usr/bin/env bash
set -euo pipefail

# Lifecycle for the GKE qualification profile; see README.md. These verbs move
# the controller only. The agent pool autoscales from zero on its own.

readonly profile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly terraform_root="$profile_root/terraform"

usage() {
  echo "usage: $0 (setup|up|down|delete) [--delete-artifacts]" >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
readonly command="$1"
shift

delete_artifacts=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete-artifacts) delete_artifacts=true ;;
    *) usage ;;
  esac
  shift
done

for executable in terraform gcloud kubectl helm; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "required executable is unavailable: $executable" >&2
    exit 69
  fi
done

terraform_output() {
  terraform -chdir="$terraform_root" output -raw "$1"
}

attach_kubectl() {
  gcloud container clusters get-credentials "$(terraform_output cluster_name)" \
    --zone "$(terraform_output cluster_location)" \
    --project "$(terraform_output project_id)"
}

# Terraform owns the system pool's size, so scaling through it keeps state
# truthful. Resizing out of band leaves the next apply trying to undo it.
set_system_nodes() {
  terraform -chdir="$terraform_root" apply -input=false -auto-approve \
    -var="system_nodes=$1"
}

case "$command" in
  setup)
    # Creating the substrate is the slow, billable step, so it keeps
    # Terraform's interactive approval rather than assuming consent.
    terraform -chdir="$terraform_root" init -input=false
    terraform -chdir="$terraform_root" apply
    attach_kubectl
    "$profile_root/install-addons.sh" "$(kubectl config current-context)"
    echo
    echo "setup complete; the controller is online and agents scale on demand"
    ;;

  up)
    set_system_nodes 1
    attach_kubectl
    kubectl wait --for=condition=Ready nodes \
      -l "moltzap.dev/pool=system" --timeout=5m
    kubectl rollout status deployment/run-worker -n moltzap-system --timeout=5m
    echo "controller is online"
    ;;

  down)
    attach_kubectl
    in_flight="$(kubectl get workloads.kueue.x-k8s.io --all-namespaces \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$in_flight" != "0" ]]; then
      echo "refusing to park the controller: $in_flight workload(s) in flight." >&2
      kubectl get workloads.kueue.x-k8s.io --all-namespaces >&2
      exit 65
    fi
    set_system_nodes 0
    echo "controller is parked; the cluster and its addons remain"
    ;;

  delete)
    # The bucket holds run ledgers and evaluation artifacts, which are the
    # output of the experiments rather than part of the cluster.
    bucket="$(terraform_output artifact_bucket_name)"
    if [[ "$delete_artifacts" != true ]]; then
      objects="$(gcloud storage ls --recursive "gs://$bucket/**" 2>/dev/null | wc -l | tr -d ' ')"
      if [[ "$objects" != "0" ]]; then
        echo "refusing to destroy: gs://$bucket holds $objects object(s)." >&2
        echo "Copy them out first:" >&2
        echo "  gcloud storage cp --recursive 'gs://$bucket/*' ./artifacts/" >&2
        echo "or re-run with --delete-artifacts to discard them." >&2
        exit 65
      fi
    fi
    terraform -chdir="$terraform_root" destroy
    ;;

  *) usage ;;
esac
