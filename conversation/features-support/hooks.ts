import { After, Before } from "@cucumber/cucumber";
import type { ChatticusWorld } from "./world.ts";

Before(async function (this: ChatticusWorld) {
	await this.messagingTable.create();
});

After(async function (this: ChatticusWorld) {
	await this.messagingTable.drop();
	this.messagingTable.client.destroy();
});
