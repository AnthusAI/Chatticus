import { After, Before } from "@cucumber/cucumber";
import type { ChatticusWorld } from "./world.ts";

Before(async function (this: ChatticusWorld) {
	await this.messagingTable.create();
});

After(async function (this: ChatticusWorld) {
	await this.messagingTable.drop();
	this.messagingTable.client.destroy();

	// Close demo client HTTP server if it was created
	const demoCtx = this.demoContext as Record<string, unknown> | undefined;
	if (demoCtx?.server) {
		const server = demoCtx.server as { close: (callback?: () => void) => void };
		await new Promise<void>((resolve) => {
			server.close(resolve);
		});
	}
});
