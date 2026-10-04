import { LiveDoc } from "@earendil-works/pi-durable";
import { context, openOwner } from "../src/owner.ts";

type ChildOptions = {
	readonly storageId: string;
	readonly fence: number;
	readonly name: string;
	readonly content: string;
	readonly requestId: string;
	readonly replay?: "safe" | "unsafe";
	readonly toolDelayMs?: number;
};

const options = JSON.parse(process.env.PI_SPIKE_CHILD ?? "{}") as ChildOptions;
const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

const owner = await openOwner({
	storageId: options.storageId,
	fence: options.fence,
	name: options.name,
	capability: "computer",
	replay: options.replay,
	toolDelayMs: options.toolDelayMs,
});
const watch = (await owner.harness.watchDoc(LiveDoc, owner.root.id, context))!;
watch.start(async (value) => {
	const message = value?.generation?.message;
	const textLength = (message?.content ?? []).reduce(
		(sum: number, part: { type: string; text?: string }) => sum + (part.type === "text" ? (part.text?.length ?? 0) : 0),
		0,
	);
	if (textLength > 0) say({ event: "partial", textLength });
});
const submission = await owner.root.submit(
	{ type: "input", content: options.content, requestId: options.requestId },
	context,
);
say({ event: "submitted", submissionId: submission.id });
const settled = await submission.wait(context);
say({ event: "settled", status: settled.status });
await owner.close();
