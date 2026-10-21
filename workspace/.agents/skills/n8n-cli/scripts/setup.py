#!/usr/bin/env python3
"""Configure n8n-cli without exposing the API key in shell history."""

import argparse
import getpass
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_PROD_URL = "https://n8n.t-tech.team"
DEFAULT_TEST_URL = "https://n8n.dev-tcsgroup.io"


def parse_args():
    parser = argparse.ArgumentParser(description="Configure n8n-cli in ~/.n8n-cli")
    parser.add_argument(
        "--url",
        "--prod-url",
        dest="prod_url",
        default=DEFAULT_PROD_URL,
        help=f"prod n8n base URL; default: {DEFAULT_PROD_URL}",
    )
    parser.add_argument(
        "--test-url",
        default=DEFAULT_TEST_URL,
        help=f"test n8n base URL; default: {DEFAULT_TEST_URL}",
    )
    parser.add_argument("--api-key-stdin", action="store_true", help="Read the API key from stdin instead of a hidden prompt")
    parser.add_argument("--config-dir", help="Configuration directory; default: ~/.n8n-cli")
    parser.add_argument("--force", action="store_true", help="Replace existing configuration")
    return parser.parse_args()


def validated_url(raw):
    value = raw.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("URL must include http:// or https:// and a host")
    return value


def atomic_write(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def main():
    args = parse_args()
    config_dir = Path(args.config_dir or os.environ.get("N8N_CLI_CONFIG_DIR") or Path.home() / ".n8n-cli").expanduser()
    env_file = config_dir / ".env"
    secrets_file = config_dir / ".env.secrets"
    if not args.force and (env_file.exists() or secrets_file.exists()):
        print(f"Configuration already exists in {config_dir}; use --force to replace it.", file=sys.stderr)
        return 2

    try:
        prod_url = validated_url(args.prod_url)
        test_url = validated_url(args.test_url)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    print(f"Prod URL: {prod_url}")
    print(f"Test URL: {test_url}")
    if args.api_key_stdin:
        api_key = sys.stdin.readline().strip()
    else:
        api_key = getpass.getpass("n8n API key (input hidden): ").strip()
    if not api_key:
        print("Error: API key cannot be empty", file=sys.stderr)
        return 2

    atomic_write(
        env_file,
        "N8N_DEFAULT_ENV=prod\n"
        + (f"N8N_PROD_URL={prod_url}\n" if prod_url != DEFAULT_PROD_URL else "")
        + (f"N8N_TEST_URL={test_url}\n" if test_url != DEFAULT_TEST_URL else ""),
        0o600,
    )
    atomic_write(
        secrets_file,
        f"N8N_PROD_API_KEY={api_key}\nN8N_TEST_API_KEY=\n",
        0o600,
    )
    api_key = ""
    print(f"Configuration saved in {config_dir}")
    print("Next: run the n8n-cli test command from the installed Skill.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
