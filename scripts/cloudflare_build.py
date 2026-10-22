#!/usr/bin/env python3
"""Build and validate a Cloudflare Pages deployment without GitHub credentials."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for arguments in (
    ["scripts/release_pipeline.py", "download"],
    ["scripts/build.py"],
    ["-m", "unittest", "discover", "-s", "tests", "-v"],
):
    subprocess.run([sys.executable, *arguments], cwd=ROOT, check=True)

subprocess.run(["node", "tests/cloudflare-routing.mjs"], cwd=ROOT, check=True)
subprocess.run(["node", "tests/admin-auth.mjs"], cwd=ROOT, check=True)

subprocess.run(["node", "tests/ipa-upload.mjs"], cwd=ROOT, check=True)
