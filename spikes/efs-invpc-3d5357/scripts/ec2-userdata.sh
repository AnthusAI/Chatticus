#!/bin/bash
set -euo pipefail
dnf install -y amazon-efs-utils git python3-pip nfs-utils
systemctl enable --now amazon-ssm-agent
