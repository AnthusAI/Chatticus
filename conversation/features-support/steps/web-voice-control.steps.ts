import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { runWebHarness } from "../web-harness-runner.ts";
import type { ChatticusWorld } from "../world.ts";

type Record_ = Record<string, any>;

interface VoiceScenario {
	bots: Record_[];
	channels: Record_[];
	selectedId: string | null;
	addressedBotId: string | null;
	busy: boolean;
	deliveryEvents: Record_[];
	deliveryResult: Record_ | null;
	sendOutcome: string;
	recovers: boolean;
	checkFails: boolean;
	speaking: boolean;
	listening: boolean;
	environment: Record_;
	outcome: Record_ | null;
	spoken: string | null;
	committed: Record_[];
	presentation: Record_ | null;
	sessionPhase: string | null;
	sessionChange: Record_ | null;
	spokenText: string;
	spokenEndedMs: number | null;
	lineStart: number | null;
	capture: Record_ | null;
	captureConditions: Record_ | null;
	speechRecovery: Record_ | null;
	watchdog: Record_ | null;
	stuckSpeech: Record_ | null;
	stuckResult: Record_ | null;
}

function voiceOf(world: ChatticusWorld): VoiceScenario {
	if (!world.webFeature.voice) {
		world.webFeature.voice = {
			bots: [],
			channels: [],
			selectedId: null,
			addressedBotId: null,
			busy: false,
			deliveryEvents: [],
			deliveryResult: null,
			sendOutcome: "sent",
			recovers: false,
			checkFails: false,
			speaking: false,
			listening: false,
			environment: { crossOriginIsolated: true, hasMicrophone: true },
			outcome: null,
			spoken: null,
			committed: [],
			presentation: null,
			sessionPhase: null,
			sessionChange: null,
			spokenText: "",
			spokenEndedMs: null,
			lineStart: null,
			capture: null,
			captureConditions: null,
			speechRecovery: null,
			watchdog: null,
			stuckSpeech: null,
			stuckResult: null,
		} satisfies VoiceScenario;
	}
	return world.webFeature.voice;
}

async function runVoiceHarness(world: ChatticusWorld, action: string, values: Record_ = {}): Promise<any> {
	const voice = voiceOf(world);
	const payload = {
		action,
		bots: voice.bots,
		channels: voice.channels,
		selectedId: voice.selectedId,
		addressedBotId: voice.addressedBotId,
		overlapsSpeech: voice.speaking,
		environment: voice.environment,
		...values,
	};
	return runWebHarness("voice-harness.ts", [JSON.stringify(payload)]);
}

function voiceBotOf(name: string): Record_ {
	return { bot_id: `bot-${name.toLowerCase()}`, tenant_id: "tenant-1", user_id: "user-1", name, memory: {} };
}

function voiceChannelOf(channelId: string, name: string | null, botIds: string[]): Record_ {
	return {
		channel_id: channelId,
		tenant_id: "tenant-1",
		user_id: "user-1",
		kind: name ? "named" : "direct",
		name,
		participants: [
			{ kind: "human", actor_id: "user-1" },
			...botIds.map((botId) => ({ kind: "bot", actor_id: botId })),
		],
		next_seq: 1,
	};
}

function botIdOf(voice: VoiceScenario, name: string): string {
	const bot = voice.bots.find((candidate) => candidate.name === name);
	assert.ok(bot, `No voice workspace teammate named ${name}`);
	return bot.bot_id;
}

function ensureDirectChannel(voice: VoiceScenario, name: string): string {
	const channelId = `channel-direct-${name.toLowerCase()}`;
	if (!voice.channels.some((channel) => channel.channel_id === channelId)) {
		voice.channels.push(voiceChannelOf(channelId, null, [botIdOf(voice, name)]));
	}
	return channelId;
}

function outcomeOf(voice: VoiceScenario): Record_ {
	assert.ok(voice.outcome, "The voice harness has not produced an outcome in this scenario.");
	return voice.outcome;
}

Given(
	"the voice workspace has teammates {string} and {string}",
	function (this: ChatticusWorld, first: string, second: string) {
		const voice = voiceOf(this);
		voice.bots = [voiceBotOf(first), voiceBotOf(second)];
		voice.channels = [];
		voice.selectedId = null;
		voice.busy = false;
		voice.deliveryEvents = [];
		voice.deliveryResult = null;
		voice.sendOutcome = "sent";
		voice.checkFails = false;
		voice.speaking = false;
		voice.listening = false;
	},
);

Given(
	"the named channel {string} with {string} and {string} is open",
	function (this: ChatticusWorld, name: string, first: string, second: string) {
		const voice = voiceOf(this);
		const channelId = `channel-${name.toLowerCase()}`;
		voice.channels.push(voiceChannelOf(channelId, name, [botIdOf(voice, first), botIdOf(voice, second)]));
		voice.selectedId = `channel:${channelId}`;
		voice.addressedBotId = botIdOf(voice, first);
	},
);

Given("the direct conversation with {string} is open", function (this: ChatticusWorld, name: string) {
	const voice = voiceOf(this);
	ensureDirectChannel(voice, name);
	voice.selectedId = `bot:${botIdOf(voice, name)}`;
	voice.addressedBotId = botIdOf(voice, name);
});

Given("{string} is chosen to answer in that channel", function (this: ChatticusWorld, name: string) {
	const voice = voiceOf(this);
	voice.addressedBotId = botIdOf(voice, name);
});

Given(
	"{string} is already working on a turn in the direct conversation",
	function (this: ChatticusWorld, name: string) {
		const voice = voiceOf(this);
		ensureDirectChannel(voice, name);
		voice.busy = true;
	},
);

Given("the page is not cross-origin isolated", function (this: ChatticusWorld) {
	voiceOf(this).environment = { crossOriginIsolated: false, hasMicrophone: true };
});

Given("the browser offers no microphone", function (this: ChatticusWorld) {
	voiceOf(this).environment = { crossOriginIsolated: true, hasMicrophone: false };
});

When("the member says {string}", async function (this: ChatticusWorld, line: string) {
	voiceOf(this).outcome = await runVoiceHarness(this, "hear", { line });
});

When("the member asks to start listening", async function (this: ChatticusWorld) {
	voiceOf(this).outcome = await runVoiceHarness(this, "availability");
});

Then("nothing leaves the browser", function (this: ChatticusWorld) {
	assert.equal(outcomeOf(voiceOf(this)).kind, "discard", JSON.stringify(voiceOf(this).outcome));
});

Then("listening stops", function (this: ChatticusWorld) {
	assert.deepEqual(outcomeOf(voiceOf(this)), { kind: "stopListening" });
});

Then("no message is sent", function (this: ChatticusWorld) {
	assert.notEqual(outcomeOf(voiceOf(this)).kind, "send", JSON.stringify(voiceOf(this).outcome));
});

Then("the member is told {string}", function (this: ChatticusWorld, notice: string) {
	const voice = voiceOf(this);
	if (voice.deliveryResult !== null) {
		const told = [...voice.deliveryResult.shown, ...voice.deliveryResult.notes];
		assert.ok(told.includes(notice), JSON.stringify(told));
		return;
	}
	if (voice.sessionChange !== null) {
		assert.equal(voice.sessionChange.note, notice, JSON.stringify(voice.sessionChange));
		return;
	}
	const outcome = outcomeOf(voice);
	assert.equal(outcome.kind, "notice", JSON.stringify(outcome));
	assert.equal(outcome.text, notice, JSON.stringify(outcome));
});

Then("listening is unavailable because {string}", function (this: ChatticusWorld, reason: string) {
	assert.deepEqual(outcomeOf(voiceOf(this)), { available: false, reason });
});

Given("voice listening is on", function (this: ChatticusWorld) {
	voiceOf(this).listening = true;
});

Given("voice listening is off", function (this: ChatticusWorld) {
	voiceOf(this).listening = false;
});

Given("a reply is being spoken", function (this: ChatticusWorld) {
	voiceOf(this).speaking = true;
});

Given("a line began while a reply was being spoken", function (this: ChatticusWorld) {
	voiceOf(this).speaking = true;
});

Given(
	"the member asked {string} {string} in a channel where {string} also answered {string}",
	function (this: ChatticusWorld, name: string, prompt: string, other: string, otherAnswer: string) {
		const voice = voiceOf(this);
		const messageOf = (seq: number, kind: string, author: string, body: string) => ({
			message_id: `message-${seq}`,
			channel_id: "channel-release",
			tenant_id: "tenant-1",
			seq,
			author_kind: kind,
			author_id: author,
			body,
			addressed_to_bot_id: null,
			created_at: "2026-10-04T18:00:00+00:00",
		});
		voice.committed = [
			messageOf(1, "human", "user-1", prompt),
			messageOf(2, "bot", botIdOf(voice, other), otherAnswer),
		];
		void name;
	},
);

async function announce(world: ChatticusWorld, outcome: Record_): Promise<void> {
	const voice = voiceOf(world);
	const result = await runVoiceHarness(world, "announceTurnEnd", { listening: voice.listening, ...outcome });
	voice.spoken = result.spoken;
}

When("{string} replies {string}", async function (this: ChatticusWorld, _name: string, body: string) {
	await announce(this, { body: body.replaceAll("\\n", "\n") });
});

When(
	"{string} replies with a reply of {int} sentences",
	async function (this: ChatticusWorld, _name: string, count: number) {
		const body = Array.from(
			{ length: count },
			(_, index) => `Sentence number ${index + 1} explains one more detail of the work.`,
		).join(" ");
		await announce(this, { body });
	},
);

When(
	"the turn for {string} fails with reason {string}",
	async function (this: ChatticusWorld, _name: string, reason: string) {
		await announce(this, { reason });
	},
);

Then("the browser says {string}", function (this: ChatticusWorld, text: string) {
	assert.equal(voiceOf(this).spoken, text);
});

Then("the browser says nothing", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).spoken, null);
});

Then("the browser says only the first sentences of the reply", function (this: ChatticusWorld) {
	const spoken = voiceOf(this).spoken;
	assert.ok(spoken !== null);
	assert.ok(spoken.startsWith("Sentence number 1 "), spoken);
	assert.ok(!spoken.includes("Sentence number 12"), spoken);
});

Then("the browser ends with {string}", function (this: ChatticusWorld, text: string) {
	const spoken = voiceOf(this).spoken;
	assert.ok(spoken !== null && spoken.endsWith(text), String(spoken));
});

Then("speaking stops", function (this: ChatticusWorld) {
	assert.deepEqual(outcomeOf(voiceOf(this)), { kind: "stopSpeaking" });
});

When(
	"the turn for {string} ends with Ada's answer {string}",
	async function (this: ChatticusWorld, name: string, answer: string) {
		const voice = voiceOf(this);
		const committed = [
			...voice.committed,
			{
				...voice.committed[voice.committed.length - 1],
				message_id: "message-3",
				seq: 3,
				author_id: botIdOf(voice, name),
				body: answer,
			},
		];
		const result = await runVoiceHarness(this, "announceEndedTurn", {
			listening: voice.listening,
			turn: { bot_id: botIdOf(voice, name), prompt_message_seq: 1 },
			committed,
		});
		voice.spoken = result.spoken;
	},
);

Then(
	"{string} is sent to {string} for understanding",
	function (this: ChatticusWorld, text: string, name: string) {
		const voice = voiceOf(this);
		const outcome = outcomeOf(voice);
		assert.equal(outcome.kind, "send", JSON.stringify(outcome));
		assert.equal(outcome.transcript, text, JSON.stringify(outcome));
		assert.equal(outcome.botId, botIdOf(voice, name), JSON.stringify(outcome));
	},
);

When(
	"the voice session is {string} and the browser is {string}",
	async function (this: ChatticusWorld, phase: string, speech: string) {
		voiceOf(this).presentation = await runVoiceHarness(this, "buttonPresentation", {
			phase,
			speaking: speech === "speaking",
		});
	},
);

function presentationOf(voice: VoiceScenario): Record_ {
	assert.ok(voice.presentation, "No voice button presentation has been produced in this scenario.");
	return voice.presentation;
}

Then(
	"the voice button shows the {string} icon labelled {string}",
	function (this: ChatticusWorld, icon: string, label: string) {
		const presentation = presentationOf(voiceOf(this));
		assert.equal(presentation.icon, icon, JSON.stringify(presentation));
		assert.equal(presentation.label, label, JSON.stringify(presentation));
	},
);

Then("the voice button looks {string}", function (this: ChatticusWorld, look: string) {
	assert.equal(presentationOf(voiceOf(this)).look, look, JSON.stringify(voiceOf(this).presentation));
});

Then("the voice button is {string}", function (this: ChatticusWorld, state: string) {
	const presentation = presentationOf(voiceOf(this));
	const actual = presentation.disabled ? "disabled" : presentation.pressed ? "pressed" : "not pressed";
	assert.equal(actual, state, JSON.stringify(presentation));
});

Given("the voice session is {string}", function (this: ChatticusWorld, phase: string) {
	const voice = voiceOf(this);
	if (voice.sessionChange !== null) {
		assert.equal(voice.sessionChange.phase, phase, JSON.stringify(voice.sessionChange));
		return;
	}
	voice.sessionPhase = phase;
});

When("the speech recognizer reports {string}", async function (this: ChatticusWorld, message: string) {
	const voice = voiceOf(this);
	voice.sessionChange = await runVoiceHarness(this, "sessionEvent", {
		phase: voice.sessionPhase,
		event: { kind: "recognizerTrouble", message },
	});
});

Given(
	"{string} replied {string}, which was spoken from 0 seconds to {int} seconds",
	function (this: ChatticusWorld, _name: string, body: string, end: number) {
		const voice = voiceOf(this);
		voice.spokenText = body;
		voice.spokenEndedMs = end * 1000;
	},
);

Given(
	"{string} replied {string}, which was spoken but never reported finishing",
	function (this: ChatticusWorld, _name: string, body: string) {
		const voice = voiceOf(this);
		voice.spokenText = body;
		voice.spokenEndedMs = null;
	},
);

When(
	"the member speaks {string} for {int} seconds, finishing {int} seconds in",
	async function (this: ChatticusWorld, line: string, duration: number, completed: number) {
		const voice = voiceOf(this);
		voice.outcome = await runVoiceHarness(this, "hearAfterSpeech", {
			line,
			spokenText: voice.spokenText,
			spokenAtMs: 0,
			spokenEndedAtMs: voice.spokenEndedMs,
			completedAtMs: completed * 1000,
			durationSeconds: duration,
			overlapsSpeech: false,
		});
	},
);

When(
	"a line lasting {int} seconds finishes {int} seconds in",
	async function (this: ChatticusWorld, duration: number, completed: number) {
		const result = await runVoiceHarness(this, "lineStart", {
			completedAtMs: completed * 1000,
			durationSeconds: duration,
		});
		voiceOf(this).lineStart = result.startedAtMs;
	},
);

Then("the line is placed {int} seconds in", function (this: ChatticusWorld, seconds: number) {
	assert.equal(voiceOf(this).lineStart, seconds * 1000);
});

Then("speaking does not stop", function (this: ChatticusWorld) {
	assert.notEqual(outcomeOf(voiceOf(this)).kind, "stopSpeaking", JSON.stringify(voiceOf(this).outcome));
});

When(
	"the capture engine {text}, the microphone is {text} and audio arrived {int} milliseconds ago",
	async function (this: ChatticusWorld, engine: string, track: string, milliseconds: number) {
		voiceOf(this).capture = await runVoiceHarness(this, "captureWatch", {
			engineState: engine === "is suspended" ? "suspended" : "running",
			trackMuted: track === "muted",
			trackEnded: track === "ended",
			millisecondsSinceFrame: milliseconds,
		});
	},
);

function captureOf(voice: VoiceScenario): Record_ {
	assert.ok(voice.capture, "No capture outcome has been produced in this scenario.");
	return voice.capture;
}

Then("capture is left alone", function (this: ChatticusWorld) {
	assert.equal(captureOf(voiceOf(this)).problem, null, JSON.stringify(voiceOf(this).capture));
});

Then("capture is restored because {string}", function (this: ChatticusWorld, reason: string) {
	assert.equal(captureOf(voiceOf(this)).problem, reason, JSON.stringify(voiceOf(this).capture));
});

function captureConditionsOf(conditions: string): { capture: Record_; rebuildsInLastMinute: number } {
	return {
		capture: {
			engineState: conditions.includes("muted") ? "running" : "suspended",
			trackMuted: conditions.includes("muted"),
			resumeWorks: conditions.includes("wakes on request") && !conditions.includes("does not wake"),
			rebuildNeedsGesture: conditions.includes("needs a tap"),
		},
		rebuildsInLastMinute: conditions.includes("3 restarts already") ? 3 : 0,
	};
}

async function restoreCaptureWith(world: ChatticusWorld, inGesture: boolean): Promise<void> {
	const voice = voiceOf(world);
	assert.ok(voice.captureConditions, "No capture conditions were given.");
	const { capture, rebuildsInLastMinute } = voice.captureConditions as ReturnType<typeof captureConditionsOf>;
	const outcome = await runVoiceHarness(world, inGesture ? "tapRestore" : "captureRestore", {
		capture,
		rebuildsInLastMinute,
		inGesture,
	});
	voice.capture = outcome;
	voice.presentation = outcome.button;
}

When("capture is restored and {text}", async function (this: ChatticusWorld, conditions: string) {
	voiceOf(this).captureConditions = captureConditionsOf(conditions);
	await restoreCaptureWith(this, false);
});

When("the member taps the voice button", async function (this: ChatticusWorld) {
	await restoreCaptureWith(this, true);
});

Then(
	"the microphone and audio context are opened and resumed before any await",
	function (this: ChatticusWorld) {
		assert.deepEqual(captureOf(voiceOf(this)).callsBeforeAnyAwait, ["getUserMedia", "AudioContext", "resume"]);
	},
);

When(
	"the capture engine is suspended while the reply plays and then the reply ends",
	async function (this: ChatticusWorld) {
		voiceOf(this).speechRecovery = await runVoiceHarness(this, "captureWatchSpeech", { engineState: "suspended" });
	},
);

When("audio stops arriving while the reply plays and then the reply ends", async function (this: ChatticusWorld) {
	voiceOf(this).speechRecovery = await runVoiceHarness(this, "captureWatchSpeech", {
		engineState: "running",
		millisecondsSinceFrame: 2000,
	});
});

Then("no resume or microphone request happens while the reply plays", function (this: ChatticusWorld) {
	assert.deepEqual(voiceOf(this).speechRecovery?.callsDuringSpeech, []);
});

Then("capture recovery runs once the reply ends", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).speechRecovery?.callsAfterSpeech.length, 1, JSON.stringify(voiceOf(this).speechRecovery));
});

Then("capture is {string} and the member is told {string}", function (this: ChatticusWorld, kind: string, note: string) {
	const outcome = captureOf(voiceOf(this));
	assert.equal(outcome.kind, kind, JSON.stringify(outcome));
	assert.equal(outcome.note, note, JSON.stringify(outcome));
});

When(
	"the speech engine reports {text} {int} milliseconds after speech was queued and {text}",
	async function (this: ChatticusWorld, engine: string, elapsed: number, progress: string) {
		voiceOf(this).watchdog = await runVoiceHarness(this, "watchdog", {
			engineBusy: engine === "busy",
			millisecondsSinceQueued: elapsed,
			started: progress === "speech had started",
		});
	},
);

Then("the watchdog leaves the speech running", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).watchdog?.ends, false, JSON.stringify(voiceOf(this).watchdog));
});

Then("the watchdog ends the speech", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).watchdog?.ends, true, JSON.stringify(voiceOf(this).watchdog));
});

When("speech ends because of {string}", async function (this: ChatticusWorld, reason: string) {
	const result = await runVoiceHarness(this, "speechEndNote", { reason });
	voiceOf(this).spoken = result.note;
});

async function deliver(world: ChatticusWorld, event: Record_): Promise<void> {
	const voice = voiceOf(world);
	voice.deliveryEvents.push(event);
	voice.deliveryResult = await runVoiceHarness(world, "deliver", {
		delivery: {
			busy: voice.busy,
			sendOutcome: voice.sendOutcome,
			recoversAfterFailure: voice.recovers,
			checkFails: voice.checkFails,
			replySpeaking: voice.speaking,
			events: voice.deliveryEvents,
		},
	});
	const spoken: string[] = deliveryOf(voice).spoken;
	voice.spoken = spoken.length > 0 ? spoken[spoken.length - 1] : null;
}

function deliveryOf(voice: VoiceScenario): Record_ {
	assert.ok(voice.deliveryResult, "No line delivery has run in this scenario.");
	return voice.deliveryResult;
}

Given("sending to the teammate keeps failing", function (this: ChatticusWorld) {
	voiceOf(this).sendOutcome = "failed";
});

Given("sending to the teammate fails", function (this: ChatticusWorld) {
	voiceOf(this).sendOutcome = "failed";
});

Given("sending to the teammate fails once and then recovers", function (this: ChatticusWorld) {
	const voice = voiceOf(this);
	voice.sendOutcome = "failed";
	voice.recovers = true;
});

When("the reply ends", async function (this: ChatticusWorld) {
	await deliver(this, { do: "replyEnds" });
});

When("{int} seconds go by in the voice session", async function (this: ChatticusWorld, seconds: number) {
	await deliver(this, { do: "advance", milliseconds: seconds * 1000 });
});

Then("the browser said {string} exactly once", function (this: ChatticusWorld, text: string) {
	const spoken: string[] = deliveryOf(voiceOf(this)).spoken;
	assert.equal(spoken.filter((item) => item === text).length, 1, JSON.stringify(spoken));
});

Then("the browser said {string} {int} times", function (this: ChatticusWorld, text: string, count: number) {
	const spoken: string[] = deliveryOf(voiceOf(this)).spoken;
	assert.equal(spoken.filter((item) => item === text).length, count, JSON.stringify(spoken));
});

Given("the server finds no message in what was heard", function (this: ChatticusWorld) {
	voiceOf(this).sendOutcome = "nothingToSend";
});

Given("the teammate's status cannot be checked", function (this: ChatticusWorld) {
	voiceOf(this).checkFails = true;
});

Given(
	"a reply is flagged as speaking although the speech engine has been idle for {int} milliseconds past its expected end",
	function (this: ChatticusWorld, milliseconds: number) {
		voiceOf(this).stuckSpeech = {
			speakingFlag: true,
			millisecondsPastExpectedEnd: milliseconds,
			engineBusy: false,
		};
	},
);

Given(
	"a reply is flagged as speaking and the speech engine is still producing it past its expected end",
	function (this: ChatticusWorld) {
		voiceOf(this).stuckSpeech = {
			speakingFlag: true,
			millisecondsPastExpectedEnd: 5000,
			engineBusy: true,
		};
	},
);

When("the member says {string} to the open conversation", async function (this: ChatticusWorld, line: string) {
	const voice = voiceOf(this);
	let overlapsSpeech = false;
	if (voice.stuckSpeech !== null) {
		voice.stuckResult = await runVoiceHarness(this, "stuckSpeech", voice.stuckSpeech);
		overlapsSpeech = (voice.stuckResult as Record_).overlapsSpeech;
	}
	await deliver(this, { do: "hear", line, overlapsSpeech });
});

When(
	"the member says {string} to the open conversation just after a reply ended",
	async function (this: ChatticusWorld, line: string) {
		await deliver(this, { do: "hear", line, overlapsSpeech: true });
	},
);

When("{string} finishes the turn", async function (this: ChatticusWorld, _name: string) {
	await deliver(this, { do: "endTurn" });
});

When("the member switches to another conversation", async function (this: ChatticusWorld) {
	await deliver(this, { do: "switchConversation" });
});

Then("nothing has been sent yet", function (this: ChatticusWorld) {
	assert.deepEqual(deliveryOf(voiceOf(this)).sent, [], JSON.stringify(voiceOf(this).deliveryResult));
});

Then("nothing is spoken aloud", function (this: ChatticusWorld) {
	assert.deepEqual(deliveryOf(voiceOf(this)).spoken, [], JSON.stringify(voiceOf(this).deliveryResult));
});

Then(
	"these messages were sent to {string} in order:",
	function (this: ChatticusWorld, _name: string, table: DataTable) {
		const expected = table.hashes().map((row) => row.message);
		assert.deepEqual(deliveryOf(voiceOf(this)).sent, expected);
	},
);

Then("the line is not mistaken for the browser hearing itself", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).stuckResult?.overlapsSpeech, false, JSON.stringify(voiceOf(this).stuckResult));
});

Then("the line is mistaken for the browser hearing itself", function (this: ChatticusWorld) {
	assert.equal(voiceOf(this).stuckResult?.overlapsSpeech, true, JSON.stringify(voiceOf(this).stuckResult));
});
