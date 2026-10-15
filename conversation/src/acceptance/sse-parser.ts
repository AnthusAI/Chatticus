/**
 * Parse turn SSE frames from the thin-turn front door.
 *
 * @param chunk - A chunk of the SSE stream
 * @param carry - The remaining buffer from the previous parse
 * @returns An object containing parsed frames and the remaining carry buffer
 */
export interface SseFrame {
	event: string;
	id: string | null;
	data: string;
}

export function parseSseFrames(chunk: string, carry: string): { frames: SseFrame[]; carry: string } {
	const frames: SseFrame[] = [];
	let buffer = carry + chunk;

	while (true) {
		const idx = buffer.indexOf("\n\n");
		if (idx === -1) {
			break;
		}

		const frame = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 2);

		let event = "";
		let id: string | null = null;
		let data = "";

		for (const line of frame.split("\n")) {
			if (line.startsWith(":")) {
				continue;
			}
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("id:")) {
				id = line.slice(3).trim();
			} else if (line.startsWith("data:")) {
				data = line.slice(5).trim();
			}
		}

		frames.push({
			event,
			id,
			data,
		});
	}

	return { frames, carry: buffer };
}
