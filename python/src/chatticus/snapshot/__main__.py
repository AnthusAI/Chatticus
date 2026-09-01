"""Administrator CLI: pack a host disk into the snapshot store, or hydrate."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import open_snapshot_store


def main(argv: list[str] | None = None) -> int:
    """Run pack or hydrate against a snapshot store."""
    parser = argparse.ArgumentParser(
        prog="python -m chatticus.snapshot",
        description=(
            "Publish or hydrate a Chatticus computer snapshot. "
            "Use a local directory as the store, or s3 / s3://bucket "
            "for the CDK snapshot bucket."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    pack_parser = subparsers.add_parser(
        "pack",
        help="Pack this host's live disk and write it to the store",
    )
    _add_common_args(pack_parser)
    pack_parser.add_argument(
        "--worker",
        required=True,
        help="worker_id of the host that currently has the live disk",
    )

    hydrate_parser = subparsers.add_parser(
        "hydrate",
        help="Load the published snapshot onto this host's live disk",
    )
    _add_common_args(hydrate_parser)

    args = parser.parse_args(argv)
    disk = ComputerHostDisk(
        Path(args.live_root),
        open_snapshot_store(args.store),
    )
    if args.command == "pack":
        manifest = disk.publish(
            tenant_id=args.tenant,
            computer_id=args.computer,
            worker_id=args.worker,
        )
        print(
            f"Published {manifest.checksum} "
            f"for {args.tenant}/{args.computer} as {args.worker}"
        )
        return 0
    manifest = disk.hydrate(tenant_id=args.tenant, computer_id=args.computer)
    print(f"Hydrated {manifest.checksum} for {args.tenant}/{args.computer}")
    return 0


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--live-root",
        required=True,
        help="Host directory containing workspace/ and browser-profiles/",
    )
    parser.add_argument(
        "--store",
        required=True,
        help="Local store directory, or s3 / s3://bucket for the CDK snapshot bucket",
    )
    parser.add_argument("--tenant", required=True, help="tenant_id")
    parser.add_argument("--computer", required=True, help="computer_id")


if __name__ == "__main__":
    sys.exit(main())
