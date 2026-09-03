"""Operator CLI: list and export scored waitlist signups."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable

from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import DynamoMessagingStore
from chatticus.models import ChatticusError
from chatticus.waitlist.csv_export import render_waitlist_csv
from chatticus.waitlist.formatting import (
    print_waitlist_list,
    sort_waitlist_by_score_desc,
)
from chatticus.worker.openai_completion import load_local_env

PlaneFactory = Callable[[], ControlPlane]


def main(
    argv: list[str] | None = None, *, plane_factory: PlaneFactory | None = None
) -> int:
    """Run one waitlist operator command."""
    parser = argparse.ArgumentParser(
        prog="python -m chatticus.waitlist",
        description=(
            "List and export Chatticus waitlist signups. "
            "Reads the messaging table from CHATTICUS_MESSAGING_TABLE."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser(
        "list",
        help="List confirmed waitlist signups",
    )
    list_mode = list_parser.add_mutually_exclusive_group()
    list_mode.add_argument(
        "--services-qualified",
        action="store_true",
        help="List only services-qualified signups from the operator queue",
    )
    list_mode.add_argument(
        "--disqualified",
        action="store_true",
        help="List only disqualified confirmed signups",
    )

    export_parser = subparsers.add_parser(
        "export",
        help="Export waitlist signups as CSV to stdout",
    )
    export_parser.add_argument(
        "--include-disqualified",
        action="store_true",
        help="Include disqualified signups in the export",
    )

    args = parser.parse_args(argv)
    build_plane = plane_factory or _plane_from_env
    try:
        plane = build_plane()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2

    try:
        if args.command == "list":
            return _cmd_list(
                plane,
                services_qualified=args.services_qualified,
                disqualified=args.disqualified,
            )
        return _cmd_export(plane, include_disqualified=args.include_disqualified)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2
    except ChatticusError as error:
        print(str(error), file=sys.stderr)
        return 1


def _plane_from_env() -> ControlPlane:
    load_local_env()
    table_name = os.environ.get("CHATTICUS_MESSAGING_TABLE", "").strip()
    if not table_name:
        raise RuntimeError("CHATTICUS_MESSAGING_TABLE is required.")
    return ControlPlane(messaging_store=DynamoMessagingStore(table_name))


def _cmd_list(
    plane: ControlPlane,
    *,
    services_qualified: bool,
    disqualified: bool,
) -> int:
    if disqualified:
        signups = [
            signup
            for signup in plane.list_confirmed_waitlist_signups()
            if signup.disqualified
        ]
        print_waitlist_list(signups)
        return 0

    signups = plane.list_waitlist_queue()
    if services_qualified:
        signups = [signup for signup in signups if signup.services_qualified]
    print_waitlist_list(sort_waitlist_by_score_desc(signups))
    return 0


def _cmd_export(plane: ControlPlane, *, include_disqualified: bool) -> int:
    if include_disqualified:
        signups = plane.list_confirmed_waitlist_signups()
    else:
        signups = plane.list_waitlist_queue()
    print(render_waitlist_csv(sort_waitlist_by_score_desc(signups)), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
