variable "aws_region" {
  description = "AWS region for the disposable live-observation PoC."
  type        = string
  default     = "ap-northeast-2"
}

variable "project_name" {
  description = "Lowercase resource-name prefix for the disposable PoC."
  type        = string
  default     = "live-observation-poc"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-24 lowercase letters, numbers, or hyphens; it must start with a letter and end with a letter or number."
  }
}

variable "vpc_cidr" {
  description = "CIDR range for the PoC VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Exactly two public-subnet CIDRs, one for each available Zone selected by Terraform."
  type        = list(string)
  default     = ["10.42.0.0/24", "10.42.1.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "Exactly two public subnet CIDRs are required."
  }
}

variable "instance_type" {
  description = "EC2 instance type for the disposable traffic API."
  type        = string
  default     = "t3.micro"
}

variable "traffic_api_bundle_url" {
  description = "HTTPS URL of the disposable prebuilt traffic API bundle. The default is deliberately non-deploying."
  type        = string
  default     = "https://example.invalid/live-observation-traffic.tar.gz"

  validation {
    condition     = can(regex("^https://", var.traffic_api_bundle_url))
    error_message = "traffic_api_bundle_url must use HTTPS."
  }
}
