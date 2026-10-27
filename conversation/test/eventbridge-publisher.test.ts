import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { describe, expect, it } from "vitest";
import { channelMessageCreatedEvent } from "../src/channels/events.ts";
import { CHANNEL_EVENT_SOURCE, ChannelEventPublishError, EventBridgeChannelEventPublisher } from "../src/channels/eventbridge-publisher.ts";

const EVENT = channelMessageCreatedEvent({ tenantId: "anthus", messageId: "message-1", bindingId: "binding-1" });

function recordingClient(response: { FailedEntryCount?: number; Entries?: Array<{ ErrorCode?: string }> } = { FailedEntryCount: 0 }) {
	const commands: PutEventsCommand[] = [];
	return { commands, client: { send: async (command: PutEventsCommand) => (commands.push(command), response) } };
}

describe("the EventBridge channel event publisher", () => {
	it("puts one entry on the named bus with the source, the detail type and the ids as JSON", async () => {
		const { commands, client } = recordingClient();
		await new EventBridgeChannelEventPublisher(client, "default").publish(EVENT);
		expect(commands).toHaveLength(1);
		expect(commands[0]!.input.Entries).toEqual([
			{
				EventBusName: "default",
				Source: CHANNEL_EVENT_SOURCE,
				DetailType: "channel.message.created",
				Detail: JSON.stringify({ tenant_id: "anthus", message_id: "message-1", binding_id: "binding-1" }),
			},
		]);
	});

	it("fails with the reason code and no detail when the bus refuses the entry", async () => {
		const { client } = recordingClient({ FailedEntryCount: 1, Entries: [{ ErrorCode: "ThrottlingException" }] });
		const failure = await new EventBridgeChannelEventPublisher(client, "default").publish(EVENT).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ChannelEventPublishError);
		expect((failure as Error).message).toBe("The event bus default refused a channel.message.created event: ThrottlingException.");
		expect((failure as Error).message).not.toContain("anthus");
	});
});
