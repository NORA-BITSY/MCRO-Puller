terraform {
  required_providers {
    google = { source = "hashicorp/google" }
  }
}

locals {
  identities = toset(["api", "worker"])
  secrets = {
    api_database    = "${var.name}-api-database-url"
    worker_database = "${var.name}-worker-database-url"
    read_token      = "${var.name}-api-token-read"
    write_token     = "${var.name}-api-token-write"
    admin_token     = "${var.name}-api-token-admin"
  }
  api_secrets = {
    COURT_DATABASE_URL = "api_database"
    API_TOKEN_READ     = "read_token"
    API_TOKEN_WRITE    = "write_token"
    API_TOKEN_ADMIN    = "admin_token"
  }
}

resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com", "run.googleapis.com", "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com", "secretmanager.googleapis.com",
    "storage.googleapis.com", "artifactregistry.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  for_each     = local.identities
  project      = var.project_id
  account_id   = "${var.name}-${each.key}"
  display_name = "Court ${each.key} runtime (no key files)"
}

resource "google_compute_network" "private" {
  name                    = "${var.name}-private"
  auto_create_subnetworks  = false
  depends_on              = [google_project_service.required]
}
resource "google_compute_subnetwork" "runtime" {
  name                     = "${var.name}-runtime"
  region                   = var.region
  network                  = google_compute_network.private.id
  ip_cidr_range            = "10.42.0.0/24"
  private_ip_google_access = true
}
resource "google_compute_global_address" "sql" {
  name          = "${var.name}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.private.id
}
resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.private.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql.name]
}
resource "google_compute_router" "egress" {
  name    = "${var.name}-egress"
  region  = var.region
  network = google_compute_network.private.id
}
resource "google_compute_router_nat" "egress" {
  name                               = "${var.name}-egress"
  router                             = google_compute_router.egress.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat  = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.runtime.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
# No inbound firewall rules: there is no public IP, SSH, RDP or browser-debug port.
resource "google_compute_firewall" "egress_web" {
  name                   = "${var.name}-web-egress"
  network                = google_compute_network.private.name
  direction              = "EGRESS"
  priority               = 900
  target_service_accounts = [google_service_account.runtime["worker"].email]
  destination_ranges     = ["0.0.0.0/0"]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}
resource "google_compute_firewall" "egress_sql" {
  name                    = "${var.name}-sql-egress"
  network                 = google_compute_network.private.name
  direction               = "EGRESS"
  priority                = 900
  target_service_accounts = [google_service_account.runtime["worker"].email]
  destination_ranges      = ["${google_sql_database_instance.court.private_ip_address}/32"]
  allow {
    protocol = "tcp"
    ports    = ["3307"]
  }
}
resource "google_compute_firewall" "egress_deny" {
  name                    = "${var.name}-deny-egress"
  network                 = google_compute_network.private.name
  direction               = "EGRESS"
  priority                = 1000
  target_service_accounts = [google_service_account.runtime["worker"].email]
  destination_ranges      = ["0.0.0.0/0"]
  deny { protocol = "all" }
}

resource "google_sql_database_instance" "court" {
  name                = "${var.name}-postgres"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true
  settings {
    edition           = "ENTERPRISE"
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"
    disk_type         = "PD_SSD"
    disk_size         = 100
    disk_autoresize   = true
    disk_autoresize_limit = 500
    deletion_protection_enabled = true
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.private.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "04:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }
    maintenance_window {
      day          = 7
      hour         = 5
      update_track = "stable"
    }
  }
  depends_on = [google_service_networking_connection.sql]
  lifecycle { prevent_destroy = true }
}
resource "google_sql_database" "court" {
  name     = "court"
  instance = google_sql_database_instance.court.name
}
resource "google_project_iam_member" "sql_client" {
  for_each = local.identities
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

resource "google_storage_bucket" "artifacts" {
  name                        = "${var.project_id}-${var.name}-artifacts"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  soft_delete_policy { retention_duration_seconds = 604800 }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}
resource "google_project_iam_custom_role" "artifact_writer" {
  project     = var.project_id
  role_id     = "${replace(var.name, "-", "_")}_artifact_writer"
  title       = "Create and verify immutable court artifacts"
  permissions = ["storage.objects.create", "storage.objects.get"]
}
resource "google_storage_bucket_iam_member" "writer" {
  bucket = google_storage_bucket.artifacts.name
  role   = google_project_iam_custom_role.artifact_writer.name
  member = "serviceAccount:${google_service_account.runtime["worker"].email}"
}
resource "google_storage_bucket_iam_member" "reader" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime["api"].email}"
}

# Metadata only. Secret payloads are populated outside Terraform and never enter state.
resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secrets
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}
resource "google_secret_manager_secret_iam_member" "api" {
  for_each  = local.api_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["api"].email}"
}
resource "google_secret_manager_secret_iam_member" "worker" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime["worker_database"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["worker"].email}"
}
resource "google_artifact_registry_repository_iam_member" "worker" {
  count      = var.runtime_enabled ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime["worker"].email}"
}

resource "google_cloud_run_v2_service" "api" {
  count               = var.runtime_enabled ? 1 : 0
  name                = "${var.name}-api"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.runtime["api"].email
    max_instance_request_concurrency = 20
    timeout                          = "60s"
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.private.name
        subnetwork = google_compute_subnetwork.runtime.name
      }
    }
    containers {
      name       = "api"
      depends_on = ["sql-proxy"]
      image = var.image
      ports { container_port = 3000 }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
      }
      env {
        name  = "COURT_GCS_BUCKET"
        value = google_storage_bucket.artifacts.name
      }
      env {
        name  = "COURT_ALLOW_LIVE_MN"
        value = "false"
      }
      dynamic "env" {
        for_each = local.api_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      # Native probes cannot safely interpolate bearer secrets. Authenticated HTTP checks
      # run through the monitor/runbook; this probe asserts only socket startup.
      startup_probe {
        tcp_socket { port = 3000 }
        initial_delay_seconds = 0
        period_seconds        = 5
        failure_threshold     = 24
      }
    }
    containers {
      name  = "sql-proxy"
      image = var.proxy_image
      args  = ["--private-ip", "--address=0.0.0.0", "--port=5432", google_sql_database_instance.court.connection_name]
      resources {
        limits   = { cpu = "1", memory = "128Mi" }
        cpu_idle = true
      }
      startup_probe {
        tcp_socket { port = 5432 }
        period_seconds    = 5
        failure_threshold = 24
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.api, google_project_iam_member.sql_client]
  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image)) && can(regex("@sha256:[a-f0-9]{64}$", var.proxy_image))
      error_message = "Runtime and SQL proxy images must use immutable digests."
    }
  }
}
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = var.runtime_enabled ? var.invokers : toset([])
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = each.value
}

resource "google_compute_instance" "browser" {
  count        = var.runtime_enabled ? 1 : 0
  name         = "${var.name}-browser"
  machine_type = "e2-standard-2"
  zone         = var.zone
  deletion_protection = true
  boot_disk {
    initialize_params {
      image = var.cos_image
      size  = 50
      type  = "pd-balanced"
    }
  }
  network_interface { subnetwork = google_compute_subnetwork.runtime.id }
  service_account {
    email  = google_service_account.runtime["worker"].email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }
  metadata_startup_script = templatefile("${path.module}/worker-startup.sh.tftpl", {
    image       = var.image
    proxy_image = var.proxy_image
    registry    = "${var.region}-docker.pkg.dev"
    project     = var.project_id
    secret      = google_secret_manager_secret.runtime["worker_database"].secret_id
    bucket      = google_storage_bucket.artifacts.name
    connection  = google_sql_database_instance.court.connection_name
  })
  depends_on = [google_compute_router_nat.egress, google_secret_manager_secret_iam_member.worker, google_artifact_registry_repository_iam_member.worker]
  lifecycle {
    precondition {
      condition = can(regex("@sha256:[a-f0-9]{64}$", var.image)) && can(regex("@sha256:[a-f0-9]{64}$", var.proxy_image)) && can(regex("^projects/cos-cloud/global/images/[^/]+$", var.cos_image)) && var.artifact_repository != ""
      error_message = "Runtime requires digest-pinned app/proxy images, an exact COS image, and an Artifact Registry repository."
    }
  }
}

output "bucket" { value = google_storage_bucket.artifacts.name }
output "database_connection" { value = google_sql_database_instance.court.connection_name }
output "database_private_ip" { value = google_sql_database_instance.court.private_ip_address }
output "secret_ids" { value = local.secrets }
output "api_uri" { value = try(google_cloud_run_v2_service.api[0].uri, null) }
