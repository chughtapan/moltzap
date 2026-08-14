#!/usr/bin/env bash
#
# Static validation for the hosted Phoenix module.
#
# This never contacts Google Cloud. It selects no project, reads no
# credentials, and touches no state: `init -backend=false` resolves providers
# against the committed lock file and stops there. It therefore proves the
# configuration is well formed and internally consistent, and proves nothing
# about whether an apply would succeed against a real project.
#
# Resolving providers does reach the Terraform registry the first time it runs
# in a working tree. That is a genuine failure when it fails, not a skip: a
# check that quietly passes without validating anything is worse than one that
# is absent.
set -euo pipefail

module_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/terraform" && pwd)"

if ! command -v terraform >/dev/null 2>&1; then
  echo "phoenix-terraform-check: terraform is required" >&2
  exit 1
fi

terraform -chdir="$module_root" fmt -check -recursive
terraform -chdir="$module_root" init -backend=false -input=false -no-color >/dev/null
terraform -chdir="$module_root" validate -no-color
