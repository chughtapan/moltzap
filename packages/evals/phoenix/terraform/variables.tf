variable "project_id" {
  description = "Google Cloud project hosting the Phoenix service, its database, and its secrets."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "region" {
  description = "Cloud Run region, Cloud SQL region, and Artifact Registry location. One region for all three keeps the database socket and the service in the same failure domain."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = <<-EOT
    Prefix for every named object here: the Cloud Run service, the Cloud SQL
    instance, the runtime service account, and the three Secret Manager secrets.

    Kept short because the service account ID derived from it is capped at
    thirty characters by IAM.
  EOT
  type        = string
  default     = "moltzap-phoenix"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 4-21 lowercase alphanumeric or hyphen characters starting with a letter."
  }
}

variable "phoenix_image" {
  description = <<-EOT
    Phoenix image as a Docker Hub repository path pinned by digest.

    This is deliberately the upstream path and not a fully qualified reference:
    the module mirrors it through its own Artifact Registry remote repository,
    so the registry host, project, and repository are derived rather than
    restated. Only the repository path and digest are an input.

    The digest, not a tag, is the deployed identity. Resolve a new one with:

      docker manifest inspect arizephoenix/phoenix:version-X.Y.Z

    or, without a Docker daemon, read the `Docker-Content-Digest` header:

      TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:arizephoenix/phoenix:pull" | jq -r .token)
      curl -sI -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.oci.image.index.v1+json" \
        https://registry-1.docker.io/v2/arizephoenix/phoenix/manifests/version-X.Y.Z \
        | grep -i docker-content-digest

    The default is the multi-architecture index digest of
    `arizephoenix/phoenix:version-19.18.0`, resolved 2026-08-06, which was also
    `:latest` at that moment. Cloud Run selects the linux/amd64 child manifest.
  EOT
  type        = string
  default     = "arizephoenix/phoenix@sha256:65211b52795a0f8b67e29ec1a0787d4b683acb3c5450d2c30a30e0ad670bd3a8"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.phoenix_image))
    error_message = "phoenix_image must be pinned by digest, ending in @sha256: followed by 64 lowercase hex characters. A mutable tag is not a valid input."
  }

  validation {
    condition     = !can(regex("^[^/]*[.:][^/]*/", var.phoenix_image))
    error_message = "phoenix_image must be a Docker Hub repository path such as arizephoenix/phoenix@sha256:..., not a fully qualified registry reference. The registry host is derived from the module's Artifact Registry remote repository."
  }
}

variable "sql_tier" {
  description = <<-EOT
    Cloud SQL machine type.

    This database holds evaluation dashboards, not a serving workload: it is
    written once per publish and read by a handful of people. The smallest
    shared-core tier carries that comfortably.
  EOT
  type        = string
  default     = "db-g1-small"
}

variable "sql_database_version" {
  description = "Cloud SQL Postgres major version. Phoenix runs its own migrations against whatever it finds, so this moves independently of the image."
  type        = string
  default     = "POSTGRES_16"

  validation {
    condition     = can(regex("^POSTGRES_[0-9]+$", var.sql_database_version))
    error_message = "sql_database_version must be a POSTGRES_<major> identifier."
  }
}

variable "point_in_time_recovery" {
  description = "Retain write-ahead logs so the database can be restored to an arbitrary moment rather than only to a nightly backup. Costs log storage."
  type        = bool
  default     = true
}

variable "backup_retention_count" {
  description = "Number of automated backups retained."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_count >= 1 && floor(var.backup_retention_count) == var.backup_retention_count
    error_message = "backup_retention_count must be a positive integer."
  }
}

variable "deletion_protection" {
  description = <<-EOT
    Refuse to destroy the Cloud SQL instance and the Cloud Run service.

    Defaults to on, the opposite of the GKE profile, because the entire reason
    this module exists is that the dashboards must survive events that delete
    the cluster. Set it to false and apply once before `terraform destroy`.
  EOT
  type        = bool
  default     = true
}

variable "cpu" {
  description = "Cloud Run CPU limit. At least one full CPU is required for an always-allocated instance, which this service needs so that queued spans flush between requests."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Cloud Run memory limit. Phoenix buffers spans in memory and the working directory is an in-memory filesystem, so this is not purely process headroom."
  type        = string
  default     = "2Gi"
}

variable "min_instances" {
  description = <<-EOT
    Floor on running instances.

    One, not zero. Phoenix runs database migrations at startup and holds an
    in-memory span queue, so a scale-to-zero service would pay a migration on
    every cold start and could drop spans buffered when the last instance went
    away. Zero is defensible if the instance is only ever read through the UI.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.min_instances >= 0 && floor(var.min_instances) == var.min_instances
    error_message = "min_instances must be a non-negative integer."
  }
}

variable "allow_public_invoker" {
  description = <<-EOT
    Grant `roles/run.invoker` to allUsers so that Cloud Run itself does not
    demand a Google identity.

    This is required by the publisher, not a convenience: the Phoenix client
    authenticates with `Authorization: Bearer <PHOENIX_API_KEY>`, and Cloud Run
    IAM authentication claims that same header for its own identity token. The
    two cannot both own it. Turning this off means every caller must present a
    Google identity token instead, which the publisher cannot do.

    What stands between the internet and the data is Phoenix's authentication,
    which this module enables in the first revision.
  EOT
  type        = bool
  default     = true
}
