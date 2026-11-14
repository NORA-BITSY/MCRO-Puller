variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "An explicit valid Google Cloud project ID is required."
  }
}
variable "region" { type = string }
variable "zone" { type = string }
variable "name" { type = string }
variable "runtime_enabled" { type = bool }
variable "image" { type = string }
variable "artifact_repository" { type = string }
variable "proxy_image" { type = string }
variable "cos_image" { type = string }
variable "invokers" { type = set(string) }
