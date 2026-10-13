#!/usr/bin/env bash
# Supprime le pod quand le GPU est resté inactif IDLE_MIN minutes d'affilée (défaut 30) : rien n'est facturé à vide.
# Lancé par pod_setup.sh ; les reçus doivent être rapatriés avant. Journal : runs/watchdog.log
set -uo pipefail
cd "$(dirname "$0")"
IDLE_MIN=${IDLE_MIN:-30}
mkdir -p runs
[ -f runs/watchdog.pid ] && kill -0 "$(cat runs/watchdog.pid)" 2>/dev/null && exit 0
echo $$ > runs/watchdog.pid

terminate() {
  echo "$(date -u +%FT%TZ) GPU inactif depuis $IDLE_MIN min, suppression de $RUNPOD_POD_ID" >> runs/watchdog.log
  if command -v runpodctl >/dev/null; then
    runpodctl remove pod "$RUNPOD_POD_ID" >> runs/watchdog.log 2>&1 && return
  fi
  curl -fsS -X DELETE "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer ${RUNPOD_API_KEY:-}" >> runs/watchdog.log 2>&1
}

if [ -z "${RUNPOD_POD_ID:-}" ]; then
  echo "$(date -u +%FT%TZ) RUNPOD_POD_ID absent : garde-fou inactif" >> runs/watchdog.log
  exit 1
fi
idle=0
while sleep 60; do
  util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | sort -n | tail -1)
  if [ "${util:-0}" -lt 5 ]; then idle=$((idle + 1)); else idle=0; fi
  [ "$idle" -ge "$IDLE_MIN" ] && terminate
done
