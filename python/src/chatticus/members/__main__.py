"""Administrator CLI: list, inspect, and mutate organization records."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime

from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import DynamoMessagingStore
from chatticus.models import (
    ChatticusError,
    MemberRole,
    Organization,
    OrganizationStatus,
    OrganizationStatusTransitionError,
)
from chatticus.worker.openai_completion import load_local_env

PlaneFactory = Callable[[], ControlPlane]


def main(
    argv: list[str] | None = None, *, plane_factory: PlaneFactory | None = None
) -> int:
    """Run one members administrator command."""
    parser = argparse.ArgumentParser(
        prog="python -m chatticus.members",
        description=(
            "Inspect and mutate Chatticus organization records. "
            "Reads the messaging table from CHATTICUS_MESSAGING_TABLE."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser(
        "list",
        help="List organizations filtered by lifecycle status",
    )
    list_parser.add_argument(
        "--status",
        required=True,
        choices=[status.value for status in OrganizationStatus],
        help="Organization lifecycle status to list",
    )

    show_parser = subparsers.add_parser("show", help="Show one organization")
    show_parser.add_argument("tenant_id", help="tenant_id")

    enable_parser = subparsers.add_parser(
        "enable",
        help="Enable one pending organization without provisioning a computer",
    )
    enable_parser.add_argument("tenant_id", help="tenant_id")
    enable_parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when stdin is not a TTY",
    )

    suspend_parser = subparsers.add_parser(
        "suspend",
        help="Suspend one enabled organization",
    )
    suspend_parser.add_argument("tenant_id", help="tenant_id")
    suspend_parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when stdin is not a TTY",
    )

    set_role_parser = subparsers.add_parser(
        "set-role",
        help="Set one member role on the admin path",
    )
    set_role_parser.add_argument("tenant_id", help="tenant_id")
    set_role_parser.add_argument("user_id", help="member user_id")
    set_role_parser.add_argument(
        "role",
        choices=[role.value for role in MemberRole],
        help="member role",
    )
    set_role_parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when stdin is not a TTY",
    )

    create_parser = subparsers.add_parser(
        "create",
        help="Create one pending organization for a cold bootstrap path",
    )
    create_parser.add_argument(
        "--owner-email",
        required=True,
        help="Verified owner email; normalized to lowercase",
    )
    create_parser.add_argument(
        "--name",
        required=True,
        help="Organization display name",
    )
    create_parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when stdin is not a TTY",
    )

    seed_parser = subparsers.add_parser(
        "seed",
        help="Seed one tenant enabled for one owner without provisioning a computer",
    )
    seed_parser.add_argument(
        "--tenant-id",
        required=True,
        help="tenant_id to seed, for example anthus",
    )
    seed_parser.add_argument(
        "--owner-email",
        required=True,
        help="Verified owner email; normalized to lowercase",
    )
    seed_parser.add_argument(
        "--name",
        help="Organization display name (default: tenant id)",
    )
    seed_parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when stdin is not a TTY",
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
            return _cmd_list(plane, OrganizationStatus(args.status))
        if args.command == "show":
            return _cmd_show(plane, args.tenant_id)
        if args.command == "enable":
            return _cmd_enable(plane, args.tenant_id, yes=args.yes)
        if args.command == "suspend":
            return _cmd_suspend(plane, args.tenant_id, yes=args.yes)
        if args.command == "create":
            return _cmd_create(
                plane,
                args.owner_email,
                args.name,
                yes=args.yes,
            )
        if args.command == "seed":
            return _cmd_seed(
                plane,
                args.tenant_id,
                args.owner_email,
                name=args.name or args.tenant_id,
                yes=args.yes,
            )
        return _cmd_set_role(
            plane,
            args.tenant_id,
            args.user_id,
            MemberRole(args.role),
            yes=args.yes,
        )
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


def _cmd_list(plane: ControlPlane, status: OrganizationStatus) -> int:
    organizations = plane.list_organizations_by_status(status)
    for organization in organizations:
        _print_org_line(organization)
    return 0


def _cmd_show(plane: ControlPlane, tenant_id: str) -> int:
    organization = plane.get_organization(tenant_id)
    _print_org_line(organization)
    return 0


def _cmd_enable(plane: ControlPlane, tenant_id: str, *, yes: bool) -> int:
    organization = plane.get_organization(tenant_id)
    _require_yes(yes, action="enable")
    _print_org_summary(organization)
    if organization.status != OrganizationStatus.PENDING:
        raise OrganizationStatusTransitionError(
            f"Organization {tenant_id!r} has status "
            f"{organization.status!r}; enable requires pending."
        )
    updated = plane.enable_organization(tenant_id)
    print(f"enabled tenant_id={updated.tenant_id} status={updated.status}")
    return 0


def _cmd_suspend(plane: ControlPlane, tenant_id: str, *, yes: bool) -> int:
    organization = plane.get_organization(tenant_id)
    _require_yes(yes, action="suspend")
    _print_org_summary(organization)
    if organization.status != OrganizationStatus.ENABLED:
        raise OrganizationStatusTransitionError(
            f"Organization {tenant_id!r} has status "
            f"{organization.status!r}; suspend requires enabled."
        )
    updated = plane.suspend_organization(tenant_id)
    print(f"suspended tenant_id={updated.tenant_id} status={updated.status}")
    return 0


def _cmd_set_role(
    plane: ControlPlane,
    tenant_id: str,
    user_id: str,
    role: MemberRole,
    *,
    yes: bool,
) -> int:
    organization = plane.get_organization(tenant_id)
    _require_yes(yes, action="set-role")
    _print_org_summary(organization)
    membership = plane.admin_set_member_role(tenant_id, user_id, role)
    print(
        f"set-role tenant_id={membership.tenant_id} "
        f"user_id={membership.user_id} role={membership.role}"
    )
    return 0


def _cmd_create(
    plane: ControlPlane,
    owner_email: str,
    name: str,
    *,
    yes: bool,
) -> int:
    _require_yes(yes, action="create")
    now = datetime.now(UTC)
    owner = plane.sign_in(owner_email, now=now)
    organization = plane.create_organization(owner, name, now=now)
    print(
        "created "
        f"tenant_id={organization.tenant_id} "
        f"status={organization.status} "
        f"owner={owner.user_id}"
    )
    return 0


def _cmd_seed(
    plane: ControlPlane,
    tenant_id: str,
    owner_email: str,
    *,
    name: str,
    yes: bool,
) -> int:
    _require_yes(yes, action="seed")
    now = datetime.now(UTC)
    organization = plane.admin_seed_organization(
        tenant_id,
        owner_email,
        name=name,
        now=now,
    )
    print(
        f"seeded tenant_id={organization.tenant_id} "
        f"status={organization.status} "
        f"owner={organization.owner_user_id} "
        f"email={owner_email.strip().lower()}"
    )
    return 0


def _require_yes(yes: bool, *, action: str) -> None:
    if sys.stdin.isatty() or yes:
        return
    raise RuntimeError(f"Refusing {action} without --yes (stdin is not a TTY).")


def _print_org_line(organization: Organization) -> None:
    print(
        f"{organization.tenant_id}\t{organization.name}\t"
        f"{organization.status}\t{organization.owner_user_id}"
    )


def _print_org_summary(organization: Organization) -> None:
    print(f"tenant_id={organization.tenant_id}")
    print(f"name={organization.name}")
    print(f"status={organization.status}")
    print(f"owner={organization.owner_user_id}")


if __name__ == "__main__":
    sys.exit(main())
