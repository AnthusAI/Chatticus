"""DynamoMessagingStore query pagination for list APIs backed by DynamoDB Query."""

from chatticus.messaging.store import DynamoMessagingStore
from chatticus.models import ActorKind, TurnEventKind


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


def _turn_event_item(seq: int) -> dict[str, object]:
    return {
        "sk": {"S": f"evt#{seq:010d}"},
        "tenant_id": {"S": "anthus"},
        "channel_id": {"S": "channel-1"},
        "turn_id": {"S": "turn-1"},
        "event_id": {"S": f"evt-{seq}"},
        "seq": {"N": str(seq)},
        "kind": {"S": TurnEventKind.TURN_TOKEN},
        "token": {"S": f"t{seq}"},
        "message_seq": {"N": "0"},
        "body": {"S": ""},
    }


def _chunk_item(seq: int) -> dict[str, object]:
    return {
        "sk": {"S": f"chunk#{seq:010d}"},
        "token": {"S": f"chunk-{seq}"},
    }


class PaginatedQueryClient:
    def __init__(
        self,
        *,
        first_page_items: list[dict[str, object]],
        second_page_items: list[dict[str, object]],
    ) -> None:
        self.calls = 0
        self._first_page_items = first_page_items
        self._second_page_items = second_page_items

    def query(self, **request: object) -> dict[str, object]:
        self.calls += 1
        if self.calls == 1:
            assert "ExclusiveStartKey" not in request
            return {
                "Items": self._first_page_items,
                "LastEvaluatedKey": {"pk": {"S": "next"}},
            }
        assert request["ExclusiveStartKey"] == {"pk": {"S": "next"}}
        return {"Items": self._second_page_items}


def test_list_messages_reads_every_query_page() -> None:
    client = PaginatedQueryClient(
        first_page_items=[_message_item(2)],
        second_page_items=[_message_item(1)],
    )
    store = DynamoMessagingStore("table", client=client)
    messages = store.list_messages("anthus", "channel-1")

    assert client.calls == 2
    assert [message.seq for message in messages] == [1, 2]


def test_list_messages_uses_after_seq_in_key_condition() -> None:
    class RecordingClient:
        def query(self, **request: object) -> dict[str, object]:
            values = request["ExpressionAttributeValues"]
            assert values[":sk"] == {"S": "msg#0000000005"}
            return {"Items": [_message_item(6)]}

    store = DynamoMessagingStore("table", client=RecordingClient())
    messages = store.list_messages("anthus", "channel-1", after_seq=5)

    assert [message.seq for message in messages] == [6]


def test_list_turn_events_reads_every_query_page() -> None:
    client = PaginatedQueryClient(
        first_page_items=[_turn_event_item(2)],
        second_page_items=[_turn_event_item(1)],
    )
    store = DynamoMessagingStore("table", client=client)
    events = store.list_turn_events("anthus", "turn-1")

    assert client.calls == 2
    assert [event.seq for event in events] == [1, 2]


def test_list_turn_chunks_reads_every_query_page() -> None:
    client = PaginatedQueryClient(
        first_page_items=[_chunk_item(2)],
        second_page_items=[_chunk_item(1)],
    )
    store = DynamoMessagingStore("table", client=client)
    chunks = store.list_turn_chunks("anthus", "turn-1")

    assert client.calls == 2
    assert chunks == ["chunk-1", "chunk-2"]
