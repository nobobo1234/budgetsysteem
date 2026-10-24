#!/usr/bin/env bash
# Uitrol op de VPS. De gebruiker `deploy` mag via sudo precies dit script draaien:
#   deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-budget
# Gebruik: echo "$GITHUB_TOKEN" | sudo deploy-budget sha256:<digest>
# Het token (alleen lezen, verloopt na de job) komt via stdin, nooit als argument.
set -euo pipefail

REPO_IMAGE="ghcr.io/nobobo1234/budgetsysteem"
DIR="/opt/budget"
STATE="/var/lib/budget"
DIGEST="${1:-}"

if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Gebruik: deploy-budget sha256:<64 hex>" >&2
  exit 2
fi

mkdir -p "$STATE"
PREVIOUS="$(cat "$STATE/current-digest" 2>/dev/null || true)"

# Inloggen met het kortlevende token in een tijdelijke Docker-config (niet in
# /root/.docker), image op digest ophalen, en de config meteen weer weggooien
TOKEN="$(cat)"
LOGIN_DIR="$(mktemp -d)"
trap 'rm -rf "$LOGIN_DIR"' EXIT
echo "$TOKEN" | DOCKER_CONFIG="$LOGIN_DIR" docker login ghcr.io -u deploy --password-stdin >/dev/null
DOCKER_CONFIG="$LOGIN_DIR" docker pull "$REPO_IMAGE@$DIGEST"
rm -rf "$LOGIN_DIR"
unset TOKEN

# Backup vóór migraties (de app migreert bij het starten). Bij de eerste uitrol is er nog
# geen container en dus niets om te bewaren.
if docker ps --format '{{.Names}}' | grep -qx budget; then
  "$DIR/backup.sh" pre-deploy
fi

compose() {
  BUDGET_IMAGE="$REPO_IMAGE@$1" docker compose -f "$DIR/docker-compose.yml" "${@:2}"
}

start() {
  compose "$1" up -d --no-deps app
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/healthz >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

start "$DIGEST"
if healthy; then
  echo "$DIGEST" > "$STATE/current-digest"
  # Litestream draait naast de app; bij de eerste uitrol wordt hij hier gestart
  compose "$DIGEST" up -d litestream
  echo "Uitgerold: $DIGEST"
  # Oude images opruimen, de laatste paar blijven staan voor een rollback
  docker image prune -f --filter "until=720h" >/dev/null || true
  exit 0
fi

echo "Health check faalt; terug naar de vorige versie" >&2
if [[ -n "$PREVIOUS" ]]; then
  start "$PREVIOUS"
  healthy || echo "Ook de vorige versie is niet gezond; handmatig ingrijpen" >&2
fi
exit 1
