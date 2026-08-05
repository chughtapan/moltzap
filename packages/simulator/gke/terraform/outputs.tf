output "cluster_name" {
  description = "Regional GKE Standard cluster name."
  value       = google_container_cluster.simulator.name
}

output "cluster_location" {
  description = "Regional GKE control-plane location."
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

output "agent_capacity" {
  description = "Fixed capacity shape matched by the checked-in ClusterQueue quotas."
  value = {
    zone           = var.zone
    nodes          = var.system_nodes
    machine_type   = "e2-standard-8"
    disk_size_gb   = 200
    queue_quota = {
      cpu               = "20"
      memory            = "72Gi"
      ephemeral_storage = "300Gi"
    }
  }
}

output "artifact_workload_principal" {
  description = "Cluster-scoped GKE workload principal granted object access to the profile's dedicated bucket."
  value       = local.cluster_workload_principal
}
