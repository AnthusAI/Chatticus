"""DynamoMessagingStore query pagination for list APIs backed by DynamoDB Query."""

from chatticus.messaging.store import DynamoMessagingStore
from chatticus.models import ActorKind


def _message_item(seq: int) -> dict[str, object]:
    return {
        "sk": {"S": f"msg#{seq:010d}"},
        "tenant_id": {"S": "anthus"},
        "channel_id": {"S": "channel-1"},
        "message_id": {"S": f"msg-{seq}"},
        "seq": {"N": str(seq)},
        "author_kind": {"S": ActorKind.HUMAN},
        "author_id": {"S": "ryan"},
        "body": {"S": f"body-{seq}"},
        "addressed_to_bot_id": {"S": ""},
        "created_at": {"S": "2026-01-01T00:00:00+00:00"},
    }


def test_list_messages_reads_every_query_page() -> None:
    class PaginatedClient:
        def __init__(self) -> None:
            self.calls = 0

        def query(self, **request: object) -> dict[str, object]:
            self.calls += 1
            if self.calls == 1:
                assert "ExclusiveStartKey" not in request
                return {
                    "Items": [_message_item(2)],
                    "LastEvaluatedKey": {"pk": {"S": "next"}},
                }
            assert request["ExclusiveStartKey"] == {"pk": {"S": "next"}}
            return {"Items": [_message_item(1)]}

    store = DynamoMessagingStore("table", client=PaginatedClient())
    messages = store.list_messages("anthus", "channel-1")

    assert store.client.calls == 2
    assert [message.seq for message in messages] == [1, 2]


def test_list_messages_honors_after_seq_on_first_page_only() -> None:
    class RecordingClient:
        def query(self, **request: object) -> dict[str, object]:
            values = request["ExpressionAttributeValues"]
            assert values[":sk"] == {"S": "msg#0000000005"}
            return {"Items": [_message_item(6)]}

    store = DynamoMessagingStore("table", client=RecordingClient())
    messages = store.list_messages("anthus", "channel-1", after_seq=5)

    assert [message.seq for message in messages] == [6]
