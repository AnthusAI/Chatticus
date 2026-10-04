"use client";

import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "./ui/button";
import { voiceAvailability } from "../lib/voice-control";
import { startVoiceSession, type VoiceSession } from "../lib/voice-session";
import {
  speak as speakAloud,
  stopSpeaking as stopSpeakingAloud,
  unlockSpeech,
} from "../lib/voice-speech";

type VoicePhase = "idle" | "loading" | "listening" | "unavailable" | "error";

const SPEECH_OVERLAP_MARGIN_MS = 500;

export interface UseVoiceControlOptions {
  keyterms: string[];
  /**
   * Handles a completed line and returns a short note about what happened to
   * it. ``overlapsSpeech`` is true when the line began while a reply was being
   * spoken, or just after, so it may be the browser hearing itself.
   */
  onLine: (text: string, line: { overlapsSpeech: boolean }) => Promise<string> | string;
}

export interface VoiceControl {
  listening: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  stop: () => Promise<void>;
  composerAction: ReactNode;
  composerStatus: ReactNode;
}

export function useVoiceControl({ keyterms, onLine }: UseVoiceControlOptions): VoiceControl {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [downloadFraction, setDownloadFraction] = useState(0);
  const [partial, setPartial] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const speechWindowRef = useRef<{ startedAt: number; endedAt: number | null } | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const onLineRef = useRef(onLine);
  const keytermsRef = useRef(keyterms);

  useEffect(() => {
    onLineRef.current = onLine;
  }, [onLine]);

  useEffect(() => {
    keytermsRef.current = keyterms;
    sessionRef.current?.setKeyterms(keyterms);
  }, [keyterms]);

  const generationRef = useRef(0);
  const lineQueueRef = useRef<Promise<void>>(Promise.resolve());

  const closeSession = useCallback(async () => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    setPartial("");
    await session?.stop();
  }, []);

  const endSpeechWindow = useCallback(() => {
    const speechWindow = speechWindowRef.current;
    if (speechWindow && speechWindow.endedAt === null) {
      speechWindow.endedAt = Date.now();
    }
    setSpeaking(false);
  }, []);

  const stopSpeaking = useCallback(() => {
    stopSpeakingAloud();
    endSpeechWindow();
  }, [endSpeechWindow]);

  const speak = useCallback(
    (text: string) => {
      const previousWindow = speechWindowRef.current;
      speechWindowRef.current = { startedAt: Date.now(), endedAt: null };
      setSpeaking(true);
      const started = speakAloud(text, {
        onStart: () => setSpeaking(true),
        onEnd: endSpeechWindow,
      });
      if (!started) {
        speechWindowRef.current = previousWindow;
        setSpeaking(false);
      }
    },
    [endSpeechWindow],
  );

  const lineOverlapsSpeech = useCallback((startedAtMs: number) => {
    const speechWindow = speechWindowRef.current;
    if (!speechWindow) {
      return false;
    }
    const endedAt = speechWindow.endedAt ?? Number.POSITIVE_INFINITY;
    return (
      startedAtMs >= speechWindow.startedAt - SPEECH_OVERLAP_MARGIN_MS &&
      startedAtMs <= endedAt + SPEECH_OVERLAP_MARGIN_MS
    );
  }, []);

  const stop = useCallback(async () => {
    setPhase((current) => (current === "listening" || current === "loading" ? "idle" : current));
    stopSpeaking();
    await closeSession();
  }, [closeSession, stopSpeaking]);

  const handleLine = useCallback((text: string, overlapsSpeech: boolean, generation: number) => {
    setPartial("");
    lineQueueRef.current = lineQueueRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (generation !== generationRef.current) {
              resolve();
              return;
            }
            void Promise.resolve(onLineRef.current(text, { overlapsSpeech }))
              .then((lineNote) => {
                if (lineNote) setNote(lineNote);
              })
              .catch((error: unknown) =>
                setNote(error instanceof Error ? error.message : "That line could not be handled."),
              )
              .finally(resolve);
          }, 0);
        }),
    );
  }, []);

  const start = useCallback(async () => {
    const availability = voiceAvailability({
      crossOriginIsolated: self.crossOriginIsolated,
      hasMicrophone: Boolean(navigator.mediaDevices?.getUserMedia),
    });
    if (!availability.available) {
      setPhase("unavailable");
      setNote(availability.reason);
      return;
    }
    await closeSession();
    const generation = generationRef.current;
    setPhase("loading");
    setNote(null);
    setDownloadFraction(0);
    try {
      const session = await startVoiceSession(
        {
          onPartial: (text) => {
            if (generation === generationRef.current) setPartial(text);
          },
          onProgress: (fraction) => setDownloadFraction(fraction),
          onError: (error) => {
            if (generation !== generationRef.current) return;
            setPhase("error");
            setNote(error.message);
            void closeSession();
          },
          onLine: (text, startedAtMs) => {
            if (generation === generationRef.current) {
              handleLine(text, lineOverlapsSpeech(startedAtMs), generation);
            }
          },
        },
        keytermsRef.current,
      );
      if (generation !== generationRef.current) {
        await session.stop();
        return;
      }
      sessionRef.current = session;
      setPhase("listening");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setPhase("error");
      setNote(error instanceof Error ? error.message : "Voice failed to start");
    }
  }, [closeSession, handleLine, lineOverlapsSpeech]);

  useEffect(
    () => () => {
      void closeSession();
    },
    [closeSession],
  );

  const listening = phase === "listening";
  const loading = phase === "loading";
  const composerAction = (
    <Button
      type="button"
      size="icon"
      variant={listening ? "default" : "ghost"}
      className="shrink-0 shadow-none"
      aria-label={listening ? "Stop listening" : "Start listening"}
      aria-pressed={listening}
      disabled={loading}
      onClick={() => {
        if (!listening) unlockSpeech();
        void (listening ? stop() : start());
      }}
    >
      {listening ? <Mic size={17} aria-hidden="true" /> : <MicOff size={17} aria-hidden="true" />}
    </Button>
  );

  let statusText: string | null = null;
  if (loading) {
    statusText =
      downloadFraction > 0 && downloadFraction < 1
        ? `Loading voice model: ${Math.round(downloadFraction * 100)}%`
        : "Loading voice model...";
  } else if (listening && speaking) {
    statusText = "Speaking. Say \"stop\" to interrupt.";
  } else if (listening) {
    statusText = partial ? `Hearing: ${partial}` : note ?? "Listening. Start with a teammate's name.";
  } else if (note) {
    statusText = note;
  }
  const composerStatus = statusText ? (
    <div
      role="status"
      aria-live="polite"
      className={
        phase === "error" || phase === "unavailable"
          ? "px-3 pb-2 text-xs text-clay"
          : "px-3 pb-2 text-xs text-surface-foreground/55"
      }
    >
      {statusText}
    </div>
  ) : null;

  return { listening, speaking, speak, stopSpeaking, stop, composerAction, composerStatus };
}
