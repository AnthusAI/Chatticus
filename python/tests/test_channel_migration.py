"""Pure classification tests for the one-pass channel migration."""

import json

import boto3
import pytest
from moto import mock_aws

from chatticus.channel_migration import (
    _merge_duplicate_direct_channels,
    audit_legacy_channels,
    classify_legacy_channel,
)
from chatticus.messaging.store import create_messaging_table


def _item(channel_id: str, bot_ids: list[str]) -> dict[str, object]:
    participants = [{"kind": "human", "actor_id": "ryan"}]
    participants.extend({"kind": "bot", "actor_id": bot_id} for bot_id in bot_ids)
    return {
        "tenant_id": {"S": "anthus"},
        "channel_id": {"S": channel_id},
        "participants": {"S": json.dumps(participants)},
    }


def test_classifies_one_bot_as_direct_and_multiple_bots_as_named() -> None:
    direct = classify_legacy_channel(_item("direct-1", ["researcher"]))
    named = classify_legacy_channel(_item("named-1", ["researcher", "writer"]))

    assert direct.kind == "direct"
    assert named.kind == "named"


def test_audit_rejects_duplicate_direct_identity() -> None:
    with pytest.raises(ValueError, match="duplicate direct identity"):
        audit_legacy_channels(
            [_item("direct-1", ["researcher"]), _item("direct-2", ["researcher"])]
        )


@mock_aws
def test_duplicate_direct_merge_preserves_messages_in_one_identity() -> None:
    table_name = "channel-migration"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    channels = []
    for channel_id in ("canonical", "source"):
        item = _item(channel_id, ["researcher"])
        item.update(
            {
                "pk": {"S": f"anthus#channel#{channel_id}"},
                "sk": {"S": "meta"},
                "next_seq": {"N": "2"},
            }
        )
        client.put_item(TableName=table_name, Item=item)
        channels.append(classify_legacy_channel(item))
        client.put_item(
            TableName=table_name,
            Item={
                "pk": {"S": f"anthus#channel#{channel_id}"},
                "sk": {"S": "msg#0000000001"},
                "tenant_id": {"S": "anthus"},
                "channel_id": {"S": channel_id},
                "message_id": {"S": f"message-{channel_id}"},
                "seq": {"N": "1"},
                "author_kind": {"S": "human"},
                "author_id": {"S": "ryan"},
                "body": {"S": channel_id},
                "addressed_to_bot_id": {"S": "researcher"},
                "created_at": {"S": "2026-09-10T00:00:00+00:00"},
            },
        )

    _merge_duplicate_direct_channels(client, table_name, channels, "canonical")

    canonical = client.get_item(
        TableName=table_name,
        Key={
            "pk": {"S": "anthus#channel#canonical"},
            "sk": {"S": "meta"},
        },
    )["Item"]
    messages = client.query(
        TableName=table_name,
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={
            ":pk": {"S": "anthus#channel#canonical"},
            ":prefix": {"S": "msg#"},
        },
    )["Items"]
    assert canonical["kind"]["S"] == "direct"
    assert canonical["next_seq"]["N"] == "3"
    assert [item["body"]["S"] for item in messages] == ["canonical", "source"]
    assert not client.get_item(
        TableName=table_name,
        Key={"pk": {"S": "anthus#channel#source"}, "sk": {"S": "meta"}},
    ).get("Item")
