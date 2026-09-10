"""Pure classification tests for the one-pass channel migration."""

import json

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from chatticus.channel_migration import (
    LegacyChannelClassification,
    _merge_duplicate_direct_channels,
    _message_items,
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


def test_message_scan_reads_every_query_page() -> None:
    class PaginatedClient:
        def __init__(self) -> None:
            self.calls = 0

        def query(self, **request: object) -> dict[str, object]:
            self.calls += 1
            if self.calls == 1:
                assert "ExclusiveStartKey" not in request
                return {
                    "Items": [{"sk": {"S": "msg#0000000002"}}],
                    "LastEvaluatedKey": {"pk": {"S": "next"}},
                }
            assert request["ExclusiveStartKey"] == {"pk": {"S": "next"}}
            return {"Items": [{"sk": {"S": "msg#0000000001"}}]}

    client = PaginatedClient()
    channel = LegacyChannelClassification(
        tenant_id="anthus",
        channel_id="source",
        user_id="ryan",
        bot_ids=("researcher",),
        kind="direct",
    )

    items = _message_items(client, "table", channel)

    assert client.calls == 2
    assert [item["sk"]["S"] for item in items] == [
        "msg#0000000001",
        "msg#0000000002",
    ]


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


@mock_aws
def test_duplicate_direct_merge_rejects_an_active_source_turn() -> None:
    table_name = "active-channel-migration"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    channels = []
    for channel_id in ("canonical", "source"):
        item = _item(channel_id, ["researcher"])
        item.update(
            {
                "pk": {"S": f"anthus#channel#{channel_id}"},
                "sk": {"S": "meta"},
                "next_seq": {"N": "1"},
            }
        )
        client.put_item(TableName=table_name, Item=item)
        channels.append(classify_legacy_channel(item))
    client.put_item(
        TableName=table_name,
        Item={
            "pk": {"S": "anthus#channel#source"},
            "sk": {"S": "active_turn"},
            "turn_id": {"S": "turn-1"},
        },
    )

    with pytest.raises(ValueError, match="active turn"):
        _merge_duplicate_direct_channels(client, table_name, channels, "canonical")

    assert client.get_item(
        TableName=table_name,
        Key={"pk": {"S": "anthus#channel#source"}, "sk": {"S": "meta"}},
    ).get("Item")


@mock_aws
def test_duplicate_direct_merge_rechecks_active_turn_in_transaction() -> None:
    table_name = "racing-active-channel-migration"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    channels = []
    for channel_id in ("canonical", "source"):
        item = _item(channel_id, ["researcher"])
        item.update(
            {
                "pk": {"S": f"anthus#channel#{channel_id}"},
                "sk": {"S": "meta"},
                "next_seq": {"N": "1"},
            }
        )
        client.put_item(TableName=table_name, Item=item)
        channels.append(classify_legacy_channel(item))

    class RacingClient:
        def __getattr__(self, name: str) -> object:
            return getattr(client, name)

        def transact_write_items(self, **request: object) -> object:
            client.put_item(
                TableName=table_name,
                Item={
                    "pk": {"S": "anthus#channel#source"},
                    "sk": {"S": "active_turn"},
                    "turn_id": {"S": "turn-raced"},
                },
            )
            return client.transact_write_items(**request)

    with pytest.raises(ClientError, match="TransactionCanceledException"):
        _merge_duplicate_direct_channels(
            RacingClient(), table_name, channels, "canonical"
        )

    assert client.get_item(
        TableName=table_name,
        Key={"pk": {"S": "anthus#channel#source"}, "sk": {"S": "meta"}},
    ).get("Item")
    canonical = client.get_item(
        TableName=table_name,
        Key={"pk": {"S": "anthus#channel#canonical"}, "sk": {"S": "meta"}},
    )["Item"]
    assert canonical["next_seq"]["N"] == "1"
