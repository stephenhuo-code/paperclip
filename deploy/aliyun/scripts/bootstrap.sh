#!/usr/bin/env bash
# Usage: bootstrap.sh <env>
# One-time server setup, run as root from a copy of deploy/aliyun on the ECS
# instance. Safe to re-run: every step skips what is already in place.
#
# Steps (override with BOOTSTRAP_STEPS=comma,separated):
#   docker    install Docker Engine + Compose plugin, enable on boot
#   secrets   create /opt/paperclip/.env from env.example (existing keys kept)
#   files     install deploy assets into /opt/paperclip/deploy and remote-deploy.sh
#   registry  docker login to the ACR VPC endpoint (needs ACR_USERNAME, ACR_PASSWORD)
#   ossutil   install ossutil for backups
#   cron      schedule the daily backup at 03:00
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
. "$SRC_DIR/scripts/lib.sh"

[ "$#" -eq 1 ] || die "usage: bootstrap.sh <env>"
ENV_NAME="$1"
STEPS=",${BOOTSTRAP_STEPS:-docker,secrets,files,registry,ossutil,cron},"
want() { [[ "$STEPS" == *",$1,"* ]]; }

step_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
      # Alibaba Cloud Linux 3 / RHEL family, via the Alibaba Cloud mirror.
      dnf install -y dnf-plugins-core
      dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get update
      apt-get install -y docker.io docker-compose-v2
    else
      die "unsupported distribution: install Docker Engine and the compose plugin manually"
    fi
  fi
  systemctl enable --now docker
  echo "docker ready"
}

step_secrets() {
  local example="$SRC_DIR/env.example" line key default value created=0
  mkdir -p "$PAPERCLIP_ROOT"
  umask 077
  touch "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    default="${BASH_REMATCH[2]}"
    if grep -q "^$key=" "$SECRETS_FILE"; then
      continue
    fi
    if [ -n "$default" ] || [ "$key" = "PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP" ]; then
      value="$default"
    else
      value="$(openssl rand -hex 32)"
      created=$((created + 1))
    fi
    printf '%s=%s\n' "$key" "$value" >> "$SECRETS_FILE"
  done < "$example"
  echo "secrets file ready ($created new secrets generated)"
}

step_files() {
  mkdir -p "$DEPLOY_DIR" "$PAPERCLIP_ROOT/bin" "$STATE_DIR"
  if [ "$SRC_DIR" != "$DEPLOY_DIR" ]; then
    cp -R "$SRC_DIR/." "$DEPLOY_DIR/"
  fi
  install -m 0755 "$DEPLOY_DIR/scripts/remote-deploy.sh" "$PAPERCLIP_ROOT/bin/remote-deploy.sh"
  echo "deploy assets installed in $DEPLOY_DIR"
}

step_registry() {
  local env_file="$DEPLOY_DIR/environments/$ENV_NAME.env" registry
  registry="$(env_value "$env_file" ACR_REGISTRY_VPC)" || die "ACR_REGISTRY_VPC is not set in $env_file"
  [ -n "${ACR_USERNAME:-}" ] && [ -n "${ACR_PASSWORD:-}" ] || die "set ACR_USERNAME and ACR_PASSWORD for the registry step"
  printf '%s' "$ACR_PASSWORD" | docker login "$registry" --username "$ACR_USERNAME" --password-stdin >/dev/null
  echo "logged in to $registry"
}

step_ossutil() {
  if command -v ossutil >/dev/null 2>&1; then
    echo "ossutil present"
    return
  fi
  curl -fsSL https://gosspublic.alicdn.com/ossutil/install.sh | bash
  echo "ossutil installed"
}

step_cron() {
  cat > /etc/cron.d/paperclip-backup <<CRON
# Daily Paperclip + Keycloak backup to OSS (deploy/aliyun/scripts/backup.sh)
0 3 * * * root $DEPLOY_DIR/scripts/backup.sh $ENV_NAME >> /var/log/paperclip-backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/paperclip-backup
  echo "daily backup scheduled"
}

want docker && step_docker
want secrets && step_secrets
want files && step_files
want registry && step_registry
want ossutil && step_ossutil
want cron && step_cron
echo "bootstrap complete"
