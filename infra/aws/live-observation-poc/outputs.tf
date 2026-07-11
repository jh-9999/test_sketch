output "static_bucket_name" {
  description = "Private S3 bucket name for the static audience page."
  value       = aws_s3_bucket.static.id
}

output "cloudfront_url" {
  description = "HTTPS URL for the CloudFront distribution."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "alb_dns_name" {
  description = "ALB DNS name; CloudFront is the intended public entry point."
  value       = aws_lb.traffic.dns_name
}

output "autoscaling_group_name" {
  description = "Name of the disposable traffic API Auto Scaling group."
  value       = aws_autoscaling_group.traffic.name
}
