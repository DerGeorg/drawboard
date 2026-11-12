"""Alert rule of the Drawboard backend, in the tuple format of SERVICE_RULES in the homelab generator
(monitoring/grafana/gen_alerts.py, skill spring-kotlin-monitoring, references/alarme.md).

The local stack has no alert rules (provisioning/alerting/alerts.yml is empty on purpose), so the rule is kept here, next to the
dashboard generator, and moves into SERVICE_RULES of the homelab generator when the scanner goes to production
(docs/architecture.md, "Scanner in production only when"):

    from drawboard_alert_rules import DRAWBOARD_SERVICE_RULES   # or paste the tuple
    SERVICE_RULES += DRAWBOARD_SERVICE_RULES

Then `./monitoring/sync.sh gen`, check the expression with promtool, MR, and `sync.sh grafana` (Grafana reads rules at start).

PROD and SVC_BY are the generator's own constants (repeated here so the file stands alone).
"""

PROD = 'deployment_environment_name="prod"'
SVC_BY = "service_name, deployment_environment_name"

# (uid, title, promql, evaluator, threshold, for, severity, summary, description, nodata)
DRAWBOARD_SERVICE_RULES = [
    ("svc-drawboard-scan-unavailable", "Drawboard: Upload-Scanner nicht verfuegbar",
     f'sum by ({SVC_BY}) (increase(drawboard_scans_total{{{PROD},result="unavailable"}}[15m]))',
     "gt", 0, "0m", "warning",
     "{{ $labels.service_name }}: {{ with $values.A }}{{ humanize .Value }}{{ end }} Uploads in 15 Minuten nicht gescannt",
     "clamd antwortet nicht, ist zu langsam oder liefert Fehler (oder ein Blob liess sich nicht oeffnen). Bei "
     "DRAWBOARD_CLAMAV_FAIL_CLOSED=false werden die Dateien OHNE Scan angenommen, bei true mit 503 abgewiesen. "
     "clamd-Container und sein Netz pruefen; Verlauf im Dashboard '17 · Drawboard usage' (Files, Malware scans by result). "
     "Dateien ueber dem Limit (result=too_large) loesen diesen Alarm nicht aus.",
     "OK"),
]
