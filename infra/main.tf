terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "deployment_approved" {
  type        = bool
  default     = false
  description = "Explicit spending approval; false creates no infrastructure. Never enable in CI."
}
variable "project_id" {
  type    = string
  default = ""
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "zone" {
  type    = string
  default = "us-central1-a"
}
variable "name" {
  type    = string
  default = "court"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}$", var.name))
    error_message = "Use 2-19 lowercase letters/digits/hyphens, beginning with a letter."
  }
}
variable "runtime_enabled" {
  type        = bool
  default     = false
  description = "Enable only after migrations, database roles and Secret Manager versions are provisioned."
}
variable "image" {
  type        = string
  default     = ""
  description = "Artifact Registry image URL pinned with @sha256:<64 hex>."
}
variable "artifact_repository" {
  type        = string
  default     = ""
  description = "Existing Artifact Registry repository ID in this project and region."
}
variable "proxy_image" {
  type        = string
  default     = ""
  description = "Cloud SQL Auth Proxy v2 image pinned to a reviewed sha256 digest."
}
variable "cos_image" {
  type        = string
  default     = ""
  description = "Exact projects/cos-cloud/global/images/... image, not a moving family."
}
variable "invokers" {
  type        = set(string)
  default     = []
  description = "Explicit user/group/serviceAccount IAM principals allowed to call the API."
  validation {
    condition     = alltrue([for member in var.invokers : can(regex("^(user|group|serviceAccount):[^ ]+@[^ ]+$", member))])
    error_message = "Only explicit user, group and serviceAccount principals are allowed."
  }
}
variable "labels" {
  type        = map(string)
  default     = {}
  description = "Required owner, env and cost-center billing labels before deployment approval."
  validation {
    condition     = !var.deployment_approved || alltrue([for key in ["owner", "env", "cost-center"] : try(length(var.labels[key]) > 0, false)])
    error_message = "Approved deployments require nonempty owner, env and cost-center labels."
  }
}

provider "google" {
  project = var.project_id == "" ? null : var.project_id
  region  = var.region
  zone    = var.zone
  default_labels = var.labels
}

module "platform" {
  count               = var.deployment_approved ? 1 : 0
  source              = "./modules/platform"
  project_id          = var.project_id
  region              = var.region
  zone                = var.zone
  name                = var.name
  runtime_enabled     = var.runtime_enabled
  image               = var.image
  artifact_repository = var.artifact_repository
  proxy_image         = var.proxy_image
  cos_image           = var.cos_image
  invokers            = var.invokers
}

output "deployment" {
  value = module.platform
}
