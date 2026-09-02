locals {
  required_services = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])

  agent_pool_label_key   = "moltzap.dev/pool"
  agent_pool_label_value = "agents"
  agent_pool_taint_key   = "moltzap.dev/agents"
  system_pool_label      = "system"

  cluster_workload_principal = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/kubernetes.cluster/https://container.googleapis.com/v1/projects/${var.project_id}/locations/${var.zone}/clusters/${var.cluster_name}"
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "simulator" {
  name                    = var.network_name
  project                 = var.project_id
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "simulator" {
  name          = var.network_name
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.simulator.id
  ip_cidr_range = var.subnetwork_cidr

  secondary_ip_range {
    range_name    = "moltzap-pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "moltzap-services"
    ip_cidr_range = var.services_cidr
  }
}

resource "google_service_account" "nodes" {
  project      = var.project_id
  account_id   = "moltzap-gke-nodes"
  display_name = "MoltZap simulator GKE nodes"

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "node_runtime" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_service_account_iam_member" "gke_uses_node_identity" {
  service_account_id = google_service_account.nodes.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:service-${data.google_project.current.number}@container-engine-robot.iam.gserviceaccount.com"
}

resource "google_artifact_registry_repository" "simulator" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository_id
  description   = "Immutable MoltZap simulator controller and support images"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "node_image_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.simulator.location
  repository = google_artifact_registry_repository.simulator.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_storage_bucket" "artifacts" {
  project                     = var.project_id
  name                        = var.artifact_bucket_name
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  hierarchical_namespace {
    enabled = true
  }

  depends_on = [google_project_service.required]
}

resource "google_container_cluster" "simulator" {
  project  = var.project_id
  name     = var.cluster_name
  location = var.zone

  network    = google_compute_network.simulator.id
  subnetwork = google_compute_subnetwork.simulator.id

  networking_mode          = "VPC_NATIVE"
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = var.deletion_protection

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "moltzap-pods"
    services_secondary_range_name = "moltzap-services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  addons_config {
    gcs_fuse_csi_driver_config {
      enabled = true
    }
  }

  resource_labels = {
    "moltzap-profile" = "simulator-qualification"
  }

  depends_on = [
    google_project_iam_member.node_runtime,
    google_service_account_iam_member.gke_uses_node_identity,
  ]
}

resource "google_container_node_pool" "system" {
  project    = var.project_id
  name       = "system"
  location   = var.zone
  cluster    = google_container_cluster.simulator.name
  node_count = var.system_nodes

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.system_machine_type
    image_type      = "COS_CONTAINERD"
    disk_type       = "pd-balanced"
    disk_size_gb    = var.system_disk_size_gb
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      (local.agent_pool_label_key) = local.system_pool_label
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Scaling from zero requires this pool's label and taint to be declared here,
# because the autoscaler decides whether a node that does not exist yet would
# accept the pending pods.
resource "google_container_node_pool" "agents" {
  project  = var.project_id
  name     = "agents"
  location = var.zone
  cluster  = google_container_cluster.simulator.name

  # The ClusterQueue quota is sized against this ceiling; move them together.
  initial_node_count = 0
  autoscaling {
    min_node_count  = 0
    max_node_count  = var.agent_max_nodes
    location_policy = "ANY"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.agent_machine_type
    image_type      = "COS_CONTAINERD"
    disk_type       = "pd-balanced"
    disk_size_gb    = var.agent_disk_size_gb
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      (local.agent_pool_label_key) = local.agent_pool_label_value
    }

    taint {
      key    = local.agent_pool_taint_key
      value  = "true"
      effect = "NO_SCHEDULE"
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

resource "google_storage_bucket_iam_member" "cluster_artifact_writer" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = local.cluster_workload_principal

  depends_on = [google_container_cluster.simulator]
}

# The release workflow pushes controller and agent images with GitHub's OIDC
# token rather than a stored key: the provider admits only tokens minted for
# the publish workflow running on this repository's main branch, and the
# release identity may write nothing but this profile's image repository.
resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.repository"   = "assertion.repository"
    "attribute.ref"          = "assertion.ref"
    "attribute.workflow_ref" = "assertion.workflow_ref"
  }
  attribute_condition = join(" && ", [
    "assertion.repository == \"${var.github_repository}\"",
    "assertion.ref == \"refs/heads/main\"",
    "assertion.workflow_ref == \"${var.github_repository}/.github/workflows/publish.yml@refs/heads/main\"",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "release" {
  project      = var.project_id
  account_id   = "moltzap-release"
  display_name = "MoltZap release workflow"

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "release_image_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.simulator.location
  repository = google_artifact_registry_repository.simulator.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.release.email}"
}

# The binding names the publish workflow on main, the same identity the
# provider's condition admits, so a second provider on this pool cannot widen
# it to another workflow.
resource "google_service_account_iam_member" "release_workload_identity_user" {
  service_account_id = google_service_account.release.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.workflow_ref/${var.github_repository}/.github/workflows/publish.yml@refs/heads/main"
}
