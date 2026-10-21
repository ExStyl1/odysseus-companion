#!/usr/bin/env python3
"""
Fetch team details from Finedog API and cache them.
Used to determine team types (sre, dev, support) for unit validation.
"""

import json
import os
import subprocess
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent.parent
ENV_FILE = REPO_ROOT / ".env"
CACHE_FILE = SCRIPT_DIR / "teams_cache.json"
API_BASE = "https://finedog.tinkoff.ru/api/integration"


def get_fd_token():
    """Extract JWT token from .env file."""
    if not ENV_FILE.exists():
        print(f"Error: .env file not found at {ENV_FILE}")
        return None
    
    with open(ENV_FILE) as f:
        for line in f:
            if line.startswith("token=Bearer "):
                return line.strip().replace("token=Bearer ", "")
    
    print("Error: token not found in .env")
    return None


def fetch_all_unit_ids(token):
    """Fetch all unit IDs to discover team IDs."""
    cmd = [
        "curl", "-s",
        "-X", "POST",
        "-H", f"Authorization: Bearer {token}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"page": 1, "pageSize": 1000}),
        f"{API_BASE}/v1/units/list"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error fetching units: {result.stderr}")
        return []
    
    try:
        data = json.loads(result.stdout)
        items = data.get("items", [])
        # Collect all unique team IDs from units
        team_ids = set()
        for unit in items:
            for tid in unit.get("teamsIds", []):
                team_ids.add(tid)
        return list(team_ids)
    except json.JSONDecodeError:
        print("Error: Invalid JSON response")
        return []


def fetch_team_by_id(team_id, token):
    """Fetch a single team by ID."""
    cmd = [
        "curl", "-s",
        "-H", f"Authorization: Bearer {token}",
        f"{API_BASE}/v1/teams/{team_id}"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    
    try:
        data = json.loads(result.stdout)
        return data if isinstance(data, dict) and "id" in data else None
    except json.JSONDecodeError:
        return None


def fetch_teams(token):
    """Fetch all teams by discovering team IDs from units."""
    print("  📋 Discovering team IDs from units...")
    team_ids = fetch_all_unit_ids(token)
    print(f"  Found {len(team_ids)} unique team IDs")
    
    teams = []
    print("  🔄 Fetching team details...")
    for i, team_id in enumerate(team_ids, 1):
        team = fetch_team_by_id(team_id, token)
        if team:
            teams.append(team)
        if i % 10 == 0:
            print(f"    {i}/{len(team_ids)} teams fetched...")
    
    return teams


def save_cache(teams):
    """Save teams to cache file with metadata."""
    cache_data = {
        "updated": datetime.now().isoformat(),
        "count": len(teams),
        "teams": {t["id"]: t for t in teams}
    }
    
    with open(CACHE_FILE, "w") as f:
        json.dump(cache_data, f, indent=2)
    
    print(f"✅ Cached {len(teams)} teams to {CACHE_FILE}")


def load_cache():
    """Load teams from cache file."""
    if not CACHE_FILE.exists():
        return None
    
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def get_team_type(team_id, cache=None):
    """
    Get team type by team ID.
    
    Returns:
        str: 'sre', 'dev', 'support', or 'unknown'
    """
    if cache is None:
        cache = load_cache()
    
    if cache and "teams" in cache:
        team = cache["teams"].get(team_id)
        if team:
            # Check teamType field
            team_type = team.get("teamType", "").lower()
            if team_type == "sre":
                return "sre"
            elif team_type == "dev":
                return "dev"
            elif team_type == "support":
                return "support"
            
            # Fallback: check team name
            name = team.get("name", "").lower()
            if "sre" in name:
                return "sre"
            elif "support" in name:
                return "support"
    
    return "unknown"


def get_teams_by_type(teams_list, cache=None):
    """
    Separate teams by type.
    
    Args:
        teams_list: List of team IDs
        cache: Optional cache dict
    
    Returns:
        dict with 'sre', 'dev', 'support', 'unknown' lists
    """
    result = {"sre": [], "dev": [], "support": [], "unknown": []}
    
    for team_id in teams_list:
        team_type = get_team_type(team_id, cache)
        result[team_type].append(team_id)
    
    return result


def main():
    """Fetch and cache teams."""
    print("🔄 Fetching teams from Finedog API...")
    
    token = get_fd_token()
    if not token:
        print("❌ Failed to get token")
        return 1
    
    teams = fetch_teams(token)
    if not teams:
        print("❌ No teams fetched")
        return 1
    
    save_cache(teams)
    
    # Show summary
    sre_count = sum(1 for t in teams if t.get("teamType", "").lower() == "sre")
    dev_count = sum(1 for t in teams if t.get("teamType", "").lower() == "dev")
    support_count = sum(1 for t in teams if t.get("teamType", "").lower() == "support")
    other_count = len(teams) - sre_count - dev_count - support_count
    
    print()
    print("📊 Team types summary:")
    print(f"  SRE teams: {sre_count}")
    print(f"  Dev teams: {dev_count}")
    print(f"  Support teams: {support_count}")
    print(f"  Other/Unknown: {other_count}")
    print(f"  Total: {len(teams)}")
    
    return 0


if __name__ == "__main__":
    exit(main())
