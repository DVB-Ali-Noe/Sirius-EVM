#!/usr/bin/env bash
# Reconstruit l'image runner d'un commit, comme le CI, et affiche le digest du manifeste
# (audit REP-01, REP-02). Avec « deux », construit deux fois sans cache et compare.
#
#   bash scripts/operations/rebuild-runner.sh <commit> <dossier-de-travail> [une|deux]
#
# Rien n'est poussé : sortie OCI locale. Le digest affiché se compare à celui que le job
# « Images » du pipeline publie pour ce commit (ligne « Image runner : …@sha256:… »).
# L'export force les fins de ligne LF : sous Windows avec core.autocrlf=true, un export
# ordinaire produirait d'autres octets que le CI Linux.
set -eu
COMMIT="$1"
WORK="$2"
COUNT="${3:-une}"
REPO="$(git rev-parse --show-toplevel)"
SRC="$WORK/src-$COMMIT"
mkdir -p "$WORK"
rm -rf "$SRC" && mkdir -p "$SRC"
git -C "$REPO" -c core.autocrlf=false archive --format=tar "$COMMIT" | tar -x -C "$SRC"
SOURCE_DATE_EPOCH="$(git -C "$REPO" log -1 --format=%ct "$COMMIT")"
export SOURCE_DATE_EPOCH
RUNS=1
if [ "$COUNT" = "deux" ]; then RUNS=2; fi
for n in $(seq 1 "$RUNS"); do
  docker buildx build --platform linux/amd64 --no-cache --provenance=false --sbom=false \
    --build-arg SOURCE_DATE_EPOCH -f "$SRC/Dockerfile.runner" \
    --output "type=oci,dest=$WORK/runner-$n.tar,rewrite-timestamp=true" "$SRC" > "$WORK/build-$n.log" 2>&1
  tar -xOf "$WORK/runner-$n.tar" index.json \
    | node -e 'let s="";process.stdin.on("data",(c)=>{s+=c;}).on("end",()=>console.log(JSON.parse(s).manifests[0].digest))' \
    > "$WORK/digest-$n.txt"
  echo "build $n : $(cat "$WORK/digest-$n.txt")"
done
if [ "$RUNS" = "2" ]; then
  if cmp -s "$WORK/digest-1.txt" "$WORK/digest-2.txt"; then
    echo "reproductible : digests identiques"
  else
    echo "NON reproductible : digests différents" >&2
    exit 1
  fi
fi
