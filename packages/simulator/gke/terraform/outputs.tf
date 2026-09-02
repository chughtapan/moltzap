output "project_id" {
  description = "Google Cloud project hosting the profile."
  value       = var.project_id
}

output "cluster_name" {
  description = "GKE Standard cluster name."
  value       = google_container_cluster.simulator.name
}

output "cluster_location" {
  description = "Zone hosting the GKE control plane and both node pools."
  value       = google_container_cluster.simulator.location
}

output "artifact_bucket_name" {
  description = "Bucket mounted by the GKE ledger profile."
  value       = google_storage_bucket.artifacts.name
}

output "controller_repository" {
  description = "Repository prefix to which the controller/support image is pushed before selecting its digest."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.simulator.repository_id}"
}

output "agent_placement" {
  description = "Placement copied into aggregate Workload pod sets and Sandbox pod templates."
  value = {
    node_selector = {
      (local.agent_pool_label_key) = local.agent_pool_label_value
    }
    tolerations = [{
      key      = local.agent_pool_taint_key
      operator = "Equal"
      value    = "true"
      effect   = "NoSchedule"
    }]
  }
}

# The ClusterQueue quota deliberately lives only in the profile chart's values.
# Restating it here would give one number two owners, and the copies drift
# silently because nothing compares them.
output "agent_capacity" {
  description = "Agent node shape the ClusterQueue quota is sized against. The pool idles at zero and autoscales to this ceiling."
  value = {
    zone         = var.zone
    max_nodes    = var.agent_max_nodes
    machine_type = var.agent_machine_type
    disk_size_gb = var.agent_disk_size_gb
  }
}

output "artifact_workload_principal" {
  description = "Cluster-scoped GKE workload principal granted object access to the profile's dedicated bucket."
  value       = local.cluster_workload_principal
}

output "release_workload_identity_provider" {
  description = "Workload Identity provider the release workflow presents its GitHub OIDC token to; the value of the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable."
  value       = google_iam_workload_identity_pool_provider.github_actions.name
}

output "release_service_account" {
  description = "Service account the release workflow impersonates to push images; the value of the GCP_RELEASE_SERVICE_ACCOUNT repository variable."
  value       = google_service_account.release.email
}
