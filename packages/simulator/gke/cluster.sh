#!/usr/bin/env bash
set -euo pipefail

# Lifecycle for the GKE qualification profile; see README.md. These verbs move
# the controller only. The agent pool autoscales from zero on its own.

readonly profile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly simulator_root="$(cd "$profile_root/.." && pwd)"
readonly workspace_root="$(cd "$simulator_root/../.." && pwd)"
readonly terraform_root="$profile_root/terraform"
readonly system_namespace="moltzap-system"

usage() {
  echo "usage: $0 (setup|up|run SPEC|publish-image|down|delete)" >&2
  echo "       [--delete-artifacts]" >&2
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

for executable in terraform gcloud kubectl helm docker node nc; do
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

absolute_path() {
  echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
}

# process.stdout.write rather than console.log, which inspects and colours a
# number when FORCE_COLOR is set.
free_local_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => process.stdout.write(String(port)));
    });
  '
}

read_json_field() {
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () =>
      process.stdout.write(String(JSON.parse(input)[process.argv[1]])),
    );
  ' "$1"
}

# The profile rejects a mutable tag, so the digest comes from the registry:
# `--push` reports the manifest digest the registry assigned to the build.
publish_controller_image() {
  local repository
  repository="$(terraform_output controller_repository)/controller"
  node "$workspace_root/scripts/simulator/build-controller-image.mjs" \
    --repository "$repository" --push | tail -1 | read_json_field pinnedImage
}

# A fixed port would be inherited from an abandoned forward, which still accepts
# connections while proxying to a pod that no longer exists. A single forward
# also does not outlive a long run, so losing it would report a run that is
# still going as failed.
open_temporal_forward() {
  local port="$1"
  # errexit is inherited by the subshell, so without disabling it the first
  # dropped forward would end the loop that exists to replace it.
  (
    set +e
    while true; do
      kubectl port-forward -n "$system_namespace" svc/temporal "${port}:7233" \
        >/dev/null 2>&1
      sleep 1
    done
  ) &
  forward_pid=$!
  # The supervisor outlives any one forward, so its liveness proves nothing.
  # A parked controller has no Temporal to reach, and waiting on that forever
  # is indistinguishable from working.
  local attempt=0
  until nc -z localhost "$port" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge 60 ]]; then
      echo "Temporal did not accept a connection within 60s." >&2
      echo "Is the controller parked? Bring it back with '$0 up'." >&2
      exit 69
    fi
    sleep 1
  done
}

# Everything `run` needs before it can reach the cluster: credentials, an
# immutable controller image, and a Temporal endpoint that survives a dropped
# forward.
begin_cluster_session() {
  attach_kubectl

  controller_image="$(publish_controller_image)"
  echo "controller image: $controller_image"

  forward_port="$(free_local_port)"
  trap 'kill "${forward_pid:-}" 2>/dev/null;
        pkill -f "port-forward -n $system_namespace svc/temporal ${forward_port}:" 2>/dev/null;
        true' EXIT
  open_temporal_forward "$forward_port"
}

discard_artifacts() {
  local bucket="$1"
  # The bucket refuses to be destroyed while it holds objects, so discarding
  # them is what makes the flag mean what it says.
  gcloud storage rm --recursive "gs://$bucket/**" 2>/dev/null || true
}

require_empty_artifact_bucket() {
  local bucket="$1" objects
  # A wildcard that matches nothing exits non-zero, which is the empty bucket
  # this guard exists to wave through.
  objects="$(gcloud storage ls --recursive "gs://$bucket/**" 2>/dev/null \
    | wc -l | tr -d ' ' || true)"
  [[ -z "$objects" || "$objects" == "0" ]] && return 0
  echo "refusing to destroy: gs://$bucket holds $objects object(s)." >&2
  echo "Copy them out first:" >&2
  echo "  gcloud storage cp --recursive 'gs://$bucket/*' ./artifacts/" >&2
  echo "or re-run with --delete-artifacts to discard them." >&2
  exit 65
}

case "$command" in
  setup)
    terraform -chdir="$terraform_root" init -input=false
    terraform -chdir="$terraform_root" apply
    attach_kubectl
    "$profile_root/install-addons.sh" "$(kubectl config current-context)"

    # Experiment-grade Temporal, shared with the local profile.
    kubectl apply -f "$simulator_root/local/temporal.yaml"
    kubectl rollout status deployment/temporal -n "$system_namespace" --timeout=5m

    gcloud auth configure-docker "$(registry_host)" --quiet
    echo
    echo "setup complete; submit a run with '$0 run SPEC.mjs'"
    ;;

  publish-image)
    # The digest the profile's images must be pinned to, on stdout alone, so a
    # caller can assign it: MOLTZAP_CONTROLLER_IMAGE="$(... publish-image)".
    publish_controller_image
    ;;

  run)
    [[ -n "$run_spec" ]] || usage
    [[ -f "$run_spec" ]] || { echo "no such run spec: $run_spec" >&2; exit 66; }
    # The executable is invoked from the package root, so the spec path must
    # survive the move.
    run_spec="$(absolute_path "$run_spec")"
    begin_cluster_session

    cd "$simulator_root"
    MOLTZAP_KUBE_CONTEXT="$(kubectl config current-context)" \
    MOLTZAP_GKE_ARTIFACT_BUCKET="$(terraform_output artifact_bucket_name)" \
    MOLTZAP_TEMPORAL_ADDRESS="localhost:${forward_port}" \
    MOLTZAP_CONTROLLER_IMAGE="$controller_image" \
    MOLTZAP_SUPPORT_IMAGE="$controller_image" \
      node bin/moltzap-sim run --profile gke "$run_spec"
    ;;

  up)
    set_system_nodes 1
    attach_kubectl
    kubectl wait --for=condition=Ready nodes \
      -l "moltzap.dev/pool=system" --timeout=5m
    # The worker is installed by a submission, carrying the image that
    # submission chose, so a cluster that has never run one has no worker yet.
    if kubectl get deployment/run-worker -n "$system_namespace" \
      >/dev/null 2>&1; then
      kubectl rollout status deployment/run-worker \
        -n "$system_namespace" --timeout=5m
    fi
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
    if [[ "$delete_artifacts" == true ]]; then
      discard_artifacts "$bucket"
    else
      require_empty_artifact_bucket "$bucket"
    fi
    terraform -chdir="$terraform_root" destroy
    ;;

  *) usage ;;
esac
