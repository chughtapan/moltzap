#!/usr/bin/env bash
set -euo pipefail

# Lifecycle for the GKE qualification profile; see README.md. These verbs move
# the controller only. The agent pool autoscales from zero on its own.

readonly simulator_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

readonly profile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly terraform_root="$profile_root/terraform"

usage() {
  echo "usage: $0 (setup|up|run SPEC|down|delete) [--delete-artifacts]" >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
readonly command="$1"
shift

delete_artifacts=false
run_spec=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete-artifacts) delete_artifacts=true ;;
    *)
      [[ "$command" == "run" && -z "$run_spec" ]] || usage
      run_spec="$1"
      ;;
  esac
  shift
done

for executable in terraform gcloud kubectl helm docker node; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "required executable is unavailable: $executable" >&2
    exit 69
  fi
done

terraform_output() {
  terraform -chdir="$terraform_root" output -raw "$1"
}

registry_host() {
  terraform_output controller_repository | cut -d/ -f1
}

attach_kubectl() {
  gcloud container clusters get-credentials "$(terraform_output cluster_name)" \
    --zone "$(terraform_output cluster_location)" \
    --project "$(terraform_output project_id)"
}

# Scaling out of band leaves the next apply trying to undo it.
set_system_nodes() {
  terraform -chdir="$terraform_root" apply -input=false -auto-approve \
    -var="system_nodes=$1"
}

case "$command" in
  setup)
    terraform -chdir="$terraform_root" init -input=false
    terraform -chdir="$terraform_root" apply
    attach_kubectl
    "$profile_root/install-addons.sh" "$(kubectl config current-context)"

    # Experiment-grade Temporal, shared with the local profile.
    kubectl apply -f "$simulator_root/local/temporal.yaml"
    kubectl rollout status deployment/temporal -n moltzap-system --timeout=5m

    gcloud auth configure-docker "$(registry_host)" --quiet
    echo
    echo "setup complete; submit a run with '$0 run SPEC.mjs'"
    ;;

  run)
    [[ -n "$run_spec" ]] || usage
    [[ -f "$run_spec" ]] || { echo "no such run spec: $run_spec" >&2; exit 66; }
    # gke/profile.json is read from the package root, so resolve before moving.
    run_spec="$(cd "$(dirname "$run_spec")" && pwd)/$(basename "$run_spec")"
    attach_kubectl

    # The profile rejects a mutable tag, so use the digest the registry reports.
    repository="$(terraform_output controller_repository)/controller"
    built="$(node "$simulator_root/scripts/build-controller-image.mjs" \
      --repository "$repository" | tail -1)"
    tag="$(printf '%s' "$built" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).image))')"
    docker push "$tag" >/dev/null
    pinned="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
    echo "controller image: $pinned"

    kubectl port-forward -n moltzap-system svc/temporal 7233:7233 >/dev/null 2>&1 &
    readonly forward=$!
    trap 'kill "$forward" 2>/dev/null || true' EXIT
    until nc -z localhost 7233 2>/dev/null; do sleep 1; done

    cd "$simulator_root"
    MOLTZAP_KUBE_CONTEXT="$(kubectl config current-context)" \
    MOLTZAP_GKE_ARTIFACT_BUCKET="$(terraform_output artifact_bucket_name)" \
    MOLTZAP_TEMPORAL_ADDRESS="localhost:7233" \
    MOLTZAP_CONTROLLER_IMAGE="$pinned" \
    MOLTZAP_SUPPORT_IMAGE="$pinned" \
      node dist/cluster/profiles/gke.js "$run_spec"
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
    # The bucket holds run ledgers, which outlive the cluster.
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
