import type { SpendUsage } from "../../src/ledger/vendor-ledger.ts";
import type { RecentLine, Understanding, UserUnderstanding } from "../../src/voice/understanding.ts";

/** The understand-the-user step with scripted meanings: it records what it was asked and what it was shown. */
export class ScriptedUserUnderstanding implements UserUnderstanding {
	readonly meanings = new Map<string, string>();
	readonly usages = new Map<string, SpendUsage>();
	readonly calls: Array<{ transcript: string; recent: RecentLine[] }> = [];
	unavailable = false;

	async understand(transcript: string, recent: readonly RecentLine[]): Promise<Understanding> {
		this.calls.push({ transcript, recent: [...recent] });
		if (this.unavailable) {
			throw new Error("model provider unavailable");
		}
		return {
			text: this.meanings.get(transcript) ?? transcript,
			usage: this.usages.get(transcript) ?? null,
			degraded: false,
			outcome: "rewritten",
		};
	}
}
