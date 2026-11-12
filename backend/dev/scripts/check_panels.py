#!/usr/bin/env python3
"""Run every query of every provisioned service dashboard through Grafana and report panels without data.

Each target of each panel is sent to Grafana's POST /api/ds/query (default: the last 15 minutes) with the
dashboard variables set to env=<env>, service=<service>, app=<app> (16 · Frontend) and route/span/level/view = ".+". Grafana resolves
$__rate_interval, $__range and $__auto itself. A target counts as "with data" when its frames have rows.

Generate some traffic first (requests with `dev/scripts/token.sh alice` against :18081, including a few
404/409/403), then compare the empty targets with the ones that are empty on purpose.

Usage (from the repository root, observability stack up):
    python3 dev/scripts/check_panels.py
    python3 dev/scripts/check_panels.py --service drawboard-backend --env dev --minutes 30
    python3 dev/scripts/check_panels.py --app drawboard-frontend --minutes 60     # after using the frontend
    GRAFANA_URL=http://localhost:13000 GRAFANA_AUTH=admin:admin python3 dev/scripts/check_panels.py <dashboard-dir>

Exit code 1 if a query fails (error from Grafana or the datasource), 0 otherwise - empty targets are only reported.
"""
import argparse
import base64
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DIR = os.path.join(REPO_ROOT, "dev", "observability", "grafana", "provisioning", "dashboards", "services")
SKIPPED_PANEL_TYPES = ("row", "text", "alertlist", "dashlist")


def parse_args():
    parser = argparse.ArgumentParser(description="Report service dashboard panels without data.")
    parser.add_argument("dashboard_dir", nargs="?", default=DEFAULT_DIR,
                        help="directory with the generated dashboard JSON files (default: %(default)s)")
    parser.add_argument("--grafana", default=os.environ.get("GRAFANA_URL", "http://localhost:13000"),
                        help="Grafana base URL (env GRAFANA_URL, default: %(default)s)")
    parser.add_argument("--auth", default=os.environ.get("GRAFANA_AUTH", "admin:admin"),
                        help="basic auth user:password (env GRAFANA_AUTH, default: the local throwaway admin)")
    parser.add_argument("--env", default="dev", help="value of the dashboard variable env (default: %(default)s)")
    parser.add_argument("--service", default="drawboard-backend",
                        help="value of the dashboard variable service (default: %(default)s)")
    parser.add_argument("--app", default="drawboard-frontend",
                        help="value of the dashboard variable app of 16 · Frontend (Faro app.name, default: %(default)s)")
    parser.add_argument("--minutes", type=int, default=15, help="time range in minutes (default: %(default)s)")
    return parser.parse_args()


def main():
    args = parse_args()
    auth_header = "Basic " + base64.b64encode(args.auth.encode()).decode()
    variables = {"env": args.env, "service": args.service, "app": args.app,
                 "route": ".+", "span": ".+", "level": ".+", "view": ".+", "search": ""}

    def interpolate(text):
        text = re.sub(r"\$\{(\w+)(?::\w+)?\}", lambda m: variables.get(m.group(1), m.group(0)), text)
        return re.sub(r"\$(\w+)", lambda m: variables.get(m.group(1), m.group(0)), text)

    def query(target):
        target = json.loads(interpolate(json.dumps(target)))
        now = int(time.time())
        body = {
            "from": str((now - args.minutes * 60) * 1000),
            "to": str(now * 1000),
            "queries": [dict(target, intervalMs=15000, maxDataPoints=500)],
        }
        request = urllib.request.Request(
            args.grafana.rstrip("/") + "/api/ds/query",
            json.dumps(body).encode(),
            {"Content-Type": "application/json", "Authorization": auth_header},
        )
        try:
            result = json.load(urllib.request.urlopen(request))["results"][target["refId"]]
        except urllib.error.HTTPError as e:
            return -1, e.read().decode()[:200]
        except urllib.error.URLError as e:
            sys.exit(f"Grafana not reachable at {args.grafana}: {e.reason}")
        if result.get("error"):
            return -1, result["error"][:200]
        rows = 0
        for frame in result.get("frames", []):
            values = frame.get("data", {}).get("values", [])
            if values:
                rows += max(len(v) for v in values)
        return rows, ""

    files = sorted(glob.glob(os.path.join(args.dashboard_dir, "*.json")))
    if not files:
        sys.exit(f"No dashboard JSON files in {args.dashboard_dir}")

    total, empty, failed = 0, 0, 0
    for path in files:
        name = os.path.basename(path)
        with open(path) as f:
            dashboard = json.load(f)
        for panel in dashboard["panels"]:
            if panel.get("type") in SKIPPED_PANEL_TYPES:
                continue
            for target in panel.get("targets", []):
                total += 1
                rows, error = query(target)
                if rows < 0:
                    failed += 1
                    mark = "ERR"
                elif rows == 0:
                    empty += 1
                    mark = "-- "
                else:
                    mark = "OK "
                print(f"{mark} {rows:5d}  {name:16s} {panel['title'][:48]:48s} {target.get('refId')} {error}")

    print(f"\n{total - empty - failed} of {total} targets with data, {empty} empty, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
