#!/usr/bin/env node

/**
 * Human-facing thin-turn conversation over the live Front Door HTTP surface.
 *
 * POST one message and watch turn-scoped SSE on the thin-turn front door.
 */

async function main(): Promise<void> {
	console.log("chat.ts CLI not yet implemented");
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
