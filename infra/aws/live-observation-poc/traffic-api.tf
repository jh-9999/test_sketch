data "aws_ssm_parameter" "amazon_linux_2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_lb" "traffic" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "traffic" {
  name        = "${var.project_name}-traffic"
  port        = 3000
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.poc.id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "traffic" {
  load_balancer_arn = aws_lb.traffic.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.traffic.arn
  }
}

resource "aws_launch_template" "traffic" {
  name_prefix   = "${var.project_name}-traffic-"
  image_id      = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type = var.instance_type

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    traffic_api_bundle_url_json = jsonencode(var.traffic_api_bundle_url)
  }))

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.traffic_api.id]
  }

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "${var.project_name}-traffic"
    }
  }

  update_default_version = true
}

resource "aws_autoscaling_group" "traffic" {
  name                      = "${var.project_name}-traffic"
  min_size                  = 1
  desired_capacity          = 1
  max_size                  = 2
  health_check_type         = "ELB"
  health_check_grace_period = 120
  target_group_arns         = [aws_lb_target_group.traffic.arn]
  vpc_zone_identifier       = aws_subnet.public[*].id

  launch_template {
    id      = aws_launch_template.traffic.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${var.project_name}-traffic"
    propagate_at_launch = true
  }

  depends_on = [aws_lb_listener.traffic]
}

resource "aws_autoscaling_policy" "traffic_requests" {
  name                   = "${var.project_name}-request-count"
  autoscaling_group_name = aws_autoscaling_group.traffic.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value     = 60
    disable_scale_in = true

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.traffic.arn_suffix}/${aws_lb_target_group.traffic.arn_suffix}"
    }
  }
}
