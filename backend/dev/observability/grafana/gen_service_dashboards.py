#!/usr/bin/env python3
"""Generates the service dashboards (folder "Services") for OTel Spring-Kotlin services.

Usage:  python3 dev/observability/grafana/gen_service_dashboards.py \
            dev/observability/grafana/provisioning/dashboards/services

Written in the style of infra/portainerstacks monitoring/grafana/gen_dashboards.py
(same helpers, fixed datasource uids, JSON committed, no UI edits) so it can be
moved into the homelab repo as monitoring/grafana/gen_service_dashboards.py
(research D §3.3). The helper block below is a copy of gen_dashboards.py plus
table/heatmap/nodegraph/tempo helpers; when porting, move it into lib_dash.py.

Metric flavor: Micrometer -> OTLP -> Prometheus OTLP receiver, with
management.otlp.metrics.export.base-time-unit=seconds. All names below were
verified against a running Boot 4.1.1 app (2026-09-30), e.g.
  http_server_requests_seconds_{bucket,count,sum}, http_server_requests_max_seconds
  jvm_memory_used_bytes{area,id}, jvm_gc_pause_seconds_*, jvm_threads_live,
  jvm_threads_states{state}, jvm_classes_loaded, process_cpu_usage,
  r2dbc_pool_{acquired,allocated,idle,pending,max_allocated}_connections,
  r2dbc_query_seconds_*, spring_data_repository_invocations_seconds_*,
  app_method_seconds_*{code_namespace,code_function,error}  (@WithSpan aspect),
  logback_events_total{level}, target_info.
Resource attributes are promoted to labels by Prometheus (otlp.promote_resource_attributes):
service_name, service_namespace, service_version, deployment_environment_name, host_name.
Tempo metrics-generator: traces_spanmetrics_* (labels service, span_name, span_kind,
status_code, deployment_environment_name), traces_service_graph_*.
Loki: docker stream of the app container, labels service_name, deployment_environment_name,
structured metadata trace_id / span_id / request_id / level (Alloy ECS stage).
Drawboard usage (17): the application's own product metrics, see the comment at section 17.
Frontend (16): Faro lines from Alloy faro.receiver, labels job="faro", kind, service_name,
deployment_environment_name; structured metadata trace_id / session_id (details at section 16).
"""
import json
import os
import sys

OUT = sys.argv[1]
PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}
TAGS = ["services"]


# ------------------------------------------------------------ helpers (gen_dashboards.py)
def target(expr, legend, instant=False, ref="A", exemplar=False, fmt=None):
    t = {"datasource": PROM, "expr": expr, "legendFormat": legend, "refId": ref,
         "editorMode": "code", "range": not instant, "instant": instant}
    if exemplar:
        t["exemplar"] = True
    if fmt:
        t["format"] = fmt
    return t


def loki_target(expr, ref="A", legend="", qtype="range"):
    return {"datasource": LOKI, "expr": expr, "refId": ref, "editorMode": "code",
            "queryType": qtype, "legendFormat": legend}


def tempo_target(query, ref="A", limit=20):
    return {"datasource": TEMPO, "refId": ref, "queryType": "traceql", "query": query,
            "limit": limit, "tableType": "traces"}


REDUCE = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}}


def panel(ptype, title, gp, targets, unit=None, minv=None, maxv=None, thresholds=None,
          desc=None, opts=None, mappings=None, legend_table=False, ds=PROM, decimals=None,
          stack=False, overrides=None, transformations=None):
    steps = thresholds or [{"color": "green", "value": None}]
    p = {
        "type": ptype, "title": title, "gridPos": gp, "datasource": ds, "targets": targets,
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic" if ptype == "timeseries" else "thresholds"},
                "mappings": mappings or [],
                "thresholds": {"mode": "absolute", "steps": steps},
            },
            "overrides": overrides or [],
        },
        "options": opts or {},
    }
    d = p["fieldConfig"]["defaults"]
    if unit:
        d["unit"] = unit
    if minv is not None:
        d["min"] = minv
    if maxv is not None:
        d["max"] = maxv
    if decimals is not None:
        d["decimals"] = decimals
    if desc:
        p["description"] = desc
    if transformations:
        p["transformations"] = transformations
    if ptype == "timeseries":
        d["custom"] = {"drawStyle": "line", "lineWidth": 1, "fillOpacity": 8, "showPoints": "never",
                       "spanNulls": True, "scaleDistribution": {"type": "linear"},
                       "stacking": {"mode": "normal" if stack else "none", "group": "A"},
                       "thresholdsStyle": {"mode": "line" if thresholds else "off"}}
        p["options"] = {
            "legend": {"displayMode": "table" if legend_table else "list", "placement": "bottom",
                       "showLegend": True, "calcs": ["mean", "max", "lastNotNull"] if legend_table else []},
            "tooltip": {"mode": "multi", "sort": "desc"},
        }
    return p


def ts(title, gp, targets, **kw):
    return panel("timeseries", title, gp, targets, **kw)


def stat(title, gp, targets, **kw):
    kw.setdefault("opts", {"colorMode": "background", "graphMode": "none", "textMode": "value_and_name", **REDUCE})
    return panel("stat", title, gp, targets, **kw)


def bars(title, gp, targets, **kw):
    kw.setdefault("opts", {"displayMode": "gradient", "orientation": "horizontal", **REDUCE})
    return panel("bargauge", title, gp, targets, **kw)


def row(title, y):
    return {"type": "row", "title": title, "collapsed": False, "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}, "panels": []}


def logs(title, gp, expr, desc=None):
    p = {"type": "logs", "title": title, "gridPos": gp, "datasource": LOKI,
         "targets": [loki_target(expr)],
         "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending",
                     "enableLogDetails": True, "dedupStrategy": "none", "prettifyLogMessage": False}}
    if desc:
        p["description"] = desc
    return p


def alertlist(title, gp):
    return {"type": "alertlist", "title": title, "gridPos": gp,
            "options": {"viewMode": "list", "groupMode": "default", "maxItems": 30, "sortOrder": 1,
                        "dashboardAlerts": False, "alertName": "", "alertInstanceLabelFilter": "",
                        "folder": "", "stateFilter": {"firing": True, "pending": True, "noData": False,
                                                      "normal": False, "error": True}}}


# ------------------------------------------------------------ extra helpers (services)
def table(title, gp, targets, desc=None, transformations=None, overrides=None, ds=PROM, unit=None):
    p = panel("table", title, gp, targets, desc=desc, ds=ds, unit=unit, overrides=overrides,
              transformations=transformations,
              opts={"showHeader": True, "cellHeight": "sm", "footer": {"show": False}})
    return p


def heatmap(title, gp, expr, desc=None):
    return {"type": "heatmap", "title": title, "gridPos": gp, "datasource": PROM,
            "description": desc or "",
            "targets": [{**target(expr, "{{le}}"), "format": "heatmap", "exemplar": True}],
            "options": {"calculate": False, "yAxis": {"unit": "s"}, "cellGap": 1,
                        "color": {"mode": "scheme", "scheme": "Oranges", "steps": 64},
                        "exemplars": {"color": "rgba(255,0,255,0.7)"},
                        "tooltip": {"mode": "single", "yHistogram": True},
                        "rowsFrame": {"layout": "auto"}, "legend": {"show": False}},
            "fieldConfig": {"defaults": {}, "overrides": []}}


def nodegraph(title, gp, prom_filter, desc=None):
    return {"type": "nodeGraph", "title": title, "gridPos": gp, "datasource": TEMPO,
            "description": desc or "",
            "targets": [{"datasource": TEMPO, "refId": "A", "queryType": "serviceMap",
                         "serviceMapQuery": prom_filter}],
            "options": {}, "fieldConfig": {"defaults": {}, "overrides": []}}


def traces_table(title, gp, query, desc=None):
    return {"type": "table", "title": title, "gridPos": gp, "datasource": TEMPO,
            "description": desc or "", "targets": [tempo_target(query)],
            "options": {"showHeader": True, "cellHeight": "sm"},
            "fieldConfig": {"defaults": {}, "overrides": []}}


def dash(uid, title, tags, panels, templating=None, refresh="30s", time_from="now-1h"):
    return {"uid": uid, "title": title, "tags": tags, "timezone": "browser", "schemaVersion": 39,
            "version": 1, "refresh": refresh, "editable": False, "graphTooltip": 1,
            "time": {"from": time_from, "to": "now"}, "templating": {"list": templating or []},
            "panels": panels, "links": [{"title": "Services", "type": "dashboards", "tags": TAGS,
                                         "asDropdown": True, "includeVars": True, "keepTime": True}]}


def var_query(name, query, label, multi=True, allv=True, ds=PROM, regex="", stream=""):
    v = {"name": name, "label": label, "type": "query", "datasource": ds,
         "definition": query, "refresh": 2, "sort": 1, "multi": multi, "includeAll": allv,
         "current": {"selected": True, "text": ["All"], "value": ["$__all"]} if allv else {},
         "regex": regex, "options": []}
    if ds is PROM:
        v["query"] = {"qryType": 1, "query": query, "refId": name}
    else:
        v["query"] = {"label": query, "type": 1, "stream": stream, "refId": name}
        # Loki rejects selectors that also match empty ({x=~".*"}) -> "All" = ".+"
        v["allValue"] = ".+"
    return v


def var_text(name, label, default=""):
    return {"name": name, "label": label, "type": "textbox", "query": default,
            "current": {"text": default, "value": default}, "hide": 0}


def var_custom(name, label, values, all_value=".*"):
    opts = ",".join(values)
    return {"name": name, "label": label, "type": "custom", "query": opts, "multi": True,
            "includeAll": True, "allValue": all_value,
            "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
            "options": []}


GREEN_ORANGE_RED = lambda o, r: [{"color": "green", "value": None}, {"color": "orange", "value": o},  # noqa: E731
                                 {"color": "red", "value": r}]

# ------------------------------------------------------------ selectors / variables
ENV_VAR = var_query("env", "label_values(target_info, deployment_environment_name)", "Umgebung")
SVC_VAR = var_query("service", 'label_values(target_info{deployment_environment_name=~"$env"}, service_name)', "Dienst")
ROUTE_VAR = var_query("route", 'label_values(http_server_requests_seconds_count{service_name=~"$service",deployment_environment_name=~"$env"}, uri)', "Route")
STD_VARS = [ENV_VAR, SVC_VAR]

S = 'service_name=~"$service",deployment_environment_name=~"$env"'           # Micrometer via OTLP
SR = S + ',uri=~"$route"'                                                    # + route
SM = 'service=~"$service",deployment_environment_name=~"$env"'               # Tempo span metrics
HTTP = "http_server_requests_seconds"
RI = "$__rate_interval"


def q_rate(sel, by):
    return f"sum by ({by}) (rate({HTTP}_count{{{sel}}}[{RI}]))"


def q_err_ratio(sel, by):
    # "or 0 * total" -> 0 % instead of "no data" while there are no 5xx at all
    total = f"sum by ({by}) (rate({HTTP}_count{{{sel}}}[{RI}]))"
    return (f'(sum by ({by}) (rate({HTTP}_count{{{sel},status=~"5.."}}[{RI}])) or 0 * {total})'
            f" / {total}")


def q_quantile(qv, sel, by, metric=HTTP):
    return f"histogram_quantile({qv}, sum by (le, {by}) (rate({metric}_bucket{{{sel}}}[{RI}])))"


LAST_SEEN = ('time() - max by (service_name, deployment_environment_name) '
             '(last_over_time(timestamp(target_info{deployment_environment_name=~"$env"})[24h:30s]))')

# ================================================================ 10 Services (overview)
BY = "service_name, deployment_environment_name"
merge_organize = [
    {"id": "merge", "options": {}},
    {"id": "organize", "options": {
        "excludeByName": {"Time": True},
        "renameByName": {"service_name": "Dienst", "deployment_environment_name": "Umgebung",
                         "Value #A": "Req/s", "Value #B": "Fehler (5xx)", "Value #C": "p95",
                         "Value #D": "Letzte Telemetrie", "Value #E": "Version"},
        "indexByName": {"service_name": 0, "deployment_environment_name": 1}}},
]
overview_table_overrides = [
    {"matcher": {"id": "byName", "options": "Req/s"}, "properties": [{"id": "unit", "value": "reqps"}, {"id": "decimals", "value": 2}]},
    {"matcher": {"id": "byName", "options": "Fehler (5xx)"}, "properties": [
        {"id": "unit", "value": "percentunit"},
        {"id": "custom.cellOptions", "value": {"type": "color-background"}},
        {"id": "thresholds", "value": {"mode": "absolute", "steps": GREEN_ORANGE_RED(0.01, 0.05)}}]},
    {"matcher": {"id": "byName", "options": "p95"}, "properties": [
        {"id": "unit", "value": "s"},
        {"id": "custom.cellOptions", "value": {"type": "color-background"}},
        {"id": "thresholds", "value": {"mode": "absolute", "steps": GREEN_ORANGE_RED(0.5, 1)}}]},
    {"matcher": {"id": "byName", "options": "Letzte Telemetrie"}, "properties": [
        {"id": "unit", "value": "s"}, {"id": "decimals", "value": 0},
        {"id": "custom.cellOptions", "value": {"type": "color-background"}},
        {"id": "thresholds", "value": {"mode": "absolute", "steps": GREEN_ORANGE_RED(120, 300)}}]},
]
overview = dash("svc-overview", "10 · Services", TAGS + ["overview"], templating=STD_VARS, panels=[
    stat("Dienste mit Telemetrie", {"h": 4, "w": 6, "x": 0, "y": 0},
         [target(f'count(count by ({BY}) (target_info{{{S}}}))', "Dienste", True)],
         opts={"colorMode": "value", "graphMode": "none", "textMode": "value", **REDUCE}),
    stat("Requests/s", {"h": 4, "w": 6, "x": 6, "y": 0},
         [target(f"sum(rate({HTTP}_count{{{S}}}[5m]))", "Req/s", True)], unit="reqps", decimals=2,
         opts={"colorMode": "value", "graphMode": "area", "textMode": "value", **REDUCE}),
    stat("Fehlerquote (5xx)", {"h": 4, "w": 6, "x": 12, "y": 0},
         [target(f'(sum(rate({HTTP}_count{{{S},status=~"5.."}}[5m])) or 0 * sum(rate({HTTP}_count{{{S}}}[5m]))) / sum(rate({HTTP}_count{{{S}}}[5m]))', "5xx", True)],
         unit="percentunit", decimals=2, thresholds=GREEN_ORANGE_RED(0.01, 0.05)),
    stat("p95 Latenz", {"h": 4, "w": 6, "x": 18, "y": 0},
         [target(f"histogram_quantile(0.95, sum by (le) (rate({HTTP}_bucket{{{S}}}[5m])))", "p95", True)],
         unit="s", thresholds=GREEN_ORANGE_RED(0.5, 1)),

    table("Dienste je Umgebung", {"h": 8, "w": 24, "x": 0, "y": 4}, [
        target(q_rate(S, BY).replace(RI, "5m"), "", True, "A", fmt="table"),
        target(q_err_ratio(S, BY).replace(RI, "5m"), "", True, "B", fmt="table"),
        target(q_quantile(0.95, S, BY).replace(RI, "5m"), "", True, "C", fmt="table"),
        target(LAST_SEEN, "", True, "D", fmt="table"),
    ], transformations=merge_organize, overrides=overview_table_overrides,
        desc="Req/s, 5xx-Quote und p95 aus http.server.requests (5 min). 'Letzte Telemetrie' = Sekunden "
             "seit dem letzten OTLP-Metrik-Push (target_info); ueber 5 min = Dienst weg oder OTLP-Weg kaputt."),

    ts("Requests/s je Dienst", {"h": 8, "w": 12, "x": 0, "y": 12},
       [target(q_rate(S, BY), "{{service_name}} ({{deployment_environment_name}})")], unit="reqps", legend_table=True),
    ts("p95 je Dienst", {"h": 8, "w": 12, "x": 12, "y": 12},
       [target(q_quantile(0.95, S, BY), "{{service_name}} ({{deployment_environment_name}})", exemplar=True)],
       unit="s", legend_table=True, desc="Punkte = Exemplare, Klick oeffnet den Trace in Tempo."),
    nodegraph("Service-Map (Tempo)", {"h": 10, "w": 12, "x": 0, "y": 20},
              '{deployment_environment_name=~"$env"}',
              desc="Aus traces_service_graph_* des Tempo metrics-generators. Datenbanken erscheinen als "
                   "virtuelle Knoten (peer.service / db.system)."),
    alertlist("Aktive Alarme", {"h": 10, "w": 12, "x": 12, "y": 20}),
])

# ================================================================ 11 HTTP (RED)
RBY = "uri, method"
http = dash("svc-http", "11 · HTTP (RED)", TAGS + ["http"], templating=STD_VARS + [ROUTE_VAR], panels=[
    ts("Requests/s je Route", {"h": 8, "w": 12, "x": 0, "y": 0},
       [target(q_rate(SR, RBY), "{{method}} {{uri}}")], unit="reqps", legend_table=True),
    ts("Fehlerquote (5xx) je Route", {"h": 8, "w": 12, "x": 12, "y": 0},
       [target(q_err_ratio(SR, RBY), "{{method}} {{uri}}")], unit="percentunit", minv=0,
       thresholds=GREEN_ORANGE_RED(0.01, 0.05), legend_table=True),

    ts("Latenz p50 / p95 / p99 je Route", {"h": 9, "w": 12, "x": 0, "y": 8},
       [target(q_quantile(0.5, SR, RBY), "p50 {{method}} {{uri}}", ref="A"),
        target(q_quantile(0.95, SR, RBY), "p95 {{method}} {{uri}}", ref="B", exemplar=True),
        target(q_quantile(0.99, SR, RBY), "p99 {{method}} {{uri}}", ref="C")],
       unit="s", legend_table=True,
       desc="Braucht management.metrics.distribution.percentiles-histogram.http.server.requests=true. "
            "Exemplar-Punkte fuehren direkt zum Trace."),
    heatmap("Latenzverteilung", {"h": 9, "w": 12, "x": 12, "y": 8},
            f"sum by (le) (increase({HTTP}_bucket{{{SR}}}[{RI}]))",
            desc="Alle gewaehlten Routen zusammen; Exemplare eingeblendet."),

    ts("Statuscodes", {"h": 8, "w": 12, "x": 0, "y": 17},
       [target(f"sum by (status) (rate({HTTP}_count{{{SR}}}[{RI}]))", "{{status}}")],
       unit="reqps", stack=True, legend_table=True),
    ts("Ausnahmen", {"h": 8, "w": 12, "x": 12, "y": 17},
       [target(f'sum by (exception, uri) (rate({HTTP}_count{{{SR},exception!="none"}}[{RI}]))', "{{exception}} @ {{uri}}")],
       unit="reqps", legend_table=True, desc="Label exception von http.server.requests (none = keine)."),

    table("Langsamste Routen (p95, Zeitraum)", {"h": 8, "w": 12, "x": 0, "y": 25},
          [target(f"topk(10, histogram_quantile(0.95, sum by (le, {RBY}) (rate({HTTP}_bucket{{{SR}}}[$__range]))))", "", True, fmt="table")],
          unit="s", transformations=[{"id": "organize", "options": {"excludeByName": {"Time": True},
                                                                   "renameByName": {"Value": "p95"}}}]),
    table("Meistgenutzte Routen (Zeitraum)", {"h": 8, "w": 12, "x": 12, "y": 25},
          [target(f"topk(10, sum by ({RBY}) (increase({HTTP}_count{{{SR}}}[$__range])))", "", True, fmt="table")],
          transformations=[{"id": "organize", "options": {"excludeByName": {"Time": True},
                                                          "renameByName": {"Value": "Requests"}}}]),
    ts("Max. Latenz je Route (Micrometer max)", {"h": 8, "w": 24, "x": 0, "y": 33},
       [target(f"max by ({RBY}) (http_server_requests_max_seconds{{{SR}}})", "{{method}} {{uri}}")],
       unit="s", legend_table=True,
       desc="Hoechster Einzelwert je Export-Intervall (OTLP-Name: http_server_requests_max_seconds)."),
])

# ================================================================ 12 Spans & Service Map
SPAN_VAR = var_query("span", f'label_values(traces_spanmetrics_calls_total{{{SM}}}, span_name)', "Span")
SMS = SM + ',span_name=~"$span"'
SBY = "span_name"
spans = dash("svc-spans", "12 · Spans & Service-Map", TAGS + ["traces"], templating=STD_VARS + [SPAN_VAR], panels=[
    nodegraph("Service-Map", {"h": 10, "w": 24, "x": 0, "y": 0},
              '{deployment_environment_name=~"$env"}'),

    row("@WithSpan-Funktionen (SPAN_KIND_INTERNAL, Tempo span-metrics)", 10),
    ts("Aufrufe/s je Funktion", {"h": 8, "w": 8, "x": 0, "y": 11},
       [target(f'sum by ({SBY}) (rate(traces_spanmetrics_calls_total{{{SMS},span_kind="SPAN_KIND_INTERNAL"}}[{RI}]))', "{{span_name}}")],
       unit="ops", legend_table=True),
    ts("Fehler/s je Funktion", {"h": 8, "w": 8, "x": 8, "y": 11},
       [target(f'sum by ({SBY}) (rate(traces_spanmetrics_calls_total{{{SMS},span_kind="SPAN_KIND_INTERNAL",status_code="STATUS_CODE_ERROR"}}[{RI}]))', "{{span_name}}")],
       unit="ops", legend_table=True),
    ts("p95 je Funktion", {"h": 8, "w": 8, "x": 16, "y": 11},
       [target(f'histogram_quantile(0.95, sum by (le, {SBY}) (rate(traces_spanmetrics_latency_bucket{{{SMS},span_kind="SPAN_KIND_INTERNAL"}}[{RI}])))', "{{span_name}}", exemplar=True)],
       unit="s", legend_table=True),

    row("Eingehend (SERVER) und ausgehend (CLIENT: DB, HTTP)", 19),
    table("RED je Span (Zeitraum)", {"h": 10, "w": 24, "x": 0, "y": 20}, [
        target(f"sum by (span_kind, {SBY}) (increase(traces_spanmetrics_calls_total{{{SMS}}}[$__range]))", "", True, "A", fmt="table"),
        target(f'sum by (span_kind, {SBY}) (increase(traces_spanmetrics_calls_total{{{SMS},status_code="STATUS_CODE_ERROR"}}[$__range]))', "", True, "B", fmt="table"),
        target(f"histogram_quantile(0.95, sum by (le, span_kind, {SBY}) (rate(traces_spanmetrics_latency_bucket{{{SMS}}}[$__range])))", "", True, "C", fmt="table"),
    ], transformations=[
        {"id": "merge", "options": {}},
        {"id": "organize", "options": {"excludeByName": {"Time": True},
                                       "renameByName": {"Value #A": "Aufrufe", "Value #B": "Fehler", "Value #C": "p95"}}}],
        overrides=[{"matcher": {"id": "byName", "options": "p95"}, "properties": [{"id": "unit", "value": "s"}]}],
        desc="Alle Span-Arten. SERVER = HTTP-Routen, INTERNAL = @WithSpan, CLIENT = R2DBC/JDBC-Queries und WebClient/RestClient."),

    row("Micrometer app.method (derselbe @WithSpan-Aspekt, als OTLP-Metrik)", 30),
    ts("Aufrufe/s je Funktion (app.method)", {"h": 8, "w": 12, "x": 0, "y": 31},
       [target(f'sum by (code_namespace, code_function) (rate(app_method_seconds_count{{{S}}}[{RI}]))', "{{code_namespace}}.{{code_function}}")],
       unit="ops", legend_table=True,
       desc="Timer 'app.method' des WithSpanAspect; gleiche Aussage wie die Span-Metrics, aber mit Label error."),
    ts("p95 je Funktion (app.method)", {"h": 8, "w": 12, "x": 12, "y": 31},
       [target(f'histogram_quantile(0.95, sum by (le, code_namespace, code_function) (rate(app_method_seconds_bucket{{{S}}}[{RI}])))', "{{code_namespace}}.{{code_function}}", exemplar=True)],
       unit="s", legend_table=True),

    traces_table("Letzte fehlerhafte Traces", {"h": 10, "w": 24, "x": 0, "y": 39},
                 '{resource.service.name=~"${service:regex}" && status=error}',
                 desc="TraceQL; Klick auf die Trace-ID oeffnet den Trace."),
])

# ================================================================ 13 JVM
JBY = "service_name"
jvm = dash("svc-jvm", "13 · JVM", TAGS + ["jvm"], templating=STD_VARS, panels=[
    stat("Uptime", {"h": 4, "w": 6, "x": 0, "y": 0},
         [target(f"max by ({JBY}) (process_uptime_seconds{{{S}}})", "{{service_name}}", True)], unit="s",
         opts={"colorMode": "value", "graphMode": "none", "textMode": "value_and_name", **REDUCE}),
    stat("Neustarts (24 h)", {"h": 4, "w": 6, "x": 6, "y": 0},
         [target(f"sum by ({JBY}) (changes(process_start_time_seconds{{{S}}}[24h]))", "{{service_name}}", True)],
         thresholds=GREEN_ORANGE_RED(1, 3)),
    stat("Heap nach GC", {"h": 4, "w": 6, "x": 12, "y": 0},
         [target(f"max by ({JBY}) (jvm_gc_live_data_size_bytes{{{S}}} / jvm_gc_max_data_size_bytes{{{S}}})", "{{service_name}}", True)],
         unit="percentunit", thresholds=GREEN_ORANGE_RED(0.8, 0.9),
         desc="Live-Daten nach dem letzten GC / maximale Old-Gen. Dauerhaft > 90 % = Speicherleck oder zu wenig Heap."),
    stat("CPU (Prozess)", {"h": 4, "w": 6, "x": 18, "y": 0},
         [target(f"max by ({JBY}) (process_cpu_usage{{{S}}})", "{{service_name}}", True)],
         unit="percentunit", thresholds=GREEN_ORANGE_RED(0.7, 0.9)),

    ts("Heap", {"h": 8, "w": 12, "x": 0, "y": 4},
       [target(f'sum by ({JBY}) (jvm_memory_used_bytes{{{S},area="heap"}})', "{{service_name}} belegt", ref="A"),
        target(f'sum by ({JBY}) (jvm_memory_committed_bytes{{{S},area="heap"}})', "{{service_name}} committed", ref="B"),
        target(f'sum by ({JBY}) (jvm_memory_max_bytes{{{S},area="heap"}} > 0)', "{{service_name}} max", ref="C")],
       unit="bytes", legend_table=True),
    ts("Speicher je Pool", {"h": 8, "w": 12, "x": 12, "y": 4},
       [target(f"sum by (area, id) (jvm_memory_used_bytes{{{S}}})", "{{area}}: {{id}}")],
       unit="bytes", legend_table=True),

    ts("GC-Pausen/s", {"h": 8, "w": 8, "x": 0, "y": 12},
       [target(f"sum by (gc, action) (rate(jvm_gc_pause_seconds_count{{{S}}}[{RI}]))", "{{gc}} ({{action}})")],
       unit="ops", legend_table=True),
    ts("GC-Zeit (Anteil)", {"h": 8, "w": 8, "x": 8, "y": 12},
       [target(f"sum by (gc) (rate(jvm_gc_pause_seconds_sum{{{S}}}[{RI}]))", "{{gc}} Pause", ref="A"),
        target(f"sum by (gc) (rate(jvm_gc_concurrent_phase_time_seconds_sum{{{S}}}[{RI}]))", "{{gc}} nebenlaeufig", ref="B")],
       unit="percentunit", legend_table=True, desc="Sekunden GC pro Sekunde; Pause = Anwendung steht."),
    ts("Allokation / Promotion", {"h": 8, "w": 8, "x": 16, "y": 12},
       [target(f"sum by ({JBY}) (rate(jvm_gc_memory_allocated_bytes_total{{{S}}}[{RI}]))", "{{service_name}} alloziert", ref="A"),
        target(f"sum by ({JBY}) (rate(jvm_gc_memory_promoted_bytes_total{{{S}}}[{RI}]))", "{{service_name}} promoted", ref="B")],
       unit="Bps", legend_table=True),

    ts("Threads", {"h": 8, "w": 8, "x": 0, "y": 20},
       [target(f"sum by ({JBY}) (jvm_threads_live{{{S}}})", "{{service_name}} live", ref="A"),
        target(f"sum by ({JBY}) (jvm_threads_daemon{{{S}}})", "{{service_name}} daemon", ref="B"),
        target(f"sum by ({JBY}) (jvm_threads_peak{{{S}}})", "{{service_name}} peak", ref="C")],
       legend_table=True, desc="OTLP-Namen ohne _threads-Suffix (jvm_threads_live, nicht jvm_threads_live_threads)."),
    ts("Thread-Zustaende", {"h": 8, "w": 8, "x": 8, "y": 20},
       [target(f"sum by (state) (jvm_threads_states{{{S}}})", "{{state}}")], stack=True, legend_table=True),
    ts("CPU", {"h": 8, "w": 8, "x": 16, "y": 20},
       [target(f"max by ({JBY}) (process_cpu_usage{{{S}}})", "{{service_name}} Prozess", ref="A"),
        target(f"max by ({JBY}) (system_cpu_usage{{{S}}})", "{{service_name}} System", ref="B")],
       unit="percentunit", minv=0, legend_table=True),

    ts("Geladene Klassen", {"h": 7, "w": 8, "x": 0, "y": 28},
       [target(f"sum by ({JBY}) (jvm_classes_loaded{{{S}}})", "{{service_name}}")], legend_table=True),
    ts("Direkte Buffer", {"h": 7, "w": 8, "x": 8, "y": 28},
       [target(f"sum by (id) (jvm_buffer_memory_used_bytes{{{S}}})", "{{id}}")], unit="bytes", legend_table=True,
       desc="Netty (WebFlux) arbeitet mit direct buffers."),
    ts("Log-Ereignisse/s (logback)", {"h": 7, "w": 8, "x": 16, "y": 28},
       [target(f"sum by (level) (rate(logback_events_total{{{S}}}[{RI}]))", "{{level}}")], unit="ops", legend_table=True),
])

# ================================================================ 14 Datenbank
db = dash("svc-db", "14 · Datenbank", TAGS + ["db"], templating=STD_VARS, panels=[
    row("R2DBC-Pool (WebFlux)", 0),
    ts("Verbindungen", {"h": 8, "w": 12, "x": 0, "y": 1},
       [target(f"sum by (name) (r2dbc_pool_acquired_connections{{{S}}})", "{{name}} in Benutzung", ref="A"),
        target(f"sum by (name) (r2dbc_pool_idle_connections{{{S}}})", "{{name}} frei", ref="B"),
        target(f"sum by (name) (r2dbc_pool_allocated_connections{{{S}}})", "{{name}} offen", ref="C"),
        target(f"sum by (name) (r2dbc_pool_max_allocated_connections{{{S}}})", "{{name}} max", ref="D")],
       legend_table=True),
    ts("Wartende Anfragen", {"h": 8, "w": 12, "x": 12, "y": 1},
       [target(f"sum by (name) (r2dbc_pool_pending_connections{{{S}}})", "{{name}}")],
       thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}], legend_table=True,
       desc="> 0 ueber laengere Zeit = Pool zu klein oder Queries zu langsam."),

    row("HikariCP (MVC / JDBC)", 9),
    ts("Verbindungen", {"h": 8, "w": 12, "x": 0, "y": 10},
       [target(f"sum by (pool) (hikaricp_connections_active{{{S}}})", "{{pool}} aktiv", ref="A"),
        target(f"sum by (pool) (hikaricp_connections_idle{{{S}}})", "{{pool}} frei", ref="B"),
        target(f"sum by (pool) (hikaricp_connections_pending{{{S}}})", "{{pool}} wartend", ref="C"),
        target(f"sum by (pool) (hikaricp_connections_max{{{S}}})", "{{pool}} max", ref="D")],
       legend_table=True, desc="Leer bei WebFlux-Diensten. Namen nicht gegen eine laufende MVC-App verifiziert."),
    ts("Wartezeit auf Verbindung (p95)", {"h": 8, "w": 12, "x": 12, "y": 10},
       [target(f"histogram_quantile(0.95, sum by (le, pool) (rate(hikaricp_connections_acquire_seconds_bucket{{{S}}}[{RI}])))", "{{pool}} p95", ref="A"),
        target(f"sum by (pool) (rate(hikaricp_connections_acquire_seconds_sum{{{S}}}[{RI}])) / sum by (pool) (rate(hikaricp_connections_acquire_seconds_count{{{S}}}[{RI}]))", "{{pool}} Mittel", ref="B")],
       unit="s", legend_table=True),

    row("Queries", 18),
    ts("R2DBC-Queries/s", {"h": 8, "w": 8, "x": 0, "y": 19},
       [target(f"sum by (error) (rate(r2dbc_query_seconds_count{{{S}}}[{RI}]))", "error={{error}}")],
       unit="ops", legend_table=True, desc="r2dbc-proxy-Observation 'r2dbc.query'."),
    ts("R2DBC-Query-Latenz", {"h": 8, "w": 8, "x": 8, "y": 19},
       [target(f"histogram_quantile(0.95, sum by (le) (rate(r2dbc_query_seconds_bucket{{{S}}}[{RI}])))", "p95", ref="A", exemplar=True),
        target(f"max(r2dbc_query_max_seconds{{{S}}})", "max", ref="B")],
       unit="s", legend_table=True),
    ts("DB-Spans (CLIENT) p95", {"h": 8, "w": 8, "x": 16, "y": 19},
       [target(f'histogram_quantile(0.95, sum by (le, span_name) (rate(traces_spanmetrics_latency_bucket{{{SM},span_kind="SPAN_KIND_CLIENT"}}[{RI}])))', "{{span_name}}", exemplar=True)],
       unit="s", legend_table=True,
       desc="Tempo span-metrics; R2DBC-Spans heissen 'query', JDBC (datasource-micrometer) 'SELECT <tabelle>' usw."),

    ts("Repository-Aufrufe/s", {"h": 8, "w": 12, "x": 0, "y": 27},
       [target(f"sum by (repository, method) (rate(spring_data_repository_invocations_seconds_count{{{S}}}[{RI}]))", "{{repository}}.{{method}}")],
       unit="ops", legend_table=True),
    ts("Repository-Latenz p95", {"h": 8, "w": 12, "x": 12, "y": 27},
       [target(f"histogram_quantile(0.95, sum by (le, repository, method) (rate(spring_data_repository_invocations_seconds_bucket{{{S}}}[{RI}])))", "{{repository}}.{{method}}")],
       unit="s", legend_table=True),
])

# ================================================================ 15 Logs
L_ENV = var_query("env", "deployment_environment_name", "Umgebung", ds=LOKI)
L_SVC = var_query("service", "service_name", "Dienst", ds=LOKI, stream='{deployment_environment_name=~"$env"}')
L_LVL = var_custom("level", "Level", ["error", "warn", "info", "debug", "trace"])
L_SEARCH = var_text("search", "Suche (Regex)")
LS = '{service_name=~"$service", deployment_environment_name=~"$env"}'
LP = '| detected_level=~"$level" |~ "$search"'
logs_dash = dash("svc-logs", "15 · Logs", TAGS + ["logs"], templating=[L_ENV, L_SVC, L_LVL, L_SEARCH],
                 time_from="now-3h", panels=[
    ts("Log-Zeilen je Level", {"h": 7, "w": 12, "x": 0, "y": 0},
       [loki_target(f'sum by (detected_level) (count_over_time({LS} {LP} [$__auto]))', legend="{{detected_level}}")],
       ds=LOKI, stack=True, legend_table=True),
    ts("Fehler je Dienst", {"h": 7, "w": 12, "x": 12, "y": 0},
       [loki_target(f'sum by (service_name) (count_over_time({LS} | detected_level=~"error|fatal|critical" [$__auto]))', legend="{{service_name}}")],
       ds=LOKI, legend_table=True),
    logs("Fehler und Warnungen", {"h": 9, "w": 24, "x": 0, "y": 7},
         f'{LS} | detected_level=~"error|warn|fatal|critical" |~ "$search"',
         desc="Log-Details zeigen trace_id / request_id; 'Trace oeffnen' springt nach Tempo."),
    logs("Logs", {"h": 16, "w": 24, "x": 0, "y": 16}, f"{LS} {LP}",
         desc="Einzelnen Request finden: Suche nach der Request-ID oder in Explore "
              f'{{service_name="…"}} | request_id="<X-Request-Id>".'),
])

# ================================================================ 16 Frontend (Faro)
# Browser telemetry of the Angular frontend (Grafana Faro Web SDK -> Alloy faro.receiver). Data, verified against
# Alloy v1.20.1 + Loki 3.7.8 (research N4):
#   Loki stream labels  job="faro", kind=log|exception|measurement|event,
#                       service_name (= Faro app.name), deployment_environment_name (= app.environment)
#   structured metadata trace_id, session_id
#   line (logfmt)       measurements: type=web-vitals lcp=… | inp=… | cls=… | fcp=… | ttfb=… context_rating=…
#                       exceptions:   type value stacktrace hash context_source
#                       events:       event_name=view_changed|session_start|faro.tracing.fetch …
#                                     faro.tracing.fetch: event_data_url.full, event_data_http.response.status_code,
#                                     event_data_duration_ns
#                       every line:   view_name (route template), page_url (no query), browser_name, app_release
#   Tempo               resource.service.name = Faro app.name, span kind CLIENT, parent of the backend span
# Note: plain "| logfmt" on purpose - "| logfmt lcp, view_name" returned an empty view_name in Loki 3.7.8.
F_ENV = var_query("env", "deployment_environment_name", "Umgebung", ds=LOKI, stream='{job="faro"}')
F_APP = var_query("app", "service_name", "App", ds=LOKI, stream='{job="faro", deployment_environment_name=~"$env"}')
F_VIEW = var_query("view", "view_name", "View", ds=LOKI,
                   stream='{job="faro", service_name=~"$app", deployment_environment_name=~"$env"}')
F = '{job="faro", service_name=~"$app", deployment_environment_name=~"$env", kind="%s"}'
FV = '| view_name=~"$view"'

# Core Web Vitals thresholds (web.dev): good / needs improvement / poor
VITALS = [  # (field, title, unit, good, poor, description)
    ("lcp", "LCP", "ms", 2500, 4000, "Largest Contentful Paint - wann der groesste Inhalt sichtbar ist. Gut <= 2,5 s."),
    ("inp", "INP", "ms", 200, 500, "Interaction to Next Paint - Reaktionszeit auf Klicks/Tasten. Gut <= 200 ms."),
    ("cls", "CLS", "none", 0.1, 0.25, "Cumulative Layout Shift - wie sehr die Seite beim Laden springt. Gut <= 0,1."),
    ("fcp", "FCP", "ms", 1800, 3000, "First Contentful Paint. Gut <= 1,8 s."),
    ("ttfb", "TTFB", "ms", 800, 1800, "Time to First Byte (Server + Netz). Gut <= 0,8 s."),
]


def vital_q(field, by="service_name", rng="$__range", q=0.75):
    return (f'quantile_over_time({q}, {F % "measurement"} | logfmt {FV} '
            f'| {field}!="" | unwrap {field} [{rng}]) by ({by})')


# LogQL: host + query stripped, UUIDs in the path -> ":id" gives a route template for API calls (ids are UUIDv7 by convention)
API = (f'{F % "event"} | logfmt | event_name="faro.tracing.fetch" {FV} '
       '| label_format route=`{{ regexReplaceAll "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" '
       '(regexReplaceAll "^https?://[^/]+|[?#].*$" .event_data_url_full "") ":id" }}`, '
       'status=`{{ .event_data_http_response_status_code }}`')

vital_stats = []
for i, (field, title, unit, good, poor, desc) in enumerate(VITALS):
    vital_stats.append(stat(f"{title} p75", {"h": 4, "w": 24 // len(VITALS) if i < 4 else 24 - 4 * (24 // len(VITALS)), "x": i * (24 // len(VITALS)), "y": 1},
                            [{**loki_target(vital_q(field), qtype="instant", legend="{{service_name}}")}],
                            ds=LOKI, unit=unit, decimals=0 if unit == "ms" else 3,
                            thresholds=GREEN_ORANGE_RED(good, poor), desc=desc + " 75. Perzentil im Zeitraum."))

by_view_targets = [loki_target(vital_q(f, by="view_name"), ref=chr(65 + i), qtype="instant", legend=t)
                   for i, (f, t, *_rest) in enumerate(VITALS[:3])]
by_view_overrides = [
    {"matcher": {"id": "byName", "options": t}, "properties": [
        {"id": "unit", "value": u}, {"id": "decimals", "value": 0 if u == "ms" else 3},
        {"id": "thresholds", "value": {"mode": "absolute", "steps": GREEN_ORANGE_RED(g, p)}},
        {"id": "custom.cellOptions", "value": {"type": "color-background"}}]}
    for (_f, t, u, g, p, _d) in VITALS[:3]]

frontend = dash("svc-frontend", "16 · Frontend", TAGS + ["frontend", "faro"],
                templating=[F_ENV, F_APP, F_VIEW], time_from="now-24h", panels=[
    row("Web Vitals (echte Nutzer, p75)", 0),
    *vital_stats,
    ts("LCP / INP p75 je View", {"h": 8, "w": 12, "x": 0, "y": 5},
       [loki_target(vital_q("lcp", by="view_name", rng="$__auto"), ref="A", legend="LCP {{view_name}}"),
        loki_target(vital_q("inp", by="view_name", rng="$__auto"), ref="B", legend="INP {{view_name}}")],
       ds=LOKI, unit="ms", legend_table=True),
    table("Web Vitals je View (p75)", {"h": 8, "w": 12, "x": 12, "y": 5}, by_view_targets, ds=LOKI,
          transformations=[{"id": "merge", "options": {}},
                           {"id": "organize", "options": {"excludeByName": {"Time": True},
                                                          "renameByName": {"view_name": "View", "Value #A": "LCP",
                                                                           "Value #B": "INP", "Value #C": "CLS"}}}],
          overrides=by_view_overrides,
          desc="View = Routen-Vorlage (tasks/:id), nie die konkrete URL."),
    bars("Bewertung (good / needs-improvement / poor)", {"h": 6, "w": 24, "x": 0, "y": 13},
         [loki_target(f'sum by (type_name, context_rating) (count_over_time({F % "measurement"} | logfmt {FV} '
                      '| label_format type_name=`{{ if .lcp }}LCP{{ else if .inp }}INP{{ else if .cls }}CLS{{ end }}` '
                      '| type_name!="" [$__range]))', qtype="instant", legend="{{type_name}} {{context_rating}}")],
         ds=LOKI, unit="short"),

    row("JavaScript-Fehler", 19),
    stat("Fehler", {"h": 4, "w": 6, "x": 0, "y": 20},
         [loki_target(f'sum(count_over_time({F % "exception"} | logfmt {FV} [$__range]))', qtype="instant", legend="Fehler")],
         ds=LOKI, thresholds=GREEN_ORANGE_RED(1, 20)),
    stat("Betroffene Sitzungen", {"h": 4, "w": 6, "x": 0, "y": 24},
         [loki_target(f'count(sum by (session_id) (count_over_time({F % "exception"} | logfmt {FV} [$__range])))', qtype="instant", legend="Sitzungen")],
         ds=LOKI, thresholds=GREEN_ORANGE_RED(1, 10),
         desc="session_id ist Structured Metadata (Seitenaufruf-Sitzung, kein Personenbezug gespeichert)."),
    ts("Fehler je View", {"h": 8, "w": 9, "x": 6, "y": 20},
       [loki_target(f'sum by (view_name) (count_over_time({F % "exception"} | logfmt {FV} [$__auto]))', legend="{{view_name}}")],
       ds=LOKI, stack=True, legend_table=True),
    table("Top-Fehler", {"h": 8, "w": 9, "x": 15, "y": 20},
          [loki_target(f'topk(10, sum by (value, app_release) (count_over_time({F % "exception"} | logfmt {FV} [$__range])))',
                       qtype="instant")],
          ds=LOKI, transformations=[{"id": "organize", "options": {"excludeByName": {"Time": True},
                                                                   "renameByName": {"value": "Meldung", "app_release": "Release", "Value #A": "Anzahl"}}}]),
    logs("Fehler mit Stacktrace (Sourcemaps aufgeloest)", {"h": 10, "w": 24, "x": 0, "y": 28},
         f'{F % "exception"} | logfmt {FV} | line_format "{{{{.value}}}}  [{{{{.view_name}}}} {{{{.browser_name}}}} {{{{.app_release}}}}]\\n{{{{.stacktrace}}}}"',
         desc="Log-Details: trace_id -> 'Trace oeffnen' (Browser-Span + Backend)."),

    row("API aus Browsersicht", 38),
    ts("Requests/s je Route", {"h": 8, "w": 8, "x": 0, "y": 39},
       [loki_target(f'sum by (route) (rate({API} [$__auto]))', legend="{{route}}")],
       ds=LOKI, unit="reqps", legend_table=True,
       desc="faro.tracing.fetch-Events; Route = URL-Pfad ohne Host, UUIDs -> :id."),
    ts("Fehlerquote je Route (Status >= 400 oder Netzfehler)", {"h": 8, "w": 8, "x": 8, "y": 39},
       [loki_target(f'(sum by (route) (rate({API} | status=~"[45]..|0|" [$__auto])) or 0 * sum by (route) (rate({API} [$__auto]))) '
                    f'/ sum by (route) (rate({API} [$__auto]))', legend="{{route}}")],
       ds=LOKI, unit="percentunit", minv=0, maxv=1, legend_table=True,
       desc="Aus Browsersicht: enthaelt auch Netz-/Proxyfehler, die das Backend nie sieht. Serverseitig: 11 · HTTP (RED)."),
    ts("Dauer p95 je Route (Browser)", {"h": 8, "w": 8, "x": 16, "y": 39},
       [loki_target(f'quantile_over_time(0.95, {API} | unwrap event_data_duration_ns [$__auto]) by (route) / 1e9', legend="{{route}}")],
       ds=LOKI, unit="s", legend_table=True),

    row("Nutzung", 47),
    ts("Seitenaufrufe je View", {"h": 8, "w": 12, "x": 0, "y": 48},
       [loki_target(f'sum by (view_name) (count_over_time({F % "event"} | logfmt | event_name="view_changed" {FV} [$__auto]))', legend="{{view_name}}")],
       ds=LOKI, stack=True, legend_table=True, desc="view_changed-Events (Router-NavigationEnd)."),
    ts("Sitzungen / Browser", {"h": 8, "w": 12, "x": 12, "y": 48},
       [loki_target(f'sum by (browser_name) (count_over_time({F % "event"} | logfmt | event_name="session_start" [$__auto]))', legend="{{browser_name}}")],
       ds=LOKI, stack=True, legend_table=True),
    traces_table("Browser-Traces mit Fehler", {"h": 9, "w": 24, "x": 0, "y": 56},
                 '{ resource.service.name =~ "$app" && resource.deployment.environment.name =~ "$env" && status = error }',
                 desc="Wurzel = Browser-Span (fetch), darunter der Backend-Trace."),
])

# ================================================================ 17 Drawboard usage (section 3.11 of the architecture)
# Product metrics of Drawboard itself, registered by the application with Micrometer (names with dots there, underscores here):
#   gauges    drawboard_boards, drawboard_users_active{window=24h|7d|30d}, drawboard_share_links_active{audience},
#             drawboard_storage_bytes{kind=snapshot|log|files}, drawboard_collab_sessions, drawboard_collab_rooms
#   counters  drawboard_collab_updates_total, drawboard_collab_dropped_total{reason}, drawboard_collab_closes_total{code},
#             drawboard_collab_compactions_total{result}, drawboard_uploads_total{result}, drawboard_scans_total{result}, drawboard_conversions_total{result},
#             drawboard_share_exchanges_total{result}, drawboard_guest_sessions_total,
#             drawboard_planning_rounds_total{event}, drawboard_planning_votes_total, drawboard_planning_refused_total{reason}
#   histogram drawboard_collab_update_bytes_{bucket,count,sum}
# Gauges that read the database are refreshed every five minutes by the application (a scrape never blocks on R2DBC), so they are
# flat lines between two readings. Not listed: drawboard_blocks by type (the server does not read the Yjs document, so there are
# no board summaries) and exports/imports (they run in the browser; the frontend reports them through Faro).
DB_VARS = [ENV_VAR, SVC_VAR]


def inc(metric, by, rng="$__range"):
    return f"sum by ({by}) (increase({metric}{{{S}}}[{rng}]))"


def rate_by(metric, by):
    return f"sum by ({by}) (rate({metric}{{{S}}}[{RI}]))"


drawboard = dash("svc-drawboard", "17 \u00b7 Drawboard usage", TAGS + ["drawboard"], templating=DB_VARS, time_from="now-24h", panels=[
    row("Who and what", 0),
    stat("Boards", {"h": 4, "w": 4, "x": 0, "y": 1}, [target(f"max(drawboard_boards{{{S}}})", "Boards", instant=True)],
         thresholds=[{"color": "blue", "value": None}], desc="Boards outside the trash. Read from the database every five minutes."),
    *[stat(f"Active users {w}", {"h": 4, "w": 4, "x": 4 + 4 * i, "y": 1},
           [target(f'max(drawboard_users_active{{{S},window="{w}"}})', w, instant=True)],
           thresholds=[{"color": "blue", "value": None}],
           desc="Users who signed in within the window (the last login is refreshed when the frontend starts). A count, never names.")
      for i, w in enumerate(["24h", "7d", "30d"])],
    stat("Open sessions", {"h": 4, "w": 4, "x": 16, "y": 1}, [target(f"sum(drawboard_collab_sessions{{{S}}})", "WebSockets", instant=True)],
         thresholds=[{"color": "blue", "value": None}], desc="Open collaboration WebSockets (members and guests)."),
    stat("Boards being edited", {"h": 4, "w": 4, "x": 20, "y": 1}, [target(f"sum(drawboard_collab_rooms{{{S}}})", "Boards", instant=True)],
         thresholds=[{"color": "blue", "value": None}], desc="Boards with at least one open session."),
    ts("Active users", {"h": 7, "w": 12, "x": 0, "y": 5}, [target(f"max by (window) (drawboard_users_active{{{S}}})", "{{window}}")],
       legend_table=True, desc="The three windows over time (24 h, 7 d, 30 d)."),
    ts("Open sessions and boards being edited", {"h": 7, "w": 12, "x": 12, "y": 5},
       [target(f"sum(drawboard_collab_sessions{{{S}}})", "Sessions", ref="A"),
        target(f"sum(drawboard_collab_rooms{{{S}}})", "Boards", ref="B")], legend_table=True),

    row("Collaboration", 12),
    ts("Updates per second", {"h": 7, "w": 8, "x": 0, "y": 13},
       [target(f"sum(rate(drawboard_collab_updates_total{{{S}}}[{RI}]))", "Updates/s")], unit="ops",
       desc="Accepted Yjs updates of all boards."),
    ts("Size of an update (p50 / p95 / p99)", {"h": 7, "w": 8, "x": 8, "y": 13},
       [target(q_quantile(q, S, "service_name", "drawboard_collab_update_bytes"), f"p{int(q * 100)}", ref=r)
        for q, r in [(0.5, "A"), (0.95, "B"), (0.99, "C")]], unit="bytes", legend_table=True),
    ts("Data per second", {"h": 7, "w": 8, "x": 16, "y": 13},
       [target(f"sum(rate(drawboard_collab_update_bytes_sum{{{S}}}[{RI}]))", "Bytes/s")], unit="Bps"),
    ts("Dropped updates by reason", {"h": 7, "w": 8, "x": 0, "y": 20},
       [target(rate_by("drawboard_collab_dropped_total", "reason"), "{{reason}}")], unit="ops", stack=True, legend_table=True,
       desc="Role, size, rate ... (see collab-protocol.md). A rise for no reason in production points to broken clients."),
    ts("Closed sessions by code", {"h": 7, "w": 8, "x": 8, "y": 20},
       [target(rate_by("drawboard_collab_closes_total", "code"), "{{code}}")], unit="ops", stack=True, legend_table=True,
       desc="WebSocket close codes: 4403 access withdrawn, 4408 idle, 1001 restart ..."),
    ts("Compactions by result", {"h": 7, "w": 8, "x": 16, "y": 20},
       [target(rate_by("drawboard_collab_compactions_total", "result"), "{{result}}")], unit="ops", stack=True, legend_table=True),

    row("Storage and files", 27),
    ts("Storage by kind", {"h": 8, "w": 8, "x": 0, "y": 28},
       [target(f"max by (kind) (drawboard_storage_bytes{{{S}}})", "{{kind}}")], unit="bytes", stack=True, legend_table=True,
       desc="snapshot and log: the drawing (collab); files: uploads including converted PDFs. Read every five minutes."),
    bars("Uploads by result (range)", {"h": 8, "w": 8, "x": 8, "y": 28},
         [target(inc("drawboard_uploads_total", "result"), "{{result}}", instant=True)], unit="short",
         desc="accepted, type_not_allowed, quota_exceeded, too_large, rate_limited, infected, error."),
    bars("Conversions by result (range)", {"h": 8, "w": 8, "x": 16, "y": 28},
         [target(inc("drawboard_conversions_total", "result"), "{{result}}", instant=True)], unit="short",
         desc="Office to PDF by Gotenberg: done or failed."),
    ts("Uploads per minute", {"h": 7, "w": 12, "x": 0, "y": 36},
       [target(f"60 * {rate_by('drawboard_uploads_total', 'result')}", "{{result}}")], stack=True, legend_table=True),
    ts("Malware scans by result", {"h": 7, "w": 12, "x": 12, "y": 36},
       [target(inc("drawboard_scans_total", "result", RI), "{{result}}")], unit="short", stack=True, legend_table=True,
       desc="clean, infected, too_large (a file above clamav-max-bytes: 413 when failing closed, else accepted unscanned) and "
            "unavailable (clamd down, too slow, an error, a blob that could not be opened). Without a scanner (no DRAWBOARD_CLAMAV_HOST) "
            "the series do not exist. A fail-open deployment with clamd down only shows 'unavailable' here: the alert "
            "svc-drawboard-scan-unavailable watches it."),

    row("Sharing and guests", 43),
    stat("Active links (signed in)", {"h": 4, "w": 6, "x": 0, "y": 44},
         [target(f'max(drawboard_share_links_active{{{S},audience="signed_in"}})', "signed in", instant=True)],
         thresholds=[{"color": "blue", "value": None}], desc="Links that are neither revoked nor expired."),
    stat("Active links (guests)", {"h": 4, "w": 6, "x": 6, "y": 44},
         [target(f'max(drawboard_share_links_active{{{S},audience="guests"}})', "guests", instant=True)],
         thresholds=[{"color": "blue", "value": None}]),
    stat("Guest sessions (range)", {"h": 4, "w": 6, "x": 12, "y": 44},
         [target(f"sum(increase(drawboard_guest_sessions_total{{{S}}}[$__range]))", "Guest sessions", instant=True)],
         thresholds=[{"color": "blue", "value": None}],
         desc="Guest sessions that were started or renewed. The token is stateless, so the server cannot tell how many are open right now."),
    ts("Link exchanges by result", {"h": 7, "w": 12, "x": 0, "y": 48},
       [target(rate_by("drawboard_share_exchanges_total", "result"), "{{result}}")], unit="ops", stack=True, legend_table=True,
       desc="signed_in, guest, or the reason it failed (not_found, password, rate_limited ...)."),
    ts("Guest sessions per hour", {"h": 7, "w": 12, "x": 12, "y": 48},
       [target(f"sum(increase(drawboard_guest_sessions_total{{{S}}}[1h]))", "Guest sessions")]),

    row("Planning Poker", 55),
    bars("Rounds (range)", {"h": 6, "w": 8, "x": 0, "y": 56},
         [target(inc("drawboard_planning_rounds_total", "event"), "{{event}}", instant=True)], unit="short",
         desc="started, revealed, cancelled."),
    stat("Votes (range)", {"h": 6, "w": 4, "x": 8, "y": 56},
         [target(f"sum(increase(drawboard_planning_votes_total{{{S}}}[$__range]))", "Votes", instant=True)],
         thresholds=[{"color": "blue", "value": None}], desc="Votes stored, changed ones too. Never a value."),
    bars("Refused (range)", {"h": 6, "w": 12, "x": 12, "y": 56},
         [target(inc("drawboard_planning_refused_total", "reason"), "{{reason}}", instant=True)], unit="short",
         desc="rate_limit: 429 from the rates of S7.3; round_full: the participant cap of a round was reached."),
    ts("Rounds per hour", {"h": 7, "w": 12, "x": 0, "y": 62},
       [target(f"sum by (event) (increase(drawboard_planning_rounds_total{{{S}}}[1h]))", "{{event}}")], stack=True, legend_table=True),
    ts("Votes per minute", {"h": 7, "w": 12, "x": 12, "y": 62},
       [target(f"60 * sum(rate(drawboard_planning_votes_total{{{S}}}[{RI}]))", "Votes/min")]),
])

os.makedirs(OUT, exist_ok=True)
for name, d in [("10-services.json", overview), ("11-http.json", http), ("12-spans.json", spans),
                ("13-jvm.json", jvm), ("14-db.json", db), ("15-logs.json", logs_dash),
                ("16-frontend.json", frontend), ("17-drawboard.json", drawboard)]:
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {name}: {len(d['panels'])} Panels")
