"""Record the content hash (SHA-256) of each analysis's video in its job folder, as input/sha256.txt.

The hash is the canonical video identity: a built-in sample and an upload of the same file become one session.
The tool only adds one small file per job that does not have one yet. It deletes nothing and never touches the
analysis outputs. Run it on the Mac, against the job database and the sample files, before the sessions list is used.

The job list comes from the running backend's API (its database lives in a Docker volume, not on the host).

Usage: python tools/backfill_video_identity.py --api http://localhost:8000 --env-file ../.env.local \
           --outputs ../outputs --data ../data --manifest ../data/manifest.json [--dry-run]
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import urllib.request


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", required=True)
    parser.add_argument("--env-file", required=True, help="the git-ignored env file that holds SMASHLAB_API_TOKEN")
    parser.add_argument("--outputs", required=True)
    parser.add_argument("--data", required=True, help="the input directory that the manifest's file paths are relative to")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest = json.load(open(args.manifest, encoding="utf-8"))
    sample_files = {entry["id"]: os.path.join(args.data, entry["file"]) for entry in manifest.get("samples", [])}
    token = ""
    for line in open(args.env_file, encoding="utf-8"):
        if line.startswith("SMASHLAB_API_TOKEN="):
            token = line.split("=", 1)[1].strip()
    request = urllib.request.Request(f"{args.api}/api/v1/analyses?limit=200", headers={"authorization": f"Bearer {token}"})
    listing = json.load(urllib.request.urlopen(request, timeout=30))["analyses"]
    rows = [(item["job_id"], item["source"]["kind"], item["source"].get("sample_id"), os.path.join(args.outputs, item["job_id"]))
            for item in listing]

    written, skipped, missing = 0, 0, []
    for job_id, kind, detail, recorded_dir in rows:
        output_dir = recorded_dir
        target = os.path.join(output_dir, "input", "sha256.txt")
        if os.path.isfile(target):
            skipped += 1
            continue
        if kind == "sample":
            source = sample_files.get(detail)
        else:
            matches = sorted(glob.glob(os.path.join(output_dir, "input", "input.*")))
            source = matches[0] if matches else None
        if not source or not os.path.isfile(source):
            missing.append((job_id, kind, detail))
            continue
        digest = sha256_file(source)
        print(f"{job_id[:8]} {kind:6} {digest[:16]}… {'(dry run)' if args.dry_run else ''}")
        if not args.dry_run:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(digest + "\n")
        written += 1
    print(f"written {written}, already recorded {skipped}, source file not found {len(missing)}")
    for item in missing:
        print("  not found:", item)
    return 0


if __name__ == "__main__":
    sys.exit(main())
