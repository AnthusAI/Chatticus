import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LISTENING_CUE, voiceLoadingStatus } from "./voice-control";
import { runVoiceStart, voiceStartResolution } from "./voice-start";

function recordingStart(options: { failure?: Error; turnedOffDuringStart?: boolean }) {
  const events: string[] = [];
  let superseded = false;
  const finished = runVoiceStart({
    openSession: async (onStage) => {
      onStage("requestingMicrophone");
      if (options.failure) throw options.failure;
      superseded = options.turnedOffDuringStart ?? false;
      return { stop: async () => void events.push("stopped") };
    },
    isSuperseded: () => superseded,
    keepSession: () => void events.push("kept"),
    setPhase: (phase) => void events.push(`phase ${phase}`),
    setStage: (stage) => void events.push(`stage ${stage}`),
    setNote: (note) => void events.push(`note ${note}`),
    speak: (text) => void events.push(`speak ${text}`),
  });
  return { events, finished };
}

describe("voiceStartResolution", () => {
  it("says listening with the cue when the start succeeded and is still wanted", () => {
    assert.deepEqual(voiceStartResolution({ superseded: false, failure: null }), {
      kind: "listening",
      cue: LISTENING_CUE,
    });
  });

  it("discards a superseded start, success or failure", () => {
    assert.deepEqual(voiceStartResolution({ superseded: true, failure: null }), { kind: "discard" });
    assert.deepEqual(
      voiceStartResolution({ superseded: true, failure: { error: new Error("no") } }),
      { kind: "discard" },
    );
  });

  it("reports the failure message, or a default for a non-error", () => {
    assert.deepEqual(
      voiceStartResolution({ superseded: false, failure: { error: new Error("denied") } }),
      { kind: "failed", note: "denied" },
    );
    assert.deepEqual(voiceStartResolution({ superseded: false, failure: { error: "x" } }), {
      kind: "failed",
      note: "Voice failed to start",
    });
  });
});

describe("runVoiceStart", () => {
  it("speaks the cue last, after the session is kept and the phase is listening", async () => {
    const { events, finished } = recordingStart({});
    await finished;
    assert.deepEqual(events.slice(-3), ["kept", "phase listening", "speak Listening."]);
  });

  it("never speaks when the start fails", async () => {
    const { events, finished } = recordingStart({ failure: new Error("denied") });
    await finished;
    assert.ok(!events.some((event) => event.startsWith("speak")));
    assert.ok(events.includes("phase error"));
  });

  it("never speaks, and closes the session, when the start was superseded", async () => {
    const { events, finished } = recordingStart({ turnedOffDuringStart: true });
    await finished;
    assert.ok(!events.some((event) => event.startsWith("speak")));
    assert.ok(events.includes("stopped"));
    assert.ok(!events.includes("kept"));
  });
});

describe("voiceLoadingStatus", () => {
  it("shows model progress while the model loads", () => {
    assert.equal(voiceLoadingStatus("loadingModel", 0), "Loading voice model...");
    assert.equal(voiceLoadingStatus("loadingModel", 0.4), "Loading voice model: 40%");
    assert.equal(voiceLoadingStatus("loadingModel", 1), "Loading voice model...");
  });

  it("asks for microphone permission while the browser is being asked", () => {
    assert.equal(voiceLoadingStatus("requestingMicrophone", 1), "Waiting for microphone permission...");
  });
});
