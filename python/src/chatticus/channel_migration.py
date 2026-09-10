"""One-pass audit and migration for canonical channel identities."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LegacyChannelClassification:
    """Canonical classification derived from one legacy channel row."""

    tenant_id: str
    channel_id: str
    user_id: str
    bot_ids: tuple[str, ...]
    kind: str


def classify_legacy_channel(item: dict[str, Any]) -> LegacyChannelClassification:
    """Classify a legacy channel item from its stored participants.

    :param item: Low-level DynamoDB channel metadata item.
    :raises ValueError: If the participant set cannot become a canonical channel.
    """
    participants = json.loads(item["participants"]["S"])
    human_ids = [row["actor_id"] for row in participants if row["kind"] == "human"]
    bot_ids = tuple(row["actor_id"] for row in participants if row["kind"] == "bot")
    if len(human_ids) != 1 or not bot_ids:
        raise ValueError("a canonical channel requires one human and at least one bot")
    return LegacyChannelClassification(
        tenant_id=item["tenant_id"]["S"],
        channel_id=item["channel_id"]["S"],
        user_id=human_ids[0],
        bot_ids=bot_ids,
        kind="direct" if len(bot_ids) == 1 else "named",
    )


def audit_legacy_channels(
    items: list[dict[str, Any]],
) -> list[LegacyChannelClassification]:
    """Return classifications and reject duplicate direct identities.

    :param items: Low-level DynamoDB items returned by a table scan.
    :raises ValueError: If more than one legacy channel maps to one direct identity.
    """
    classifications = [classify_legacy_channel(item) for item in items]
    seen: dict[tuple[str, str, str], str] = {}
    for channel in classifications:
        if channel.kind != "direct":
            continue
        identity = (channel.tenant_id, channel.user_id, channel.bot_ids[0])
        previous = seen.get(identity)
        if previous is not None:
            raise ValueError(
                f"duplicate direct identity in channels {previous!r} and "
                f"{channel.channel_id!r}"
            )
        seen[identity] = channel.channel_id
    return classifications


def _legacy_channel_items(client: Any, table_name: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    start_key = None
    while True:
        request: dict[str, Any] = {
            "TableName": table_name,
            "FilterExpression": "sk = :meta AND attribute_not_exists(#kind)",
            "ExpressionAttributeNames": {"#kind": "kind"},
            "ExpressionAttributeValues": {":meta": {"S": "meta"}},
        }
        if start_key is not None:
            request["ExclusiveStartKey"] = start_key
        response = client.scan(**request)
        items.extend(
            item
            for item in response.get("Items", [])
            if "channel_id" in item and "participants" in item
        )
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return items


def _parse_names(values: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    for value in values:
        channel_id, separator, name = value.partition("=")
        if not separator or not channel_id.strip() or not name.strip():
            raise ValueError("channel names use CHANNEL_ID=NAME")
        names[channel_id.strip()] = name.strip()
    return names


def _message_items(
    client: Any, table_name: str, channel: LegacyChannelClassification
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    start_key = None
    while True:
        request: dict[str, Any] = {
            "TableName": table_name,
            "KeyConditionExpression": "pk = :pk AND begins_with(sk, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": {"S": f"{channel.tenant_id}#channel#{channel.channel_id}"},
                ":prefix": {"S": "msg#"},
            },
        }
        if start_key is not None:
            request["ExclusiveStartKey"] = start_key
        response = client.query(**request)
        items.extend(response.get("Items", []))
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return sorted(items, key=lambda item: item["sk"]["S"])


def _channel_delete_operations(
    table_name: str,
    channel: LegacyChannelClassification,
    *,
    message_items: list[dict[str, Any]],
    expected_next_seq: int | None = None,
    require_no_active_turn: bool = False,
) -> list[dict[str, Any]]:
    deletes = [
        {
            "Delete": {
                "TableName": table_name,
                "Key": {"pk": item["pk"], "sk": item["sk"]},
            }
        }
        for item in message_items
    ]
    metadata_delete: dict[str, Any] = {
        "TableName": table_name,
        "Key": {
            "pk": {"S": f"{channel.tenant_id}#channel#{channel.channel_id}"},
            "sk": {"S": "meta"},
        },
    }
    if expected_next_seq is not None:
        metadata_delete.update(
            {
                "ConditionExpression": (
                    "next_seq = :expected AND attribute_not_exists(#kind)"
                ),
                "ExpressionAttributeNames": {"#kind": "kind"},
                "ExpressionAttributeValues": {
                    ":expected": {"N": str(expected_next_seq)}
                },
            }
        )
    deletes.extend(
        [
            {"Delete": metadata_delete},
            {
                "Delete": {
                    "TableName": table_name,
                    "Key": {
                        "pk": {"S": f"channel_lookup#{channel.channel_id}"},
                        "sk": {"S": "meta"},
                    },
                }
            },
            {
                "Delete": {
                    "TableName": table_name,
                    "Key": {
                        "pk": {"S": f"{channel.tenant_id}#roster"},
                        "sk": {"S": f"channel#{channel.user_id}#{channel.channel_id}"},
                    },
                }
            },
        ]
    )
    if require_no_active_turn:
        deletes.append(
            {
                "ConditionCheck": {
                    "TableName": table_name,
                    "Key": {
                        "pk": {
                            "S": f"{channel.tenant_id}#channel#{channel.channel_id}"
                        },
                        "sk": {"S": "active_turn"},
                    },
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        )
    return deletes


def _delete_channel_identity(
    client: Any,
    table_name: str,
    channel: LegacyChannelClassification,
    *,
    message_items: list[dict[str, Any]],
) -> None:
    client.transact_write_items(
        TransactItems=_channel_delete_operations(
            table_name, channel, message_items=message_items
        )
    )


def _merge_duplicate_direct_channels(
    client: Any,
    table_name: str,
    channels: list[LegacyChannelClassification],
    canonical_channel_id: str,
) -> None:
    canonical = next(
        channel for channel in channels if channel.channel_id == canonical_channel_id
    )
    metadata_key = {
        "pk": {"S": f"{canonical.tenant_id}#channel#{canonical.channel_id}"},
        "sk": {"S": "meta"},
    }
    metadata = client.get_item(TableName=table_name, Key=metadata_key)["Item"]
    next_seq = int(metadata["next_seq"]["N"])
    for source in sorted(channels, key=lambda channel: channel.channel_id):
        if source.channel_id == canonical.channel_id:
            continue
        active_turn = client.get_item(
            TableName=table_name,
            Key={
                "pk": {"S": f"{source.tenant_id}#channel#{source.channel_id}"},
                "sk": {"S": "active_turn"},
            },
        ).get("Item")
        if active_turn is not None:
            raise ValueError(
                f"channel {source.channel_id!r} has an active turn and cannot be merged"
            )
        source_metadata = client.get_item(
            TableName=table_name,
            Key={
                "pk": {"S": f"{source.tenant_id}#channel#{source.channel_id}"},
                "sk": {"S": "meta"},
            },
        )["Item"]
        source_next_seq = int(source_metadata["next_seq"]["N"])
        source_messages = _message_items(client, table_name, source)
        if len(source_messages) > 10:
            raise ValueError(
                f"channel {source.channel_id!r} has too many messages for one "
                "atomic duplicate merge"
            )
        expected_canonical_next_seq = next_seq
        writes: list[dict[str, Any]] = []
        for item in source_messages:
            copied = dict(item)
            copied["pk"] = metadata_key["pk"]
            copied["sk"] = {"S": f"msg#{next_seq:010d}"}
            copied["channel_id"] = {"S": canonical.channel_id}
            copied["seq"] = {"N": str(next_seq)}
            writes.append({"Put": {"TableName": table_name, "Item": copied}})
            next_seq += 1
        client.transact_write_items(
            TransactItems=[
                *writes,
                *_channel_delete_operations(
                    table_name,
                    source,
                    message_items=source_messages,
                    expected_next_seq=source_next_seq,
                    require_no_active_turn=True,
                ),
                {
                    "Update": {
                        "TableName": table_name,
                        "Key": metadata_key,
                        "UpdateExpression": "SET next_seq = :next_seq",
                        "ExpressionAttributeValues": {
                            ":next_seq": {"N": str(next_seq)},
                            ":expected": {"N": str(expected_canonical_next_seq)},
                        },
                        "ConditionExpression": "next_seq = :expected",
                    }
                },
            ],
        )
    client.update_item(
        TableName=table_name,
        Key=metadata_key,
        UpdateExpression="SET #kind = :kind",
        ExpressionAttributeNames={"#kind": "kind"},
        ExpressionAttributeValues={":kind": {"S": "direct"}},
        ConditionExpression="attribute_not_exists(#kind)",
    )


def main(argv: list[str] | None = None) -> int:
    """Audit legacy channels and optionally apply one canonical migration."""
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--table", default=os.environ.get("CHATTICUS_MESSAGING_TABLE"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--name", action="append", default=[], metavar="CHANNEL_ID=NAME"
    )
    parser.add_argument(
        "--canonical", action="append", default=[], metavar="CHANNEL_ID"
    )
    parser.add_argument(
        "--drop-empty", action="append", default=[], metavar="CHANNEL_ID"
    )
    args = parser.parse_args(argv)
    if not args.table:
        parser.error("--table or CHATTICUS_MESSAGING_TABLE is required")

    import boto3

    client = boto3.client("dynamodb")
    raw_items = _legacy_channel_items(client, args.table)
    channels: list[LegacyChannelClassification] = []
    invalid_channels: list[LegacyChannelClassification] = []
    for item in raw_items:
        try:
            channels.append(classify_legacy_channel(item))
        except ValueError:
            participants = json.loads(item["participants"]["S"])
            humans = [row["actor_id"] for row in participants if row["kind"] == "human"]
            bots = [row["actor_id"] for row in participants if row["kind"] == "bot"]
            invalid_channels.append(
                LegacyChannelClassification(
                    tenant_id=item["tenant_id"]["S"],
                    channel_id=item["channel_id"]["S"],
                    user_id=humans[0] if len(humans) == 1 else "",
                    bot_ids=tuple(bots),
                    kind="invalid",
                )
            )
    direct_groups: dict[tuple[str, str, str], list[LegacyChannelClassification]] = {}
    for channel in channels:
        if channel.kind == "direct":
            direct_groups.setdefault(
                (channel.tenant_id, channel.user_id, channel.bot_ids[0]), []
            ).append(channel)
    duplicate_groups = [group for group in direct_groups.values() if len(group) > 1]
    names = _parse_names(args.name)
    missing_names = [
        channel.channel_id
        for channel in channels
        if channel.kind == "named" and channel.channel_id not in names
    ]
    if args.apply and missing_names:
        raise ValueError(
            "named channels require explicit stored names: " + ", ".join(missing_names)
        )
    print(
        json.dumps(
            {
                "channels": [channel.__dict__ for channel in channels],
                "invalid_channels": [channel.__dict__ for channel in invalid_channels],
                "duplicate_direct_groups": [
                    [channel.channel_id for channel in group]
                    for group in duplicate_groups
                ],
            },
            indent=2,
        )
    )
    if not args.apply:
        return 0
    canonical_ids = set(args.canonical)
    for group in duplicate_groups:
        selected = [channel for channel in group if channel.channel_id in canonical_ids]
        if len(selected) != 1:
            raise ValueError(
                "each duplicate direct group requires exactly one --canonical channel"
            )
    invalid_ids = {channel.channel_id for channel in invalid_channels}
    if set(args.drop_empty) != invalid_ids:
        raise ValueError("every invalid channel requires an explicit --drop-empty")
    for channel in invalid_channels:
        messages = _message_items(client, args.table, channel)
        if messages:
            raise ValueError(f"invalid channel {channel.channel_id!r} is not empty")
        _delete_channel_identity(client, args.table, channel, message_items=[])
    duplicate_channel_ids = {
        channel.channel_id for group in duplicate_groups for channel in group
    }
    for channel in channels:
        if channel.channel_id in duplicate_channel_ids:
            continue
        expression = "SET #kind = :kind"
        attribute_names = {"#kind": "kind"}
        attribute_values = {":kind": {"S": channel.kind}}
        if channel.kind == "named":
            expression += ", #name = :name"
            attribute_names["#name"] = "name"
            attribute_values[":name"] = {"S": names[channel.channel_id]}
        client.update_item(
            TableName=args.table,
            Key={
                "pk": {"S": f"{channel.tenant_id}#channel#{channel.channel_id}"},
                "sk": {"S": "meta"},
            },
            UpdateExpression=expression,
            ExpressionAttributeNames=attribute_names,
            ExpressionAttributeValues=attribute_values,
            ConditionExpression="attribute_not_exists(#kind)",
        )
    for group in duplicate_groups:
        canonical_id = next(
            channel.channel_id
            for channel in group
            if channel.channel_id in canonical_ids
        )
        _merge_duplicate_direct_channels(client, args.table, group, canonical_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
