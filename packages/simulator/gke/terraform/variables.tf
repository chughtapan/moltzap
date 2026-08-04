variable "project_id" {
  description = "Google Cloud project used only for the simulator qualification profile."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "region" {
  description = "GKE control-plane region and Artifact Registry location."
  type        = string
  default     = "us-central1"
}

variable "node_locations" {
  description = "Exactly three zones backing both fixed regional node pools."
  type        = list(string)
  default     = ["us-central1-a", "us-central1-b", "us-central1-c"]

  validation {
    condition = length(var.node_locations) == 3 && alltrue([
      for location in var.node_locations : startswith(location, "${var.region}-")
    ])
    error_message = "node_locations must contain exactly three zones in region."
  }
}

variable "cluster_name" {
  description = "Regional GKE Standard cluster name."
  type        = string
  default     = "moltzap-simulator"
}

variable "artifact_bucket_name" {
  description = "Globally unique Cloud Storage bucket for retained simulator ledgers."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.artifact_bucket_name))
    error_message = "artifact_bucket_name must be a valid 3-63 character Cloud Storage bucket name."
  }
}

variable "artifact_repository_id" {
  description = "Artifact Registry Docker repository for the immutable controller/support image."
  type        = string
  default     = "moltzap-simulator"
}

variable "network_name" {
  description = "VPC created for the qualification cluster."
  type        = string
  default     = "moltzap-simulator"
}

variable "subnetwork_cidr" {
  description = "Primary node range for the qualification cluster."
  type        = string
  default     = "10.40.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary Pod range for VPC-native GKE."
  type        = string
  default     = "10.44.0.0/14"
}

variable "services_cidr" {
  description = "Secondary Service range for VPC-native GKE."
  type        = string
  default     = "10.48.0.0/20"
}

variable "system_machine_type" {
  description = "Machine type for profile controllers and other non-agent infrastructure."
  type        = string
  default     = "e2-standard-4"
}

variable "system_nodes_per_zone" {
  description = "Fixed system nodes per zone in the regional cluster."
  type        = number
  default     = 1

  validation {
    condition     = var.system_nodes_per_zone >= 1 && floor(var.system_nodes_per_zone) == var.system_nodes_per_zone
    error_message = "system_nodes_per_zone must be a positive integer."
  }
}

variable "system_disk_size_gb" {
  description = "Boot disk size for system nodes."
  type        = number
  default     = 50
}

variable "deletion_protection" {
  description = "Protect the qualification cluster from Terraform destroy when explicitly enabled."
  type        = bool
  default     = false
}
