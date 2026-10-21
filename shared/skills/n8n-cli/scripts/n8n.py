#!/usr/bin/env python3
"""n8n CLI - Cross-platform command line interface for n8n workflow management."""

import argparse
import json
import os
import ssl
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

VERSION = "1.2.2"

# --- Colors ---

def _supports_color():
    if os.environ.get("NO_COLOR"):
        return False
    if sys.platform == "win32":
        return os.environ.get("ANSICON") or "WT_SESSION" in os.environ or os.environ.get("TERM_PROGRAM") == "vscode"
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

_COLOR = _supports_color()

def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if _COLOR else text

def red(t):    return _c("0;31", t)
def green(t):  return _c("0;32", t)
def yellow(t): return _c("1;33", t)
def blue(t):   return _c("0;34", t)

def info(msg):  print(blue(msg))
def ok(msg):    print(green(msg))
def warn(msg):  print(yellow(msg), file=sys.stderr)
def err(msg):   print(red(msg), file=sys.stderr)

# --- Config ---

SCRIPT_DIR = Path(__file__).resolve().parent
READ_ONLY_SETTINGS = {"availableInMCP", "callerPolicy", "binaryMode"}
WRITE_STRIP_SETTINGS = READ_ONLY_SETTINGS | {"timeSavedMode", "saveExecutionProgress"}
CREATE_ONLY_STRIP_SETTINGS = WRITE_STRIP_SETTINGS | {"errorWorkflow"}
DEFAULT_PROD_URL = "https://n8n.t-tech.team"
DEFAULT_TEST_URL = "https://n8n.dev-tcsgroup.io"

ALLOWED_KEYS = {"N8N_DEFAULT_ENV", "N8N_PROD_URL", "N8N_TEST_URL", "N8N_PROD_API_KEY", "N8N_TEST_API_KEY"}

def load_kv_file(path: Path) -> dict:
    result = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if value and value[0] in ('"', "'") and value[-1] == value[0]:
            value = value[1:-1]
        if key in ALLOWED_KEYS:
            result[key] = value
    return result

def load_env_overrides() -> dict:
    return {k: os.environ[k].strip() for k in ALLOWED_KEYS if os.environ.get(k, "").strip()}

def get_config_dir() -> Path:
    configured = os.environ.get("N8N_CLI_CONFIG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".n8n-cli"

def get_backup_dir() -> Path:
    return get_config_dir() / "backups"

def load_config() -> dict:
    config_dir = get_config_dir()
    env_file = config_dir / ".env"
    secrets_file = config_dir / ".env.secrets"
    overrides = load_env_overrides()
    if not env_file.is_file():
        if not overrides:
            err("Error: .env file not found and no N8N_* environment variables are set")
            print(f"Expected config: {env_file}")
            setup_script = SCRIPT_DIR / "setup.py"
            if setup_script.is_file() and not os.environ.get("N8N_CLI_CONFIG_DIR"):
                print(f"Run locally in your terminal:\n  python3 {setup_script}")
            else:
                print("Configure .env/.env.secrets or set N8N_* environment variables.")
            sys.exit(1)
        warn("Warning: .env not found, using N8N_* environment variables")
        cfg = {}
    else:
        cfg = load_kv_file(env_file)
    if secrets_file.is_file():
        try:
            cfg.update(load_kv_file(secrets_file))
        except OSError:
            if not overrides:
                raise
            warn("Warning: .env.secrets unreadable, using environment variables")
    elif not overrides:
        warn("Warning: .env.secrets not found, API keys may be missing")
    cfg.update(overrides)
    return cfg

def get_env_config(cfg: dict, env: str = None):
    env = env or cfg.get("N8N_DEFAULT_ENV", "prod")
    if env in ("prod", "production"):
        url = cfg.get("N8N_PROD_URL") or DEFAULT_PROD_URL
        return url.rstrip("/"), cfg.get("N8N_PROD_API_KEY", "")
    if env in ("test", "testing", "dev", "development"):
        url = cfg.get("N8N_TEST_URL") or DEFAULT_TEST_URL
        return url.rstrip("/"), cfg.get("N8N_TEST_API_KEY", "")
    err(f"Unknown environment: {env}")
    print("Available: prod, test (dev)", file=sys.stderr)
    sys.exit(1)

# --- API ---

def is_cert_verify_error(reason) -> bool:
    return isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason)

def print_tls_diagnostics(reason) -> None:
    err(f"TLS certificate verification failed: {reason}")
    print()
    print("Python does not trust the certificate chain for the n8n API.")
    print("Configure your system/Python trust store or point SSL_CERT_FILE to a CA bundle, then retry.")
    print()
    print("Example:")
    print("  export SSL_CERT_FILE=$HOME/company-ca-bundle.crt")
    print("  python3 n8n.py test")
    print()
    print("Do not disable SSL verification for this CLI.")

def handle_url_error(e: URLError) -> None:
    if is_cert_verify_error(e.reason):
        print_tls_diagnostics(e.reason)
    else:
        err(f"Connection error: {e.reason}")
    sys.exit(1)

def fail_http_error(e: HTTPError) -> None:
    err(f"HTTP {e.code}: {e.reason}")
    try:
        ppjson(json.loads(e.read().decode()))
    except Exception:
        pass
    sys.exit(1)

def normalize_settings(settings):
    if settings is None:
        return {}
    if not isinstance(settings, dict):
        err("Invalid workflow JSON: settings must be an object")
        sys.exit(1)
    return {k: v for k, v in settings.items() if k not in WRITE_STRIP_SETTINGS}

def normalize_create_settings(settings):
    if settings is None:
        return {}
    if not isinstance(settings, dict):
        err("Invalid workflow JSON: settings must be an object")
        sys.exit(1)
    return {k: v for k, v in settings.items() if k not in CREATE_ONLY_STRIP_SETTINGS}

def require_workflow_payload(payload, source: str) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list):
        err(f"Invalid workflow payload from {source}: expected workflow JSON with a nodes array")
        if isinstance(payload, dict):
            ppjson(payload)
        sys.exit(1)

def load_workflow_file(path: Path):
    try:
        wf = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        err(f"Invalid JSON file {path}: {e}")
        sys.exit(1)
    require_workflow_payload(wf, str(path))
    for node in wf.get("nodes", []):
        if "credentials" in node and node["credentials"] is None:
            err(f"Invalid workflow JSON: node '{node.get('name', '<unnamed>')}' has credentials=null")
            print("Remove the credentials field entirely or configure credentials in the n8n UI.")
            sys.exit(1)
    return wf

def write_json_file(path_arg: str, payload) -> None:
    path = Path(path_arg)
    if path.parent != Path("."):
        path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

def credential_key(ctype, cval) -> str:
    name = cval.get("name", "") if isinstance(cval, dict) else ""
    return f"{ctype}:{name}"

def find_unresolved_credentials(nodes):
    unresolved = []
    for node in nodes:
        for _ctype, cval in (node.get("credentials") or {}).items():
            if isinstance(cval, dict) and cval.get("id") == "CREDENTIAL_ID":
                unresolved.append(node.get("name", "<unnamed>"))
                break
    return unresolved

def normalize_global_args(argv):
    """Allow --env/-e before or after a subcommand."""
    env_args = []
    remaining = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in ("--env", "-e") and index + 1 < len(argv):
            env_args.extend((token, argv[index + 1]))
            index += 2
            continue
        if token.startswith("--env="):
            env_args.append(token)
            index += 1
            continue
        remaining.append(token)
        index += 1
    return env_args + remaining

def print_error_workflow_follow_up(workflow_id: str) -> None:
    print()
    info("Next decision: error workflow")
    print("No error workflow was created or attached automatically.")
    print("After the main workflow is configured and verified, ask its owner:")
    print("  1. Attach an existing error workflow or create a new one?")
    print("  2. Where should errors be published (channel, email, or incident system)?")
    print(f"Do not change workflow {workflow_id} until the owner confirms both choices.")

def api_request(cfg, method, endpoint, data=None, env=None):
    base_url, api_key = get_env_config(cfg, env)
    if not base_url or not api_key:
        err(f"Missing URL or API key for environment '{env or cfg.get('N8N_DEFAULT_ENV', 'prod')}'")
        sys.exit(1)
    url = f"{base_url}/api/v1{endpoint}"
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, method=method, headers={
        "X-N8N-API-KEY": api_key,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=30) as resp:
            text = resp.read().decode()
            if not text.strip():
                return {}
            return json.loads(text)
    except HTTPError as e:
        fail_http_error(e)
    except URLError as e:
        handle_url_error(e)

def api_request_result(cfg, method, endpoint, data=None, env=None):
    base_url, api_key = get_env_config(cfg, env)
    if not base_url or not api_key:
        return 0, {"message": f"Missing URL or API key for environment '{env or cfg.get('N8N_DEFAULT_ENV', 'prod')}'"}
    url = f"{base_url}/api/v1{endpoint}"
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, method=method, headers={
        "X-N8N-API-KEY": api_key,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=30) as resp:
            text = resp.read().decode()
            if not text.strip():
                return resp.status, {}
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, {"text": text}
    except HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"message": e.reason}
        return e.code, payload
    except URLError as e:
        return 0, {"message": str(e.reason)}

def ppjson(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))

def is_success(status: int) -> bool:
    return 200 <= int(status) < 300

def build_endpoint(path: str, params: dict = None) -> str:
    params = {k: v for k, v in (params or {}).items() if v is not None}
    if not params:
        return path
    return f"{path}?{urlencode(params)}"

def get_paginated(cfg, path: str, params: dict = None, env=None, max_pages: int = 50):
    data = []
    params = dict(params or {})
    cursor = params.get("cursor")
    last_status = 0
    last_resp = {}

    for _ in range(max_pages):
        if cursor:
            params["cursor"] = cursor
        endpoint = build_endpoint(path, params)
        status, resp = api_request_result(cfg, "GET", endpoint, env=env)
        last_status, last_resp = status, resp
        if not is_success(status):
            return status, resp, data

        page = resp.get("data", [])
        if isinstance(page, list):
            data.extend(page)
        else:
            return status, resp, data

        cursor = resp.get("nextCursor")
        if not cursor:
            return status, resp, data

    return last_status, last_resp, data

def print_rows(rows, headers=None):
    if headers:
        rows = [headers] + rows
    if not rows:
        return
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    for idx, row in enumerate(rows):
        print("  ".join(f"{str(row[i]):<{widths[i]}}" for i in range(len(row))))
        if headers and idx == 0:
            print("  ".join("-" * widths[i] for i in range(len(row))))

def folder_ref(folder):
    if isinstance(folder, dict):
        name = folder.get("name") or "?"
        fid = folder.get("id") or "?"
        return f"{name} ({fid})"
    return "-"

# --- Commands ---

def cmd_list(cfg, args):
    if not getattr(args, "legacy_executions", False):
        params = {
            "limit": args.limit or 250,
            "excludePinnedData": "true",
            "name": getattr(args, "name", None),
            "projectId": getattr(args, "project_id", None),
        }
        if getattr(args, "active", None) is not None:
            params["active"] = "true" if args.active else "false"

        info("Fetching workflows via /workflows...")
        status, resp, workflows = get_paginated(cfg, "/workflows", params=params, env=args.env)
        if is_success(status):
            if not getattr(args, "include_archived", False):
                workflows = [wf for wf in workflows if not wf.get("isArchived")]
            summaries = [
                {
                    "id": wf.get("id", ""),
                    "name": wf.get("name", ""),
                    "active": wf.get("active"),
                    "isArchived": wf.get("isArchived"),
                    "parentFolder": wf.get("parentFolder"),
                    "homeProject": wf.get("homeProject"),
                    "updatedAt": wf.get("updatedAt"),
                    "createdAt": wf.get("createdAt"),
                }
                for wf in workflows
            ]
            if getattr(args, "full_json", False):
                ppjson(workflows)
                return
            if getattr(args, "json", False):
                ppjson(summaries)
                return
            rows = []
            for wf in summaries:
                rows.append((
                    wf.get("id", ""),
                    wf.get("name", ""),
                    str(wf.get("active", "?")),
                    str(wf.get("isArchived", "?")),
                    folder_ref(wf.get("parentFolder")),
                ))
            if rows:
                print_rows(rows, headers=("id", "name", "active", "archived", "folder"))
            else:
                print("No workflows found.")
            return

        warn(f"GET /workflows failed: HTTP {status}: {resp.get('message', resp)}")
        warn("Falling back to legacy execution-based workflow discovery.")

    info("Fetching workflows via executions...")
    warn("Note: extracting workflow IDs from recent executions.")
    resp = api_request(cfg, "GET", "/executions?limit=250", env=args.env)
    ids = sorted(set(e["workflowId"] for e in resp.get("data", [])))
    rows = []
    for wid in ids:
        wf = api_request(cfg, "GET", f"/workflows/{wid}", env=args.env)
        rows.append((wid, wf.get("name", "unknown"), str(wf.get("active", "?"))))
    if rows:
        w = [max(len(r[i]) for r in rows) for i in range(3)]
        for r in rows:
            print(f"{r[0]:<{w[0]}}  {r[1]:<{w[1]}}  {r[2]}")
    else:
        print("No workflows found in recent executions.")

def cmd_discover(cfg, args):
    status, resp = api_request_result(cfg, "GET", "/discover", env=args.env)
    if not is_success(status):
        err(f"Discovery failed: HTTP {status}: {resp.get('message', resp)}")
        sys.exit(1)
    data = resp.get("data", resp)
    if args.json:
        ppjson(data)
        return
    scopes = data.get("scopes", [])
    resources = data.get("resources", [])
    print(f"Resources: {', '.join(resources) if resources else '-'}")
    print(f"Spec: {data.get('specUrl', '-')}")
    print("Scopes:")
    for scope in scopes:
        print(f"  {scope}")

def cmd_projects(cfg, args):
    params = {"limit": args.limit or 100}
    status, resp, projects = get_paginated(cfg, "/projects", params=params, env=args.env)
    if not is_success(status):
        err(f"Projects request failed: HTTP {status}: {resp.get('message', resp)}")
        print("Run `python3 n8n.py discover` and check for project scopes on the API key.")
        sys.exit(1)
    if args.json:
        ppjson(projects)
        return
    rows = []
    for project in projects:
        rows.append((
            project.get("id", ""),
            project.get("name", ""),
            project.get("type", ""),
        ))
    if rows:
        print_rows(rows, headers=("id", "name", "type"))
    else:
        print("No projects found.")

def parse_data_table_columns(raw: str):
    columns = []
    allowed = {"string", "number", "boolean", "date"}
    for token in str(raw or "").split(","):
        token = token.strip()
        if not token:
            continue
        name, sep, column_type = token.partition(":")
        name, column_type = name.strip(), column_type.strip().lower()
        if not sep or not name or column_type not in allowed:
            err(f"Invalid column '{token}'. Use name:type with type in {sorted(allowed)}")
            sys.exit(1)
        columns.append({"name": name, "type": column_type})
    if not columns:
        err("At least one data table column is required")
        sys.exit(1)
    return columns

def parse_json_object_arg(raw: str, label: str) -> dict:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        err(f"Invalid JSON for {label}: {exc}")
        sys.exit(1)
    if not isinstance(value, dict):
        err(f"Invalid {label}: expected a JSON object")
        sys.exit(1)
    return value

def cmd_data_tables(cfg, args):
    action = getattr(args, "data_table_command", None)
    if action == "list":
        status, resp, rows = get_paginated(cfg, "/data-tables", {"limit": args.limit}, env=args.env)
        if not is_success(status):
            err(f"Failed to list data tables (HTTP {status})")
            ppjson(resp)
            sys.exit(1)
        if args.json:
            ppjson(rows)
            return
        print_rows(
            [[r.get("id", ""), r.get("name", ""), r.get("projectId", ""), len(r.get("columns", []))] for r in rows],
            headers=("id", "name", "project", "columns"),
        )
        return
    if action == "get":
        ppjson(api_request(cfg, "GET", f"/data-tables/{args.id}", env=args.env))
        return
    if action == "rows":
        endpoint = build_endpoint(f"/data-tables/{args.id}/rows", {"limit": args.limit})
        ppjson(api_request(cfg, "GET", endpoint, env=args.env))
        return
    if action == "upsert-row":
        row_filter = parse_json_object_arg(args.filter, "--filter")
        row_data = parse_json_object_arg(args.data, "--data")
        payload = {
            "filter": row_filter,
            "data": row_data,
            "returnData": True,
        }
        if not args.yes:
            warn("Dry run: data table row was not upserted. Add --yes to apply.")
            ppjson(payload)
            return
        resp = api_request(cfg, "POST", f"/data-tables/{args.id}/rows/upsert", payload, env=args.env)
        ok("Data table row upserted")
        ppjson(resp)
        return
    if action == "create":
        payload = {"name": args.name, "columns": parse_data_table_columns(args.columns)}
        if args.project_id:
            payload["projectId"] = args.project_id
        if not args.yes:
            warn("Dry run: data table was not created. Add --yes to apply.")
            ppjson(payload)
            return
        resp = api_request(cfg, "POST", "/data-tables", payload, env=args.env)
        ok(f"Data table created: {resp.get('id', '')}")
        ppjson(resp)
        return
    err("Data table command required: list|get|rows|upsert-row|create")
    sys.exit(1)

def cmd_folders(cfg, args):
    action = getattr(args, "folder_command", None)
    if not action:
        err("Folder command required: list|get|create|update|delete")
        sys.exit(1)

    if action == "list":
        filters = {}
        if args.name:
            filters["name"] = args.name
        if args.parent_id is not None:
            filters["parentFolderId"] = args.parent_id
        params = {
            "skip": args.skip,
            "take": args.take,
            "sortBy": args.sort_by,
            "filter": json.dumps(filters, ensure_ascii=False, separators=(",", ":")) if filters else None,
            "select": json.dumps(args.select.split(","), ensure_ascii=False, separators=(",", ":")) if args.select else None,
        }
        status, resp = api_request_result(
            cfg,
            "GET",
            build_endpoint(f"/projects/{args.project_id}/folders", params),
            env=args.env,
        )
        if not is_success(status):
            err(f"Folders request failed: HTTP {status}: {resp.get('message', resp)}")
            print("Run `python3 n8n.py discover` and check for folder:list on the API key.")
            sys.exit(1)
        folders = resp.get("data", [])
        if args.json:
            ppjson(resp)
            return
        rows = []
        for folder in folders:
            rows.append((
                folder.get("id", ""),
                folder.get("name", ""),
                folder.get("parentFolderId") or "-",
                str(folder.get("workflowCount", folder.get("totalWorkflows", "?"))),
                str(folder.get("subFolderCount", folder.get("totalSubFolders", "?"))),
            ))
        if rows:
            print_rows(rows, headers=("id", "name", "parent", "workflows", "subfolders"))
        else:
            print("No folders found.")
        if "count" in resp:
            print(f"Count: {resp.get('count')}")
        return

    if action == "get":
        status, resp = api_request_result(
            cfg,
            "GET",
            f"/projects/{args.project_id}/folders/{args.folder_id}",
            env=args.env,
        )
        if not is_success(status):
            err(f"Folder get failed: HTTP {status}: {resp.get('message', resp)}")
            sys.exit(1)
        ppjson(resp)
        return

    if action == "create":
        payload = {"name": args.name}
        if args.parent_id is not None:
            payload["parentFolderId"] = args.parent_id
        if not args.yes:
            warn("Dry run only: folder was not created.")
            print(f"Would create folder in project {args.project_id}:")
            ppjson(payload)
            print("Rerun with --yes to create it.")
            return
        status, resp = api_request_result(
            cfg,
            "POST",
            f"/projects/{args.project_id}/folders",
            data=payload,
            env=args.env,
        )
        if not is_success(status):
            err(f"Folder create failed: HTTP {status}: {resp.get('message', resp)}")
            sys.exit(1)
        ok("Folder created")
        ppjson(resp)
        return

    if action == "update":
        payload = {}
        if args.name is not None:
            payload["name"] = args.name
        if args.parent_id is not None:
            payload["parentFolderId"] = args.parent_id
        if not payload:
            err("Nothing to update: pass --name and/or --parent-id")
            sys.exit(1)
        if not args.yes:
            warn("Dry run only: folder was not updated.")
            print(f"Would update folder {args.folder_id} in project {args.project_id}:")
            ppjson(payload)
            print("Rerun with --yes to update it.")
            return
        status, resp = api_request_result(
            cfg,
            "PATCH",
            f"/projects/{args.project_id}/folders/{args.folder_id}",
            data=payload,
            env=args.env,
        )
        if not is_success(status):
            err(f"Folder update failed: HTTP {status}: {resp.get('message', resp)}")
            sys.exit(1)
        ok("Folder updated")
        ppjson(resp)
        return

    if action == "delete":
        params = {"transferToFolderId": args.transfer_to_folder_id}
        endpoint = build_endpoint(f"/projects/{args.project_id}/folders/{args.folder_id}", params)
        if not args.yes:
            warn("Dry run only: folder was not deleted.")
            print(f"Would delete folder {args.folder_id} in project {args.project_id}")
            if args.transfer_to_folder_id:
                print(f"Would transfer child workflows/sub-folders to: {args.transfer_to_folder_id}")
            else:
                print("No transfer target set; n8n will move workflows to project root/archive according to API behavior.")
            print("Rerun with --yes to delete it.")
            return
        status, resp = api_request_result(cfg, "DELETE", endpoint, env=args.env)
        if not is_success(status):
            err(f"Folder delete failed: HTTP {status}: {resp.get('message', resp)}")
            sys.exit(1)
        ok("Folder deleted")
        return

    err(f"Unknown folder command: {action}")
    sys.exit(1)

def cmd_workflow_transfer(cfg, args):
    info(f"Fetching workflow {args.id} before transfer...")
    current = api_request(cfg, "GET", f"/workflows/{args.id}?excludePinnedData=true", env=args.env)
    require_workflow_payload(current, f"workflow {args.id}")
    name = current.get("name", "Unnamed")
    backup_file = backup_workflow_payload(args.id, current)
    ok(f"Backup saved: {backup_file}")

    payload = {"destinationProjectId": args.destination_project_id}
    if not args.yes:
        warn("Dry run only: workflow was not transferred.")
        print(f"Would transfer workflow: {args.id} ({name})")
        print(f"Destination project: {args.destination_project_id}")
        print("This is project transfer, not folder placement.")
        print("Rerun with --yes to perform the transfer.")
        return

    status, resp = api_request_result(
        cfg,
        "PUT",
        f"/workflows/{args.id}/transfer",
        data=payload,
        env=args.env,
    )
    if not is_success(status):
        err(f"Workflow transfer failed: HTTP {status}: {resp.get('message', resp)}")
        print(f"Backup: {backup_file}")
        sys.exit(1)
    ok(f"Workflow {args.id} transferred")
    print(f"Backup: {backup_file}")

def cmd_get(cfg, args):
    if not args.id:
        err("Error: workflow ID required")
        sys.exit(1)
    resp = api_request(cfg, "GET", f"/workflows/{args.id}", env=args.env)
    require_workflow_payload(resp, f"workflow {args.id}")
    if args.output:
        write_json_file(args.output, resp)
        ok(f"Saved to {args.output}")
    else:
        ppjson(resp)

def backup_workflow_payload(workflow_id: str, payload: dict) -> Path:
    backup_dir = get_backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_file = backup_dir / f"workflow-{workflow_id}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    backup_file.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return backup_file

def cmd_create(cfg, args):
    fpath = Path(args.file)
    if not fpath.is_file():
        err("Error: valid JSON file required")
        sys.exit(1)
    wf = load_workflow_file(fpath)
    raw_settings = wf.get("settings", {})
    if isinstance(raw_settings, dict) and raw_settings.get("errorWorkflow"):
        warn("Ignoring settings.errorWorkflow during create; choose error handling after the main workflow is verified.")
    strip_keys = {"id"}
    if not args.preserve_credentials:
        strip_keys.add("credentials")
    payload = {
        "name": wf.get("name", "Unnamed"),
        "nodes": [{k: v for k, v in n.items() if k not in strip_keys} for n in wf.get("nodes", [])],
        "connections": wf.get("connections", {}),
        "settings": normalize_create_settings(wf.get("settings", {})),
    }
    info("Preparing workflow for creation...")
    if args.preserve_credentials:
        unresolved = find_unresolved_credentials(payload["nodes"])
        if unresolved:
            err(f"Unresolved credential placeholders remain: {', '.join(unresolved)}")
            print("Create without --preserve-credentials or replace placeholders with real credential references.")
            sys.exit(1)
        warn("Note: Node IDs removed; credentials preserved from JSON")
    else:
        warn("Note: Node IDs and credentials removed (will be set in UI)")
    info("Creating workflow...")
    resp = api_request(cfg, "POST", "/workflows", data=payload, env=args.env)
    new_id = resp.get("id")
    if new_id:
        ok(f"Created workflow with ID: {new_id}")
        if not args.preserve_credentials:
            warn("Don't forget to configure credentials in n8n UI!")
        print_error_workflow_follow_up(new_id)
    else:
        err("Failed to create workflow")
        ppjson(resp)
        sys.exit(1)

def cmd_delete(cfg, args):
    if not args.id:
        err("Error: workflow ID required")
        sys.exit(1)

    info(f"Fetching workflow {args.id} before delete...")
    current = api_request(cfg, "GET", f"/workflows/{args.id}", env=args.env)
    require_workflow_payload(current, f"workflow {args.id}")
    name = current.get("name", "Unnamed")
    active = bool(current.get("active"))

    if active and not args.allow_active:
        err(f"Refusing to delete active workflow: {args.id} ({name})")
        print("Deactivate it first or pass --allow-active if this destructive action is intentional.")
        sys.exit(1)

    backup_file = backup_workflow_payload(args.id, current)
    ok(f"Backup saved: {backup_file}")

    if not args.yes:
        warn("Dry run only: workflow was not deleted.")
        print(f"Would delete workflow: {args.id} ({name}), active={active}")
        print("Rerun with --yes to perform the delete.")
        return

    warn(f"Deleting workflow: {args.id} ({name}), active={active}")
    api_request(cfg, "DELETE", f"/workflows/{args.id}", env=args.env)
    ok(f"Workflow {args.id} deleted")
    print(f"Backup: {backup_file}")

def cmd_archive(cfg, args):
    if not args.id:
        err("Error: workflow ID required")
        sys.exit(1)

    info(f"Fetching workflow {args.id} before archive...")
    current = api_request(cfg, "GET", f"/workflows/{args.id}", env=args.env)
    require_workflow_payload(current, f"workflow {args.id}")
    name = current.get("name", "Unnamed")
    active = bool(current.get("active"))
    is_archived = bool(current.get("isArchived"))

    if active and not args.allow_active:
        err(f"Refusing to archive active workflow: {args.id} ({name})")
        print("Deactivate it first or pass --allow-active if this archive is intentional.")
        sys.exit(1)

    backup_file = backup_workflow_payload(args.id, current)
    ok(f"Backup saved: {backup_file}")

    if is_archived:
        ok(f"Workflow {args.id} is already archived")
        return

    if not args.yes:
        warn("Dry run only: workflow was not archived.")
        print(f"Would archive workflow: {args.id} ({name}), active={active}")
        print("Rerun with --yes to perform the archive.")
        return

    payload = {
        "name": current.get("name", "Unnamed"),
        "nodes": current.get("nodes", []),
        "connections": current.get("connections", {}),
        "settings": normalize_settings(current.get("settings", {})),
        "isArchived": True,
    }
    warn(f"Archiving workflow: {args.id} ({name}), active={active}")
    status, resp = api_request_result(cfg, "PUT", f"/workflows/{args.id}", data=payload, env=args.env)
    if status >= 200 and status < 300:
        ok(f"Workflow {args.id} archive request completed")
        print(f"Backup: {backup_file}")
        print(f"isArchived: {resp.get('isArchived')}")
        return

    warn(f"PUT archive failed: HTTP {status}: {resp.get('message', resp)}")
    warn("Trying POST /workflows/{id}/archive...")
    status, resp = api_request_result(cfg, "POST", f"/workflows/{args.id}/archive", env=args.env)
    if status >= 200 and status < 300:
        ok(f"Workflow {args.id} archive endpoint completed")
        print(f"Backup: {backup_file}")
        print(f"isArchived: {resp.get('isArchived')}")
        return

    warn(f"POST archive failed: HTTP {status}: {resp.get('message', resp)}")
    warn("Trying PATCH /workflows/{id} with isArchived=true...")
    status, resp = api_request_result(cfg, "PATCH", f"/workflows/{args.id}", data={"isArchived": True}, env=args.env)
    if status >= 200 and status < 300:
        ok(f"Workflow {args.id} patch archive completed")
        print(f"Backup: {backup_file}")
        print(f"isArchived: {resp.get('isArchived')}")
        return

    err(f"Archive failed: HTTP {status}: {resp.get('message', resp)}")
    print(f"Backup: {backup_file}")
    sys.exit(1)

def cmd_update(cfg, args):
    if not args.id or not args.file:
        err("Error: workflow ID and JSON file required")
        sys.exit(1)
    fpath = Path(args.file)
    if not fpath.is_file():
        err(f"File not found: {args.file}")
        sys.exit(1)

    # Stale file warning
    file_age = time.time() - os.path.getmtime(fpath)
    if file_age > 300:
        warn("━" * 54)
        warn(f"STALE FILE: created {int(file_age)}s ago ({int(file_age // 60)} min)")
        warn("If there were UI edits between get and update — do a fresh get:")
        warn(f"  python3 n8n.py get {args.id} -o {args.file} --env {args.env or 'prod'}")
        warn("━" * 54)
        if not args.allow_stale:
            err("Refusing to update from a stale file. Use --allow-stale to override.")
            sys.exit(1)

    # Fetch and validate the source of truth before writing a backup or update.
    info("Fetching live workflow for backup...")
    current = api_request(cfg, "GET", f"/workflows/{args.id}", env=args.env)
    require_workflow_payload(current, f"workflow {args.id}")
    if str(current.get("id", "")) != str(args.id):
        err(f"Invalid live workflow identity: expected {args.id}, got {current.get('id')}")
        sys.exit(1)
    backup_dir = get_backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_file = backup_dir / f"workflow-{args.id}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    backup_file.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
    ok(f"Backup saved: {backup_file}")

    # Diff critical fields
    def extract_critical(nodes):
        result = []
        for n in nodes:
            p = n.get("parameters", {})
            url = p.get("url")
            jql = p.get("jql") or p.get("options", {}).get("jql")
            creds = sorted(n["credentials"].keys()) if n.get("credentials") else None
            if url or jql or creds:
                result.append({"name": n.get("name"), "url": url, "jql": jql, "credentials": creds})
        return result

    info("Checking for changes in critical fields (URLs, JQLs, credentials)...")
    current_crit = extract_critical(current.get("nodes", []))
    new_wf = load_workflow_file(fpath)
    new_crit = extract_critical(new_wf.get("nodes", []))

    cur_set = {json.dumps(c, sort_keys=True) for c in current_crit}
    new_set = {json.dumps(c, sort_keys=True) for c in new_crit}
    removed = cur_set - new_set
    added = new_set - cur_set

    if removed or added:
        warn("━" * 54)
        warn("WARNING: Critical fields will be changed:")
        warn("━" * 54)
        for r in sorted(removed):
            print(f"  OLD: {r}")
        for a in sorted(added):
            print(f"  NEW: {a}")
        warn("━" * 54)
        warn("URLs, JQLs or credentials will be overwritten!")
        warn(f"Restore from: {backup_file}")
        warn("━" * 54)
        if not args.allow_critical_changes:
            err("Refusing to update critical fields. Use --allow-critical-changes to override.")
            sys.exit(1)
    else:
        ok("No changes in critical fields")

    # Credentials preservation
    live_creds_by_id = {}
    live_creds_by_name = {}
    for n in current.get("nodes", []):
        if n.get("credentials"):
            if n.get("id"):
                live_creds_by_id[n["id"]] = n["credentials"]
            live_creds_by_name[n["name"]] = n["credentials"]

    # Build a type/name credential map for resolving placeholders on newly added nodes.
    cred_by_name = {}
    for n in current.get("nodes", []):
        for ctype, cval in (n.get("credentials") or {}).items():
            if not isinstance(cval, dict):
                continue
            cred_key = credential_key(ctype, cval)
            if cval.get("id") and cval["id"] != "CREDENTIAL_ID":
                cred_by_name[cred_key] = cval

    nodes_out = []
    for n in new_wf.get("nodes", []):
        node = dict(n)
        if node.get("id") in live_creds_by_id:
            # Existing node on the live workflow: always keep live credentials.
            node["credentials"] = live_creds_by_id[node["id"]]
        elif node.get("name") in live_creds_by_name:
            # Fallback for older workflow exports without stable node IDs.
            node["credentials"] = live_creds_by_name[node["name"]]
        elif node.get("credentials"):
            # New node with placeholder credentials: resolve IDs by credential type/name.
            resolved = {}
            for ctype, cval in node["credentials"].items():
                cred_key = credential_key(ctype, cval)
                if isinstance(cval, dict) and cval.get("id") == "CREDENTIAL_ID" and cred_key in cred_by_name:
                    resolved[ctype] = dict(cred_by_name[cred_key])
                else:
                    resolved[ctype] = cval
            node["credentials"] = resolved
        nodes_out.append(node)

    payload = {
        "name": new_wf.get("name", "Unnamed"),
        "nodes": nodes_out,
        "connections": new_wf.get("connections", {}),
        "settings": normalize_settings(new_wf.get("settings", {})),
    }

    injected = sum(1 for n in nodes_out if n.get("credentials"))
    missing = [n["name"] for n in nodes_out if not n.get("credentials") and n.get("parameters", {}).get("authentication")]
    unresolved = find_unresolved_credentials(nodes_out)
    if missing:
        warn(f"New nodes — assign credentials in UI: {', '.join(missing)}")
    if unresolved:
        warn(f"Unresolved credential placeholders remain: {', '.join(unresolved)}")
        warn("Assign those credentials in the n8n UI before activating or relying on the workflow.")
    if not missing and not unresolved:
        ok(f"Credentials preserved ({injected} nodes)")
    else:
        warn(f"Credentials preserved where possible ({injected} nodes)")

    info(f"Updating workflow {args.id}...")
    base_url, api_key = get_env_config(cfg, args.env)
    url = f"{base_url}/api/v1/workflows/{args.id}"
    body = json.dumps(payload).encode()
    req = Request(url, data=body, method="PUT", headers={
        "X-N8N-API-KEY": api_key,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
    except HTTPError as e:
        err("Failed to update workflow")
        try:
            ppjson(json.loads(e.read().decode()))
        except Exception:
            print(str(e))
        sys.exit(1)
    except URLError as e:
        handle_url_error(e)

    if result.get("id"):
        ok(f"Workflow {args.id} updated successfully")
        ok(f"Backup: {backup_file}")
    else:
        err("Failed to update workflow")
        ppjson(result)
        sys.exit(1)

def cmd_activate(cfg, args):
    if not args.id:
        err("Error: workflow ID required"); sys.exit(1)
    info(f"Activating workflow {args.id}...")
    api_request(cfg, "POST", f"/workflows/{args.id}/activate", env=args.env)
    ok(f"Workflow {args.id} activated")

def cmd_deactivate(cfg, args):
    if not args.id:
        err("Error: workflow ID required"); sys.exit(1)
    info(f"Deactivating workflow {args.id}...")
    api_request(cfg, "POST", f"/workflows/{args.id}/deactivate", env=args.env)
    ok(f"Workflow {args.id} deactivated")

def cmd_executions(cfg, args):
    limit = args.limit or 10
    endpoint = f"/executions?limit={limit}"
    if args.id:
        endpoint = f"/executions?workflowId={args.id}&limit={limit}"
    info("Fetching executions...")
    resp = None
    for attempt in range(4):
        resp = api_request(cfg, "GET", endpoint, env=args.env)
        if resp:
            break
        time.sleep(2)
    if not resp:
        warn("Warning: empty response from /executions (after 4 attempts)")
        return
    rows = []
    for e in resp.get("data", []):
        rows.append((e.get("id", ""), e.get("workflowId", ""), e.get("status", ""), e.get("startedAt", "")))
    if rows:
        w = [max(len(str(r[i])) for r in rows) for i in range(4)]
        for r in rows:
            print(f"{r[0]:<{w[0]}}  {r[1]:<{w[1]}}  {r[2]:<{w[2]}}  {r[3]}")
    else:
        ppjson(resp)

def cmd_execution(cfg, args):
    if not args.id:
        err("Error: execution ID required"); sys.exit(1)
    resp = api_request(cfg, "GET", f"/executions/{args.id}?includeData=true", env=args.env)
    if args.data:
        resolved_env = args.env or cfg.get("N8N_DEFAULT_ENV", "prod")
        if not args.unsafe_data and resolved_env in ("prod", "production"):
            err("Refusing to print full execution data on prod without --unsafe-data")
            sys.exit(1)

        # Redact sensitive keys
        def redact(obj):
            sensitive = {"token", "secret", "password", "authorization", "apikey", "api_key", "cookie", "session", "credential"}
            if isinstance(obj, dict):
                return {k: ("***REDACTED***" if any(s in k.lower() for s in sensitive) else redact(v)) for k, v in obj.items()}
            if isinstance(obj, list):
                return [redact(i) for i in obj]
            return obj

        ppjson(redact(resp))
    else:
        run_data = resp.get("data", {}).get("resultData", {}).get("runData", {})
        last_entry = list(run_data.items())[-1] if run_data else (None, None)
        last_node, last_val = last_entry
        item_count = 0
        if last_val and isinstance(last_val, list) and last_val:
            main = last_val[0].get("data", {}).get("main", [[]])
            item_count = len(main[0]) if main and main[0] else 0
        summary = {
            "id": resp.get("id"),
            "status": resp.get("status"),
            "mode": resp.get("mode"),
            "startedAt": resp.get("startedAt"),
            "stoppedAt": resp.get("stoppedAt"),
            "lastNodeExecuted": resp.get("data", {}).get("resultData", {}).get("lastNodeExecuted"),
            "error": resp.get("data", {}).get("resultData", {}).get("error"),
            "nodeOutputPreview": {"node": last_node, "itemCount": item_count},
        }
        ppjson(summary)

def cmd_retry(cfg, args):
    if not args.id:
        err("Error: execution ID required"); sys.exit(1)
    info(f"Retrying execution {args.id}...")
    base_url, api_key = get_env_config(cfg, args.env)
    req = Request(f"{base_url}/api/v1/executions/{args.id}/retry", method="POST", headers={"X-N8N-API-KEY": api_key})
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
    except HTTPError as e:
        err("Retry failed")
        try:
            ppjson(json.loads(e.read().decode()))
        except Exception:
            print(str(e))
        sys.exit(1)
    except URLError as e:
        handle_url_error(e)
    if result.get("status") == "success":
        ok(f"Retry successful! New execution ID: {result.get('id')}")
    else:
        ppjson(result)

def cmd_stop_execution(cfg, args):
    if not args.id:
        err("Error: execution ID required"); sys.exit(1)
    info(f"Stopping execution {args.id}...")
    result = api_request(cfg, "POST", f"/executions/{args.id}/stop", env=args.env)
    ok(f"Stop requested for execution {args.id}")
    if result:
        ppjson(result)

def cmd_errors(cfg, args):
    limit = args.limit or 20
    info("Fetching failed executions...")
    resp = api_request(cfg, "GET", "/executions?limit=200", env=args.env)
    errors = [e for e in resp.get("data", []) if e.get("status") == "error"][:limit]
    if not errors:
        ok("No failed executions found")
    else:
        warn(f"Found {len(errors)} failed executions:")
        for e in errors:
            print(f"{e.get('id', '')}  {e.get('workflowId', '')}  {e.get('stoppedAt', '')}")

def cmd_webhook(cfg, args):
    if not args.path:
        err("Error: webhook path required")
        sys.exit(1)
    if args.timeout <= 0:
        err("Error: --timeout must be greater than 0")
        sys.exit(1)
    base_url, _ = get_env_config(cfg, args.env)
    path = args.path
    data = args.data or "{}"

    if path.startswith("http"):
        from urllib.parse import urlparse
        base_host = urlparse(base_url).hostname
        target_host = urlparse(path).hostname
        if not args.allow_external_url and target_host != base_host:
            err("External webhook URL is blocked by default")
            print("Use --allow-external-url to override.")
            sys.exit(1)
        url = path
    elif path.startswith("/"):
        url = f"{base_url}{path}"
    else:
        url = f"{base_url}/webhook/{path}"

    info(f"Calling webhook: {url}")

    if data.startswith("@"):
        fpath = Path(data[1:])
        if not fpath.is_file():
            err(f"File not found: {fpath}"); sys.exit(1)
        body = fpath.read_bytes()
    else:
        body = data.encode()

    req = Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=args.timeout) as resp:
            text = resp.read().decode()
    except HTTPError as e:
        text = e.read().decode()
        err(f"Webhook failed (HTTP {e.code}: {e.reason})")
        if text:
            try:
                ppjson(json.loads(text))
            except json.JSONDecodeError:
                print(text)
        sys.exit(1)
    except TimeoutError:
        err(f"Webhook request timed out after {args.timeout:g}s")
        print("The n8n execution may still be running. Check executions or retry with a larger --timeout.")
        sys.exit(1)
    except URLError as e:
        handle_url_error(e)

    if text:
        try:
            ppjson(json.loads(text))
        except json.JSONDecodeError:
            print(text)
    else:
        ok("Webhook called (no response body)")

def cmd_test(cfg, args):
    info("Testing connection to n8n...")
    base_url, _ = get_env_config(cfg, args.env)
    print(f"URL: {base_url}")
    if os.environ.get("SSL_CERT_FILE"):
        print(f"SSL_CERT_FILE: {os.environ['SSL_CERT_FILE']}")
    resp = api_request(cfg, "GET", "/executions?limit=1", env=args.env)
    data = resp.get("data", [])
    if data is not None:
        ok("Connection successful!")
        print(f"API is working (found {len(data)} recent executions)")
        resp2 = api_request(cfg, "GET", "/executions?limit=100", env=args.env)
        wf_ids = set(e["workflowId"] for e in resp2.get("data", []))
        print(f"Found {len(wf_ids)} unique workflows in recent executions")
    else:
        err("Connection failed")
        ppjson(resp)
        sys.exit(1)

# --- Main ---

def main():
    parser = argparse.ArgumentParser(prog="n8n", description="n8n CLI - workflow management")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument("--env", "-e", help="Environment: prod (default), test, dev")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("list", aliases=["ls"], help="List workflows")
    p.add_argument("--name", help="Server-side workflow name filter")
    p.add_argument("--project-id", help="Filter workflows by project ID")
    p.add_argument("--active", dest="active", action="store_true", default=None, help="Only active workflows")
    p.add_argument("--inactive", dest="active", action="store_false", help="Only inactive workflows")
    p.add_argument("--include-archived", action="store_true", help="Include archived workflows")
    p.add_argument("--limit", type=int, default=250, help="Page size for /workflows")
    p.add_argument("--json", action="store_true", help="Print JSON summary list")
    p.add_argument("--full-json", action="store_true", help="Print raw workflow JSON including nodes")
    p.add_argument("--legacy-executions", action="store_true", help="Use execution-based discovery fallback")

    p = sub.add_parser("discover", help="Show public API resources and scopes")
    p.add_argument("--json", action="store_true", help="Print raw discovery JSON")

    p = sub.add_parser("projects", aliases=["project"], help="List projects")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("data-tables", aliases=["datatable"], help="List, inspect, or create n8n Data Tables")
    dt_sub = p.add_subparsers(dest="data_table_command")
    dt = dt_sub.add_parser("list", help="List data tables")
    dt.add_argument("--limit", type=int, default=100)
    dt.add_argument("--json", action="store_true")
    dt = dt_sub.add_parser("get", help="Get a data table schema")
    dt.add_argument("id")
    dt = dt_sub.add_parser("rows", help="Read data table rows")
    dt.add_argument("id")
    dt.add_argument("--limit", type=int, default=20)
    dt = dt_sub.add_parser("upsert-row", help="Upsert one data table row (dry run by default)")
    dt.add_argument("id")
    dt.add_argument("--filter", required=True, help="Filter JSON, e.g. {\"type\":\"and\",\"filters\":[...]}")
    dt.add_argument("--data", required=True, help="Row fields as a JSON object")
    dt.add_argument("--yes", action="store_true", help="Actually upsert the row")
    dt = dt_sub.add_parser("create", help="Create a data table (dry run by default)")
    dt.add_argument("name")
    dt.add_argument("--columns", required=True, help="Comma-separated name:type definitions")
    dt.add_argument("--project-id")
    dt.add_argument("--yes", action="store_true", help="Actually create the table")

    p = sub.add_parser("folders", aliases=["folder"], help="Manage folders in a project")
    folder_sub = p.add_subparsers(dest="folder_command")

    pf = folder_sub.add_parser("list", help="List folders in a project")
    pf.add_argument("project_id")
    pf.add_argument("--name", help="Filter by folder name")
    pf.add_argument("--parent-id", help="Filter by parent folder ID")
    pf.add_argument("--select", help="Comma-separated fields to request")
    pf.add_argument("--sort-by", default="name:asc", help="Sort order, e.g. name:asc")
    pf.add_argument("--skip", default="0", help="Number of folders to skip")
    pf.add_argument("--take", default="50", help="Number of folders to return")
    pf.add_argument("--json", action="store_true")

    pf = folder_sub.add_parser("get", help="Get folder details")
    pf.add_argument("project_id")
    pf.add_argument("folder_id")

    pf = folder_sub.add_parser("create", help="Create a folder (dry run by default)")
    pf.add_argument("project_id")
    pf.add_argument("name")
    pf.add_argument("--parent-id", help="Parent folder ID")
    pf.add_argument("--yes", action="store_true", help="Actually create the folder")

    pf = folder_sub.add_parser("update", help="Update a folder (dry run by default)")
    pf.add_argument("project_id")
    pf.add_argument("folder_id")
    pf.add_argument("--name", help="New folder name")
    pf.add_argument("--parent-id", help="New parent folder ID")
    pf.add_argument("--yes", action="store_true", help="Actually update the folder")

    pf = folder_sub.add_parser("delete", help="Delete a folder (dry run by default)")
    pf.add_argument("project_id")
    pf.add_argument("folder_id")
    pf.add_argument("--transfer-to-folder-id", help="Move workflows/sub-folders here before delete")
    pf.add_argument("--yes", action="store_true", help="Actually delete the folder")

    p = sub.add_parser("get", help="Get workflow by ID")
    p.add_argument("id")
    p.add_argument("--output", "-o", help="Output file")

    p = sub.add_parser("create", aliases=["new"], help="Create workflow from JSON")
    p.add_argument("file")
    p.add_argument("--preserve-credentials", action="store_true", help="Keep credential references from JSON during create")

    p = sub.add_parser("delete", aliases=["remove"], help="Delete workflow after backup")
    p.add_argument("id")
    p.add_argument("--yes", action="store_true", help="Actually delete the workflow")
    p.add_argument("--allow-active", action="store_true", help="Allow deleting an active workflow")

    p = sub.add_parser("archive", help="Archive workflow after backup")
    p.add_argument("id")
    p.add_argument("--yes", action="store_true", help="Actually archive the workflow")
    p.add_argument("--allow-active", action="store_true", help="Allow archiving an active workflow")

    p = sub.add_parser("workflow-transfer", aliases=["transfer"], help="Transfer workflow to another project after backup")
    p.add_argument("id")
    p.add_argument("destination_project_id")
    p.add_argument("--yes", action="store_true", help="Actually transfer the workflow")

    p = sub.add_parser("update", aliases=["put"], help="Update workflow")
    p.add_argument("id")
    p.add_argument("file")
    p.add_argument("--allow-stale", action="store_true", help="Allow update from a file older than 5 minutes")
    p.add_argument("--allow-critical-changes", action="store_true", help="Allow overwriting URLs, JQLs, or credentials")

    p = sub.add_parser("activate", aliases=["on"], help="Activate workflow")
    p.add_argument("id")

    p = sub.add_parser("deactivate", aliases=["off"], help="Deactivate workflow")
    p.add_argument("id")

    p = sub.add_parser("executions", aliases=["execs"], help="List executions")
    p.add_argument("id", nargs="?", help="Workflow ID filter")
    p.add_argument("--limit", "-l", type=int)

    p = sub.add_parser("execution", aliases=["exec"], help="Execution details")
    p.add_argument("id")
    p.add_argument("--data", "-d", action="store_true")
    p.add_argument("--unsafe-data", action="store_true")

    p = sub.add_parser("retry", help="Retry failed execution")
    p.add_argument("id")

    p = sub.add_parser("stop-execution", aliases=["stop-exec"], help="Stop a running execution")
    p.add_argument("id")

    p = sub.add_parser("errors", aliases=["failed"], help="List failed executions")
    p.add_argument("--limit", "-l", type=int)

    p = sub.add_parser("webhook", aliases=["trigger", "call"], help="Call webhook")
    p.add_argument("path")
    p.add_argument("data", nargs="?")
    p.add_argument("--allow-external-url", action="store_true")
    p.add_argument("--timeout", type=float, default=60, help="HTTP timeout in seconds (default: 60)")

    sub.add_parser("test", aliases=["ping"], help="Test API connection")

    args = parser.parse_args(normalize_global_args(sys.argv[1:]))
    if not args.command:
        parser.print_help()
        sys.exit(0)

    cfg = load_config()

    commands = {
        "list": cmd_list, "ls": cmd_list,
        "discover": cmd_discover,
        "projects": cmd_projects, "project": cmd_projects,
        "data-tables": cmd_data_tables, "datatable": cmd_data_tables,
        "folders": cmd_folders, "folder": cmd_folders,
        "get": cmd_get,
        "create": cmd_create, "new": cmd_create,
        "delete": cmd_delete, "remove": cmd_delete,
        "archive": cmd_archive,
        "workflow-transfer": cmd_workflow_transfer, "transfer": cmd_workflow_transfer,
        "update": cmd_update, "put": cmd_update,
        "activate": cmd_activate, "on": cmd_activate,
        "deactivate": cmd_deactivate, "off": cmd_deactivate,
        "executions": cmd_executions, "execs": cmd_executions,
        "execution": cmd_execution, "exec": cmd_execution,
        "retry": cmd_retry,
        "stop-execution": cmd_stop_execution, "stop-exec": cmd_stop_execution,
        "errors": cmd_errors, "failed": cmd_errors,
        "webhook": cmd_webhook, "trigger": cmd_webhook, "call": cmd_webhook,
        "test": cmd_test, "ping": cmd_test,
    }
    fn = commands.get(args.command)
    if fn:
        fn(cfg, args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
