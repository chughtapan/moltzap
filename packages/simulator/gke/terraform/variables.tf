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

variable "zone" {
  description = <<-EOT
    Zone holding the cluster and both node pools.

    The cluster is zonal because nothing here is replicated: the development
    Temporal deployment and each run's router are single pods, so a regional
    control plane cannot keep a run alive through a zone loss. One zone also
    keeps every agent beside the router it talks to, so cross-zone latency
    stays out of the measurement. Must lie inside region.
  EOT
  type        = string
  default     = "us-central1-a"
}

variable "agent_machine_type" {
  description = <<-EOT
    Agent node machine type.

    GKE reserves less proportionally as a node grows, so sixteen vCPU on one
    machine yields marginally more allocatable than the same vCPU split in two,
    and e2 is priced per vCPU so splitting saves nothing. Fewer, larger nodes
    also pull each image fewer times.
  EOT
  type        = string
  default     = "e2-standard-16"
}

variable "agent_max_nodes" {
  description = <<-EOT
    Ceiling for the autoscaled agent pool, which idles at zero nodes. CPU binds
    first, seating about fourteen agents per e2-standard-16, so eight nodes
    hold the hundred-agent soak. Raise the chart's ClusterQueue quota to match.
  EOT
  type        = number
  default     = 8

  validation {
    condition     = var.agent_max_nodes >= 1 && floor(var.agent_max_nodes) == var.agent_max_nodes
    error_message = "agent_max_nodes must be a positive integer."
  }
}

variable "agent_disk_size_gb" {
  description = <<-EOT
    Agent node boot disk, in GB.

    The node image, the support and stock agent images once, and one gibibyte
    of ephemeral storage for each agent the node holds. CPU exhausts first, so
    the disk carries generous headroom; the reason not to shrink it is
    throughput, since pd-balanced scales with size and a smaller disk slows the
    first image pull.
  EOT
  type        = number
  default     = 100

  validation {
    condition     = var.agent_disk_size_gb >= 50
    error_message = "agent_disk_size_gb must leave room for the node image and the agent working set."
  }
}

variable "cluster_name" {
  description = "GKE Standard cluster name."
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

variable "system_nodes" {
  description = <<-EOT
    System nodes carrying cluster DNS, metrics, the Kueue controller, and the
    run worker. Zero parks the controller between experiments; nothing runs and
    nothing recovers on its own until it is restored.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.system_nodes >= 0 && floor(var.system_nodes) == var.system_nodes
    error_message = "system_nodes must be a non-negative integer."
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
