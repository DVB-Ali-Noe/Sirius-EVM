#!/usr/bin/env bash
# Rejoue sous Linux les tests d'audit qui exigent les registres SQLite en 0600 (impossibles sous
# Windows). À lancer depuis la racine du dépôt, sans secret ni réseau autre que le registre npm :
#
#   MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/src:ro" -v sirius-audit-pnpm:/root/.local/share/pnpm/store \
#     node:22.16.0-bookworm-slim bash /src/audit/robustesse/run-linux.sh
#
# Le dépôt est copié dans le conteneur sans node_modules, .git, .env*, .ops ni .claude.
set -euo pipefail
export PNPM_CONFIG_FETCH_RETRIES=5 PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 PNPM_CONFIG_FETCH_TIMEOUT=300000 PNPM_CONFIG_NETWORK_CONCURRENCY=8
mkdir -p /work
cd /src
tar --exclude=./node_modules --exclude=./.git --exclude='./.env' --exclude='./.env.*' --exclude=./.ops --exclude=./.claude --exclude=./.next -cf - . | tar -C /work -xf -
cd /work
npx -y pnpm@11.18.0 install --frozen-lockfile --ignore-scripts > /tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
export TEE_MODE=stub NODE_OPTIONS="--conditions=react-server"
echo "## $(node --version) $(uname -srm) $(nproc) CPU"
node --import tsx --test audit/robustesse/free-ops-burst.test.ts audit/robustesse/ledger-saturation.test.ts 2>&1 | grep -E "^# \[|^ok|^not ok|^# (tests|pass|fail|skipped)|error:" || true
