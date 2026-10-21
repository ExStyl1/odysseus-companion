"""Compatibility entry point for existing Graphify workers."""
from pathlib import Path
from runpy import run_path
globals().update(run_path(str(Path(__file__).parent / "knowledge/projects.py"), run_name=__name__))
