#!/usr/bin/env bash
# One-command local setup: dependencies, .env, infrastructure, migrations, seed data.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pnpm >/dev/null || { echo "pnpm is required (npm i -g pnpm@12)"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }

pnpm install --frozen-lockfile

if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(openssl rand -base64 48 | tr -d '\n')
  # Write the generated secret without echoing it.
  sed -i.bak "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=${secret}|" .env && rm -f .env.bak
  echo "Created .env with a freshly generated JWT secret"
fi

pnpm infra:up
echo "Waiting for PostgreSQL and the Firestore emulator to become healthy..."
for _ in $(seq 1 60); do
  healthy=$(docker compose -f infra/docker-compose.yml ps --format '{{.Health}}' postgres firestore | grep -c healthy || true)
  [ "$healthy" -eq 2 ] && break
  sleep 2
done

pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
echo "Ready. Start the API with: pnpm dev"
