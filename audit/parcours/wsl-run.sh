#!/bin/sh
# Copie le dépôt dans le système de fichiers Linux de WSL puis lance le parcours (pour Windows).
# Usage depuis WSL : sh /mnt/c/.../audit/parcours/wsl-run.sh
set -e
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DST="${SIRIUS_AUDIT_WORKDIR:-$HOME/sirius-audit}"
mkdir -p "$DST"
rsync -a --exclude node_modules --exclude .git --exclude .claude --exclude .ops --exclude 'contracts/artifacts' \
  --exclude 'contracts/cache' --exclude 'src/generated' --exclude '.env' --exclude '.env.*' "$SRC/" "$DST/"
cd "$DST"
# prisma generate exige une DATABASE_URL ; aucune base n'est contactée par le parcours.
export DATABASE_URL="postgresql://synthetic:synthetic@127.0.0.1:1/unused"
npx -y pnpm@11.18.0 install --frozen-lockfile
sh audit/parcours/run.sh
