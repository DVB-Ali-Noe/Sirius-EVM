#!/usr/bin/env bash
# Audit REP-01/REP-02 : construit deux fois l'image runner d'un commit et compare les digests.
#
#   bash audit/reproductibilite/build-runner-twice.sh <commit> <dossier-de-travail> [brut|stable]
#
# brut   : Dockerfile.runner tel quel, comme le CI (tag de base flottant, horodatages réels).
# stable : base épinglée par digest (variable BASE), état pnpm horodaté supprimé,
#          SOURCE_DATE_EPOCH = date du commit et rewrite-timestamp=true.
# Rien n'est poussé : sortie OCI locale uniquement. Le Dockerfile modifié est écrit dans le
# dossier de travail, jamais dans le dépôt.
#
# L'export force les fins de ligne LF (core.autocrlf=false) : sous Windows avec autocrlf=true,
# un export ordinaire produit des CRLF et donc d'autres octets que le CI Linux.
set -eu
COMMIT="$1"
WORK="$2"
MODE="${3:-brut}"
BASE="${BASE:-node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d}"
REPO="$(git rev-parse --show-toplevel)"
mkdir -p "$WORK"
SRC="$WORK/src-$COMMIT"
rm -rf "$SRC" && mkdir -p "$SRC"
git -C "$REPO" -c core.autocrlf=false archive --format=tar "$COMMIT" | tar -x -C "$SRC"
DOCKERFILE="$SRC/Dockerfile.runner"
EXTRA=()
OUTPUT_OPTS=""
if [ "$MODE" = "stable" ]; then
  # Base épinglée, puis suppression des deux fichiers d'état de pnpm qui portent l'heure
  # de l'installation (`prunedAt`, `lastValidatedTimestamp`) et ne servent pas à l'exécution.
  sed -e "s|^FROM node:22-bookworm-slim |FROM $BASE |" \
    -e 's|pnpm install --prod --frozen-lockfile --ignore-scripts$|pnpm install --prod --frozen-lockfile --ignore-scripts \\\n    \&\& rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json|' \
    "$SRC/Dockerfile.runner" > "$WORK/Dockerfile.runner.pinned"
  DOCKERFILE="$WORK/Dockerfile.runner.pinned"
  SOURCE_DATE_EPOCH="$(git -C "$REPO" log -1 --format=%ct "$COMMIT")"
  export SOURCE_DATE_EPOCH
  EXTRA=(--build-arg SOURCE_DATE_EPOCH)
  OUTPUT_OPTS=",rewrite-timestamp=true"
fi
for n in 1 2; do
  docker buildx build --platform linux/amd64 --no-cache --provenance=false --sbom=false "${EXTRA[@]}" \
    -f "$DOCKERFILE" --output "type=oci,dest=$WORK/runner-$MODE-$n.tar$OUTPUT_OPTS" "$SRC" > "$WORK/build-$MODE-$n.log" 2>&1
  echo "build $MODE $n : code $?"
done
python -I "$(dirname "$0")/compare-oci.py" "$WORK/runner-$MODE-1.tar" "$WORK/runner-$MODE-2.tar"
