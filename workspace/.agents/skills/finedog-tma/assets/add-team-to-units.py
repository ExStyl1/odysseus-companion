#!/usr/bin/env python3
"""
Add a team to Finedog units.

Supports two modes:
1. Add team to all child units of a parent unit
2. Add team to specific units by ID

Uses POST /v1/units/{unitId}/teams endpoint.

Usage:
    # Add team to all children of parent unit
    python3 add-team-to-units.py --parent 83021 --team 343626

    # Add team to specific units
    python3 add-team-to-units.py --units 123 456 789 --team 343626

    # Dry run (show what would be changed)
    python3 add-team-to-units.py --parent 83021 --team 343626 --dry-run

    # Require confirmation before applying
    python3 add-team-to-units.py --parent 83021 --team 343626 --confirm
"""

import json
import subprocess
import sys
import argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent.parent
ENV_FILE = REPO_ROOT / ".env"
API_BASE = "https://finedog.tinkoff.ru/api/integration/v1"


def get_fd_token():
    """Extract JWT token from .env file."""
    if not ENV_FILE.exists():
        print(f"Error: .env file not found at {ENV_FILE}")
        sys.exit(1)
    
    with open(ENV_FILE) as f:
        for line in f:
            if line.startswith("token=Bearer "):
                return line.strip().replace("token=Bearer ", "")
    
    print("Error: token not found in .env")
    sys.exit(1)


def get_child_units(parent_id, token):
    """Fetch all child units of a parent."""
    cmd = [
        "curl", "-s",
        "-X", "POST",
        "-H", f"Authorization: Bearer {token}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"parentIds": [parent_id], "page": 1, "pageSize": 200}),
        f"{API_BASE}/units/list"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error fetching units: {result.stderr}")
        return []
    data = json.loads(result.stdout)
    return data.get("items", [])


def get_units_by_ids(unit_ids, token):
    """Fetch units by their IDs."""
    units = []
    for unit_id in unit_ids:
        cmd = [
            "curl", "-s",
            "-H", f"Authorization: Bearer {token}",
            f"{API_BASE}/units/{unit_id}"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error fetching unit {unit_id}: {result.stderr}")
            continue
        data = json.loads(result.stdout)
        if data and "id" in data:
            units.append(data)
    return units


def add_team_to_unit(unit_id, team_id, token):
    """Add a team to a unit using POST /units/{id}/teams."""
    cmd = [
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", "POST",
        "-H", f"Authorization: Bearer {token}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"teamId": team_id}),
        f"{API_BASE}/units/{unit_id}/teams"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(
        description="Add a team to Finedog units",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Add team to all children of parent unit
  python3 add-team-to-units.py --parent 83021 --team 343626

  # Add team to specific units
  python3 add-team-to-units.py --units 123 456 789 --team 343626

  # Dry run (show what would be changed)
  python3 add-team-to-units.py --parent 83021 --team 343626 --dry-run

  # Require confirmation before applying
  python3 add-team-to-units.py --parent 83021 --team 343626 --confirm
"""
    )
    
    parser.add_argument(
        "--team", "-t",
        type=int,
        required=True,
        help="Team ID to add to units"
    )
    
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--parent", "-p",
        type=int,
        help="Parent unit ID (add team to all child units)"
    )
    group.add_argument(
        "--units", "-u",
        type=int,
        nargs="+",
        help="Unit IDs to add team to (space-separated)"
    )
    
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be changed without applying"
    )
    
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Require explicit confirmation before applying changes"
    )
    
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    
    args = parser.parse_args()
    
    # Validate arguments
    if args.parent is None and args.units is None:
        print("Error: Either --parent or --units must be specified")
        sys.exit(1)
    
    token = get_fd_token()
    
    # Get units to process
    if args.parent:
        print(f"Fetching child units of parent {args.parent}...")
        units = get_child_units(args.parent, token)
        print(f"Found {len(units)} units.")
        target_description = f"child units of parent {args.parent}"
    else:
        print(f"Fetching {len(args.units)} units by ID...")
        units = get_units_by_ids(args.units, token)
        print(f"Found {len(units)} units.")
        target_description = f"specified units"
    
    print()
    
    # Filter units that don't have the team
    units_to_update = [u for u in units if args.team not in u.get("teamsIds", [])]
    units_already_have = [u for u in units if args.team in u.get("teamsIds", [])]
    
    print(f"Units already have team {args.team}: {len(units_already_have)}")
    for u in units_already_have:
        if args.verbose:
            print(f"  - {u['id']} ({u['name']})")
    
    print(f"Units need team {args.team} added: {len(units_to_update)}")
    for u in units_to_update:
        print(f"  - {u['id']} ({u['name']})")
    print()
    
    if not units_to_update:
        print(f"✅ All units already have team {args.team}.")
        return
    
    # Dry run mode
    if args.dry_run:
        print("🔍 DRY RUN - No changes will be made")
        print(f"Would add team {args.team} to {len(units_to_update)} units:")
        for u in units_to_update:
            print(f"  - {u['id']} ({u['name']})")
        return
    
    # Confirmation mode
    if args.confirm:
        print(f"⚠️  This will add team {args.team} to {len(units_to_update)} units.")
        print()
        response = input("Type 'yes' to confirm: ").strip().lower()
        if response != "yes":
            print("Cancelled.")
            sys.exit(0)
        print()
    
    # Apply changes
    print(f"Adding team {args.team} to {len(units_to_update)} units...")
    print()
    
    success_count = 0
    fail_count = 0
    
    for unit in units_to_update:
        unit_id = unit["id"]
        unit_name = unit["name"]
        current_teams = unit.get("teamsIds", [])
        
        print(f"Processing unit {unit_id} ({unit_name})...")
        
        http_code = add_team_to_unit(unit_id, args.team, token)
        
        if http_code == "200":
            print(f"  ✅ Added team {args.team} to unit {unit_id} ({unit_name})")
            success_count += 1
        else:
            print(f"  ❌ Failed to add team {args.team} to unit {unit_id} ({unit_name}) - HTTP {http_code}")
            fail_count += 1
        
        # Rate limiting
        import time
        time.sleep(0.3)
    
    print()
    print("=" * 60)
    print(f"Done! Success: {success_count}, Failed: {fail_count}")
    print(f"Units already had team: {len(units_already_have)}")
    print("=" * 60)
    
    if fail_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
