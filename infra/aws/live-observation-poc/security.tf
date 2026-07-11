data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-alb-"
  description = "Allows HTTP only from CloudFront origin-facing addresses."
  vpc_id      = aws_vpc.poc.id

  ingress {
    description     = "CloudFront managed origin-facing prefix list"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  }

  egress {
    description = "Traffic API targets in this VPC"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.poc.cidr_block]
  }
}

resource "aws_security_group" "traffic_api" {
  name_prefix = "${var.project_name}-traffic-api-"
  description = "Allows the traffic API to receive requests only from the ALB."
  vpc_id      = aws_vpc.poc.id

  ingress {
    description     = "ALB to traffic API"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "HTTPS bundle bootstrap"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "VPC DNS resolver"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["${local.dns_resolver_ip}/32"]
  }

  egress {
    description = "VPC DNS resolver over TCP"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["${local.dns_resolver_ip}/32"]
  }

  egress {
    description = "IMDSv2 instance identity"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["169.254.169.254/32"]
  }
}
