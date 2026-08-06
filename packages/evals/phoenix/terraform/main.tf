locals {
  required_services = toset([
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])

  # Phoenix's own default, kept rather than moved to 8080, so that the port in
  # the container matches every Phoenix document and log line.
  container_port = 6006

  # Cloud Run mounts the Cloud SQL Auth proxy socket under this directory. The
  # instance connection name contains colons; nothing here may quote or escape
  # them, because the proxy publishes the directory verbatim.
  cloudsql_mount_path = "/cloudsql"

  # Cloud Run pulls images as its own service agent, not as the runtime
  # identity below, so the repository grant has to name this principal. It is
  # spelled out rather than looked up because the resource that reads service
  # agents lives only in the beta provider.
  run_service_agent = "service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"

  phoenix_image_reference = join("/", [
    "${var.region}-docker.pkg.dev",
    var.project_id,
    google_artifact_registry_repository.upstream.repository_id,
    var.phoenix_image,
  ])

  # Phoenix builds its engine with SQLAlchemy, which preserves query parameters
  # and hands `host` to asyncpg, and asyncpg reads a host beginning with a
  # slash as a Unix socket directory. The empty authority is what keeps the
  # socket path out of the host slot, where the colons in the instance
  # connection name would be read as a port.
  database_url = format(
    "postgresql://%s:%s@/%s?host=%s/%s",
    google_sql_user.phoenix.name,
    random_password.database.result,
    google_sql_database.phoenix.name,
    local.cloudsql_mount_path,
    google_sql_database_instance.phoenix.connection_name,
  )

  # Every entry is generated here and read only by the service account below.
  # for_each iterates the identifiers rather than this map, because a map whose
  # values are sensitive cannot be a for_each argument.
  secret_ids = toset([
    "database-url",
    "phoenix-secret",
    "admin-initial-password",
  ])

  secret_values = {
    "database-url"           = local.database_url
    "phoenix-secret"         = random_password.phoenix_secret.result
    "admin-initial-password" = random_password.admin_initial.result
  }
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

# Google recommends pulling third-party images through a remote repository
# rather than from Docker Hub directly, and the digest survives the mirror
# unchanged, so pinning still names exactly one image.
resource "google_artifact_registry_repository" "upstream" {
  project       = var.project_id
  location      = var.region
  repository_id = var.upstream_repository_id
  description   = "Pull-through mirror of Docker Hub for the pinned Phoenix image"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"

  remote_repository_config {
    description = "Docker Hub"

    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "run_image_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.upstream.location
  repository = google_artifact_registry_repository.upstream.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${local.run_service_agent}"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "phoenix" {
  project      = var.project_id
  account_id   = var.name_prefix
  display_name = "MoltZap hosted Phoenix runtime"

  depends_on = [google_project_service.required]
}

# Reaching the database is an IAM decision, not a network one. The instance
# accepts no unauthenticated path at all; this grant is what lets the Cloud Run
# proxy open the socket.
resource "google_project_iam_member" "cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.phoenix.email}"
}

# Passwords are generated here rather than supplied so that no operator ever
# holds one, and so that a first apply cannot produce a revision with a
# placeholder credential. `special = false` on the two values that end up
# inside a URL removes any question of percent-encoding.
resource "random_password" "database" {
  length      = 40
  special     = false
  min_lower   = 4
  min_upper   = 4
  min_numeric = 4
}

# Phoenix rejects a signing secret shorter than 32 characters or missing a
# digit or a lowercase letter, and refuses to start rather than downgrading.
resource "random_password" "phoenix_secret" {
  length      = 48
  special     = false
  min_lower   = 4
  min_upper   = 4
  min_numeric = 4
}

# Satisfies the strong password policy enabled on the service below: at least
# twelve characters with an uppercase letter, a lowercase letter, a digit, and
# a symbol. The symbol set excludes quoting and shell metacharacters so an
# operator can paste it into a login form without escaping anything.
resource "random_password" "admin_initial" {
  length           = 24
  min_lower        = 4
  min_upper        = 4
  min_numeric      = 4
  min_special      = 2
  override_special = "!#%*-_=+"
}

resource "google_sql_database_instance" "phoenix" {
  project             = var.project_id
  name                = var.name_prefix
  region              = var.region
  database_version    = var.sql_database_version
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.sql_tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.sql_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection

    backup_configuration {
      enabled                        = true
      start_time                     = "07:00"
      point_in_time_recovery_enabled = var.point_in_time_recovery

      backup_retention_settings {
        retained_backups = var.backup_retention_count
        retention_unit   = "COUNT"
      }
    }

    # No authorized network is declared and none should be. Every connection
    # arrives through the Cloud SQL Auth proxy, which authenticates with IAM
    # and encrypts independently of any address allowlist.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day          = 7
      hour         = 8
      update_track = "stable"
    }
  }

  lifecycle {
    # Autoresize grows the disk without Terraform's involvement. Left as drift,
    # the next plan would try to put it back, and Cloud SQL refuses to shrink a
    # disk — so the apply would fail rather than the disk shrinking. disk_size
    # is a floor, and this is what keeps it one.
    ignore_changes = [settings[0].disk_size]
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "phoenix" {
  project  = var.project_id
  name     = "phoenix"
  instance = google_sql_database_instance.phoenix.name
}

resource "google_sql_user" "phoenix" {
  project  = var.project_id
  name     = "phoenix"
  instance = google_sql_database_instance.phoenix.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "phoenix" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "phoenix" {
  for_each = local.secret_ids

  secret      = google_secret_manager_secret.phoenix[each.key].id
  secret_data = local.secret_values[each.key]
}

# Access is granted on each secret rather than project-wide, so the runtime
# identity can read these three and nothing else the project later acquires.
resource "google_secret_manager_secret_iam_member" "phoenix_accessor" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = google_secret_manager_secret.phoenix[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.phoenix.email}"
}

resource "google_cloud_run_v2_service" "phoenix" {
  project             = var.project_id
  name                = var.name_prefix
  location            = var.region
  ingress             = var.ingress
  deletion_protection = var.deletion_protection

  template {
    service_account       = google_service_account.phoenix.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    timeout               = "600s"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"

      cloud_sql_instance {
        instances = [google_sql_database_instance.phoenix.connection_name]
      }
    }

    containers {
      image = local.phoenix_image_reference

      ports {
        container_port = local.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }

        # Phoenix drains its span queue on background tasks. Throttling the CPU
        # between requests, which is the Cloud Run default, would stall that
        # drain until the next request happened to arrive.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = local.cloudsql_mount_path
      }

      env {
        name  = "PHOENIX_PORT"
        value = tostring(local.container_port)
      }

      # Postgres is the store of record. The working directory only ever holds
      # scratch, so it points at the writable in-memory filesystem rather than
      # at a home directory that may not exist in the image.
      env {
        name  = "PHOENIX_WORKING_DIR"
        value = "/tmp/phoenix"
      }

      # Authentication is on in the first revision, not added later, so there
      # is no window in which an unauthenticated Phoenix is reachable.
      env {
        name  = "PHOENIX_ENABLE_AUTH"
        value = "True"
      }

      env {
        name  = "PHOENIX_ENABLE_STRONG_PASSWORD_POLICY"
        value = "True"
      }

      # Cloud Run serves TLS only, so the session cookies can require it.
      env {
        name  = "PHOENIX_USE_SECURE_COOKIES"
        value = "True"
      }

      # Phoenix ships an assistant that can execute shell commands and reach
      # the network from inside the container. Nothing here uses it, and this
      # service is reachable from the internet by design, so it is off.
      env {
        name  = "PHOENIX_DISABLE_AGENT_ASSISTANT"
        value = "True"
      }

      # Keeping evaluation data inside the project is the reason this is
      # self-hosted; usage telemetry leaving it would undercut that.
      env {
        name  = "PHOENIX_TELEMETRY_ENABLED"
        value = "False"
      }

      env {
        name = "PHOENIX_SQL_DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.phoenix["database-url"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "PHOENIX_SECRET"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.phoenix["phoenix-secret"].secret_id
            version = "latest"
          }
        }
      }

      # Only consulted while the default admin record is being created. Once it
      # exists, changing this has no effect and the password is changed in the
      # application.
      env {
        name = "PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.phoenix["admin-initial-password"].secret_id
            version = "latest"
          }
        }
      }

      # Generous, because the first start of an empty database runs every
      # Phoenix migration before the port answers.
      startup_probe {
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 30

        http_get {
          path = "/healthz"
          port = local.container_port
        }
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3

        http_get {
          path = "/healthz"
          port = local.container_port
        }
      }
    }
  }

  depends_on = [
    google_artifact_registry_repository_iam_member.run_image_reader,
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_iam_member.phoenix_accessor,
    google_secret_manager_secret_version.phoenix,
    google_sql_database.phoenix,
    google_sql_user.phoenix,
  ]
}

# Cloud Run stops at the network edge here and Phoenix authenticates every
# request itself. See the allow_public_invoker variable for why the two cannot
# both own the Authorization header.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.allow_public_invoker ? 1 : 0

  project  = var.project_id
  location = google_cloud_run_v2_service.phoenix.location
  name     = google_cloud_run_v2_service.phoenix.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
