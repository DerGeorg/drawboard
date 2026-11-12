#!/usr/bin/env bash
# Smoke test of the local observability stack (compose.observability.yaml):
# sends one trace, one log record and one metric via OTLP to Alloy with
# telemetrygen (on the compose network) and checks through Grafana's
# datasource proxy that they arrived in Tempo, Loki and Prometheus.
# Usage: dev/scripts/smoke-observability.sh   (stack must be up)
set -euo pipefail

GRAFANA="${GRAFANA:-http://localhost:13000}"
NETWORK="${NETWORK:-drawboard_default}"
IMAGE=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.162.0
SVC="smoke-$(date +%s)"
ATTR=(--otlp-attributes 'deployment.environment.name="dev"')

gen() { docker run --rm --network "$NETWORK" "$IMAGE" "$@" --otlp-endpoint alloy:4317 --otlp-insecure --service "$SVC" "${ATTR[@]}" >/dev/null 2>&1; }

echo "service.name=$SVC"
gen traces --traces 1
gen logs --logs 1 --body "smoke log line from $SVC"
gen metrics --metrics 1 --metric-type Sum --otlp-metric-name smoke_counter

q() { curl -sf -G "$GRAFANA/api/datasources/proxy/uid/$1" "${@:2}"; }
now=$(date +%s)

check() {   # name, command that prints a number > 0 on success
  local name=$1; shift
  for _ in $(seq 1 30); do
    n=$("$@" 2>/dev/null || echo 0)
    if [[ "${n:-0}" -gt 0 ]]; then echo "OK   $name ($n)"; return 0; fi
    sleep 2
  done
  echo "FAIL $name"; return 1
}

tempo() { q tempo/api/search --data-urlencode "tags=service.name=$SVC" --data-urlencode "start=$((now-600))" --data-urlencode "end=$((now+600))" |
          python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("traces", [])))'; }
loki()  { q loki/loki/api/v1/query_range --data-urlencode "query={service_name=\"$SVC\"}" --data-urlencode "start=$((now-600))" --data-urlencode "end=$((now+600))" |
          python3 -c 'import json,sys; print(sum(len(s["values"]) for s in json.load(sys.stdin)["data"]["result"]))'; }
prom()  { q prometheus/api/v1/query --data-urlencode "query=count({service_name=\"$SVC\", __name__!=\"target_info\"})" |
          python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else 0)'; }
spanm() { q prometheus/api/v1/query --data-urlencode "query=count(traces_spanmetrics_calls_total{service=\"$SVC\"})" |
          python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else 0)'; }

rc=0
check "trace   -> Tempo" tempo || rc=1
check "log     -> Loki" loki || rc=1
check "metric  -> Prometheus" prom || rc=1
check "spans   -> Tempo span-metrics -> Prometheus" spanm || rc=1
exit $rc
