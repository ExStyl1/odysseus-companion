#!/usr/bin/env python3
"""
Check GitLab archived status for Finedog units.

This script:
1. Fetches units from Finedog API (by parent IDs, search queries, or unit IDs)
2. Extracts GitLab repository URLs from each unit
3. Checks GitLab API for archived status
4. Reports which units have archived repositories

Usage:
    python3 check-gitlab-archived.py
    python3 check-gitlab-archived.py --output json
    python3 check-gitlab-archived.py --parent 5224 --parent 28324
    python3 check-gitlab-archived.py --query "MyService"
    python3 check-gitlab-archived.py --unit 12345 --unit 67890

Requirements:
    - .env file with token=Bearer <finedog_token> and gitlab_pat_token=<gitlab_token>
    - Python 3.7+
    - requests library
"""

import argparse
import json
import sys
import os
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

try:
    import requests
except ImportError:
    print("Error: requests library required. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)

# Configuration
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
ENV_FILE = Path(REPO_ROOT) / ".env"
FINEDOG_API_BASE = "https://finedog.tinkoff.ru/api/integration"
GITLAB_API_BASE = "https://gitlab.tcsbank.ru/api/v4"


def get_env_tokens() -> Tuple[Optional[str], Optional[str]]:
    """Extract Finedog JWT token and GitLab PAT from .env file."""
    env_file = None
    for candidate in ENV_FILE_CANDIDATES:
        if candidate.exists():
            env_file = candidate
            break
    
    if not env_file:
        print("Error: .env file not found. Searched:", file=sys.stderr)
        for candidate in ENV_FILE_CANDIDATES:
            print(f"  - {candidate}", file=sys.stderr)
        return None, None
    
    finedog_token = None
    gitlab_token = None
    
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("token=Bearer "):
                finedog_token = line.split("=", 1)[1].replace("Bearer ", "").strip()
            elif line.startswith("gitlab_pat_token="):
                gitlab_token = line.split("=", 1)[1].strip()
    
    if not finedog_token:
        print("Error: No Finedog token found in .env file (token=Bearer ...)", file=sys.stderr)
        return None, None
    
    if not gitlab_token:
        print("Warning: No GitLab PAT token found in .env file (gitlab_pat_token=...)", file=sys.stderr)
        print("         GitLab archive status check will be skipped", file=sys.stderr)
    
    return finedog_token, gitlab_token


def get_units_from_finedog(
    finedog_token: str,
    parent_ids: Optional[List[int]] = None,
    queries: Optional[List[str]] = None,
    unit_ids: Optional[List[int]] = None
) -> Dict[int, dict]:
    """Get units from Finedog API with GitLab URLs."""
    headers = {"Authorization": f"Bearer {finedog_token}"}
    unit_ids_set = set()
    
    # Search by parent IDs
    if parent_ids:
        for parent_id in parent_ids:
            try:
                response = requests.post(
                    f"{FINEDOG_API_BASE}/v1/units/list",
                    headers=headers,
                    json={"parentIds": [parent_id], "page": 1, "pageSize": 200},
                    timeout=30
                )
                if response.status_code == 200:
                    data = response.json()
                    for unit in data.get("items", []):
                        if unit.get("kind") in ["system", "subsystem", "component"]:
                            unit_ids_set.add(unit["id"])
            except Exception as e:
                print(f"Warning: Error getting children of parent {parent_id}: {e}", file=sys.stderr)
    
    # Search by queries
    if queries:
        for query in queries:
            try:
                response = requests.post(
                    f"{FINEDOG_API_BASE}/v1/units/list",
                    headers=headers,
                    json={"query": query, "page": 1, "pageSize": 200},
                    timeout=30
                )
                if response.status_code == 200:
                    data = response.json()
                    for unit in data.get("items", []):
                        if unit.get("kind") in ["system", "subsystem", "component"]:
                            unit_ids_set.add(unit["id"])
            except Exception as e:
                print(f"Warning: Error searching for '{query}': {e}", file=sys.stderr)
    
    # Add specific unit IDs
    if unit_ids:
        unit_ids_set.update(unit_ids)
    
    if not unit_ids_set:
        print("Warning: No units found with specified criteria", file=sys.stderr)
        return {}
    
    # Fetch full details for each unit (gitlab URL is only in individual unit details)
    print(f"  Fetching details for {len(unit_ids_set)} units...", file=sys.stderr)
    all_units = {}
    for unit_id in unit_ids_set:
        try:
            response = requests.get(
                f"{FINEDOG_API_BASE}/v1/units/{unit_id}",
                headers=headers,
                timeout=10
            )
            if response.status_code == 200:
                unit = response.json()
                if unit.get("gitlab"):
                    all_units[unit_id] = unit
        except Exception:
            pass  # Skip units that can't be fetched
    
    return all_units


def get_archived_gitlab_projects(gitlab_token: str, project_paths: Set[str]) -> Set[str]:
    """Check which GitLab projects are archived by checking each project directly."""
    headers = {"PRIVATE-TOKEN": gitlab_token}
    archived_projects = set()
    
    print(f"  Checking {len(project_paths)} GitLab projects individually...", file=sys.stderr)
    
    # Check each project directly using the projects API
    for project_path in project_paths:
        try:
            # URL encode the project path (e.g., "adtech/predictor-ma" -> "adtech%2Fpredictor-ma")
            encoded_path = requests.utils.quote(project_path, safe='')
            response = requests.get(
                f"{GITLAB_API_BASE}/projects/{encoded_path}",
                headers=headers,
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("archived") is True:
                    archived_projects.add(project_path)
            elif response.status_code == 404:
                print(f"  Warning: Project not found: {project_path}", file=sys.stderr)
        except Exception as e:
            print(f"  Warning: Error checking {project_path}: {e}", file=sys.stderr)
    
    return archived_projects


def check_archived_status(
    units: Dict[int, dict],
    archived_projects: Set[str]
) -> Tuple[List[dict], List[dict]]:
    """Check which units have archived GitLab repositories."""
    archived_units = []
    active_units = []

    for unit_id, unit in units.items():
        gitlab_url = unit.get("gitlab", "")
        if not gitlab_url:
            continue

        # Extract tenant/repo from URL
        project_path = gitlab_url.replace("https://gitlab.tcsbank.ru/", "")

        # Check both GitLab archive status and Finedog isArchived flag
        is_gitlab_archived = project_path in archived_projects
        is_finedog_archived = unit.get("isArchived") is True

        if is_gitlab_archived:
            archived_units.append({
                "unit_id": unit_id,
                "name": unit.get("name", "unknown"),
                "kind": unit.get("kind", "unknown"),
                "gitlab": gitlab_url,
                "project_path": project_path,
                "finedog_archived": is_finedog_archived
            })
        else:
            active_units.append({
                "unit_id": unit_id,
                "name": unit.get("name", "unknown"),
                "kind": unit.get("kind", "unknown"),
                "gitlab": gitlab_url,
                "project_path": project_path,
                "finedog_archived": is_finedog_archived
            })

    return archived_units, active_units


def print_report(
    archived_units: List[dict],
    active_units: List[dict],
    archived_projects: Set[str],
    output_format: str = "table"
):
    """Print the check report."""
    
    if output_format == "json":
        report = {
            "summary": {
                "total_units_checked": len(archived_units) + len(active_units),
                "archived_count": len(archived_units),
                "active_count": len(active_units),
                "total_archived_projects_found": len(archived_projects)
            },
            "archived_units": archived_units,
            "active_units": active_units,
            "recommendation": "Archive units with archived GitLab repos in Finedog manually" if archived_units else None
        }
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return
    
    # Table format
    print("=" * 80)
    print("           FINEDOG UNITS GITLAB ARCHIVE STATUS CHECK REPORT")
    print("=" * 80)
    print()

    if archived_units:
        print("❌ RESULT: Found units with archived GitLab repositories!")
        print()
        print("-" * 80)
        print("ARCHIVED UNITS:")
        print("-" * 80)
        print(f"{'Unit ID':<10} {'Name':<30} {'Finedog':<12} {'GitLab Repository'}")
        print("-" * 80)
        for unit in archived_units:
            finedog_status = "✅ Archived" if unit.get('finedog_archived') else "❌ Active"
            print(f"📦 {unit['unit_id']:<8} {unit['name']:<30} {finedog_status:<12} {unit['project_path']}")

        # Count units that need manual archival
        needs_archival = [u for u in archived_units if not u.get('finedog_archived')]
        if needs_archival:
            print()
            print("-" * 80)
            print("RECOMMENDATION:")
            print("-" * 80)
            print(f"{len(needs_archival)} unit(s) need manual archival in Finedog:")
            unit_ids = ", ".join(str(u['unit_id']) for u in needs_archival)
            print(f"  python3 archive-units.py {unit_ids}")
    else:
        print("✅ RESULT: All checked units have active (non-archived) GitLab repositories")
    
    print()
    print("-" * 80)
    print("STATISTICS:")
    print("-" * 80)
    print(f"  Total units checked:           {len(archived_units) + len(active_units)}")
    print(f"  Archived units:                {len(archived_units)}")
    print(f"  Active units:                  {len(active_units)}")
    print(f"  Archived projects found:       {len(archived_projects)}")
    
    if archived_projects and not archived_units:
        print()
        print("-" * 80)
        print("ARCHIVED PROJECTS (not linked to checked units):")
        print("-" * 80)
        for project in sorted(archived_projects)[:20]:
            print(f"  - {project}")
        if len(archived_projects) > 20:
            print(f"  ... and {len(archived_projects) - 20} more")
    
    print()
    print("=" * 80)


def main():
    parser = argparse.ArgumentParser(
        description="Check GitLab archived status for Finedog units",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Check units by parent IDs
  python3 check-gitlab-archived.py --parent 5224 --parent 28324

  # Check units by search query
  python3 check-gitlab-archived.py --query "MyService" --query "Platform"

  # Check specific unit IDs
  python3 check-gitlab-archived.py --unit 12345 --unit 67890

  # Combine multiple search methods
  python3 check-gitlab-archived.py --parent 5224 --query "adtech" --unit 78383

  # Output as JSON
  python3 check-gitlab-archived.py --output json
        """
    )
    parser.add_argument(
        "--output",
        choices=["table", "json"],
        default="table",
        help="Output format (default: table)"
    )
    parser.add_argument(
        "--parent",
        type=int,
        action="append",
        dest="parent_ids",
        help="Parent unit ID to search for children (can be specified multiple times)"
    )
    parser.add_argument(
        "--query",
        action="append",
        dest="queries",
        help="Search query for units (can be specified multiple times)"
    )
    parser.add_argument(
        "--unit",
        type=int,
        action="append",
        dest="unit_ids",
        help="Specific unit ID to check (can be specified multiple times)"
    )
    args = parser.parse_args()
    
    # Default to parent ID 5224 if no search criteria specified
    if not args.parent_ids and not args.queries and not args.unit_ids:
        args.parent_ids = [5224]
        print("No search criteria specified, defaulting to parent ID 5224", file=sys.stderr)
    
    # Get tokens
    print("Loading tokens from .env...", file=sys.stderr)
    finedog_token, gitlab_token = get_env_tokens()
    
    if not finedog_token:
        sys.exit(1)
    
    # Get units from Finedog
    print("Fetching units from Finedog API...", file=sys.stderr)
    units = get_units_from_finedog(
        finedog_token,
        parent_ids=args.parent_ids,
        queries=args.queries,
        unit_ids=args.unit_ids
    )
    print(f"Found {len(units)} units with GitLab repositories", file=sys.stderr)
    
    if not units:
        print("\nNo units with GitLab URLs found. Nothing to check.", file=sys.stderr)
        sys.exit(0)
    
    # Extract project paths from GitLab URLs
    project_paths = set()
    for unit in units.values():
        gitlab_url = unit.get("gitlab", "")
        if gitlab_url:
            project_path = gitlab_url.replace("https://gitlab.tcsbank.ru/", "")
            project_paths.add(project_path)
    
    # Get archived projects from GitLab
    archived_projects = set()
    if gitlab_token:
        print(f"Checking {len(project_paths)} GitLab projects for archived status...", file=sys.stderr)
        archived_projects = get_archived_gitlab_projects(gitlab_token, project_paths)
    else:
        print("Skipping GitLab API check (no token)", file=sys.stderr)
    
    # Check archived status
    print("Analyzing results...", file=sys.stderr)
    archived_units, active_units = check_archived_status(units, archived_projects)
    
    # Print report
    print()
    print_report(archived_units, active_units, archived_projects, args.output)


if __name__ == "__main__":
    main()
