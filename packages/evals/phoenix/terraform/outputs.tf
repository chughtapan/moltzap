output "service_url" {
  description = "Phoenix origin. This is PHOENIX_HOST for the evaluation publisher and the address to open in a browser."
  value       = google_cloud_run_v2_service.phoenix.uri
}

output "instance_connection_name" {
  description = "Cloud SQL instance connection name, in project:region:instance form. Cloud Run publishes the Auth proxy socket under /cloudsql using exactly this string, and `gcloud sql connect` takes it too."
  value       = google_sql_database_instance.phoenix.connection_name
}

output "service_account_email" {
  description = "Runtime identity of the service. It holds Cloud SQL client on the project and secret access on this module's three secrets, and nothing else."
  value       = google_service_account.phoenix.email
}

output "phoenix_image_reference" {
  description = "Digest-pinned image the service actually runs, resolved through the Artifact Registry mirror."
  value       = local.phoenix_image_reference
}

# The values are deliberately absent. Naming the secrets is enough to reach
# them with `gcloud secrets versions access`, which leaves an audit record;
# emitting them here would copy three credentials into every plan file and
# state snapshot that already holds them once.
output "secret_ids" {
  description = "Secret Manager secret IDs holding the database URL, the JWT signing secret, and the initial admin password."
  value = {
    for id, secret in google_secret_manager_secret.phoenix : id => secret.secret_id
  }
}

output "admin_bootstrap" {
  description = "How to take ownership of the instance on first deploy."
  value = {
    login_url    = "${google_cloud_run_v2_service.phoenix.uri}/login"
    email        = "admin@localhost"
    password_via = "gcloud secrets versions access latest --project ${var.project_id} --secret ${google_secret_manager_secret.phoenix["admin-initial-password"].secret_id}"
  }
}
