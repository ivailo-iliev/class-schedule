#!/usr/bin/env python3
"""Cron entry point for the GitHub delivery bridge.

The bridge defaults to a read-only diagnostic mode. Hermes cron scripts cannot
pass command-line arguments, so the scheduled entry point explicitly selects
the reviewed ``--apply`` behavior while keeping ad-hoc invocations safe.
"""

from importlib.machinery import SourceFileLoader
from pathlib import Path


bridge = SourceFileLoader(
    "github_delivery_bridge", str(Path(__file__).with_name("github-delivery-bridge.py"))
).load_module()

raise SystemExit(bridge.main(["--apply"]))
