"use client";

import { AudioLines } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "./ui/button";
import {
  captureRestoreNote,
  lineOverlapsSpeechWindow,
  phaseAfterSessionEvent,
  voiceAvailability,
  voiceButtonPresentation,
  type SpeechWindow,
  type VoicePhase,
} from "../lib/voice-control";
import { startVoiceSession, type VoiceSession } from "../lib/voice-session";
import {
  isSpeechEngineBusy,
  lineMayBeOwnSpeech,
  speak as speakAloud,
  speakingStateIsStuck,
  speechEndNote,
  speechDeadlineMs,
  stopSpeaking as stopSpeakingAloud,
} from "../lib/voice-speech";

export interface UseVoiceControlOptions {
  keyterms: string[];
  /**
   * Handles a completed line and returns a short note about what happened to
   * it. ``overlapsSpeech`` is true when the line began while a reply was being
   * spoken, or just after, so it may be the browser hearing itself.
   */
  onLine: (text: string, line: { overlapsSpeech: boolean }) => Promise<string> | string;
  /** Called when listening is turned off, by any path, so unsent work can be dropped and said so. */
  onStopped?: () => void;
}

export interface VoiceControl {
  listening: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  stopSpeaking: (reason?: string) => void;
  stop: () => Promise<void>;
  showNote: (note: string) => void;
  composerAction: ReactNode;
  composerStatus: ReactNode;
}

export function useVoiceControl({
  keyterms,
  onLine,
  onStopped,
}: UseVoiceControlOptions): VoiceControl {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [downloadFraction, setDownloadFraction] = useState(0);
  const [partial, setPartial] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const speechWindowRef = useRef<SpeechWindow | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const speakingRef = useRef(false);
  const onLineRef = useRef(onLine);
  const onStoppedRef = useRef(onStopped);
  const keytermsRef = useRef(keyterms);

  useEffect(() => {
    onLineRef.current = onLine;
    onStoppedRef.current = onStopped;
  }, [onLine, onStopped]);

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

  const endSpeechWindow = useCallback((reason: string) => {
    const speechWindow = speechWindowRef.current;
    const wasSpeaking = Boolean(speechWindow && speechWindow.endedAt === null);
    if (speechWindow && speechWindow.endedAt === null) {
      speechWindow.endedAt = Date.now();
    }
    speakingRef.current = false;
    setSpeaking(false);
    sessionRef.current?.speechEnded();
    const endNote = wasSpeaking ? speechEndNote(reason) : null;
    if (endNote) setNote(endNote);
  }, []);

  const stopSpeaking = useCallback(
    (reason: string = "stopped with the button") => {
      stopSpeakingAloud();
      endSpeechWindow(reason);
    },
    [endSpeechWindow],
  );

  const speak = useCallback(
    (text: string) => {
      const previousWindow = speechWindowRef.current;
      const startedAt = Date.now();
      speechWindowRef.current = {
        startedAt,
        endedAt: null,
        expectedEndedAt: startedAt + speechDeadlineMs(text),
      };
      speakingRef.current = true;
      setSpeaking(true);
      const started = speakAloud(text, {
        onStart: () => {
          speakingRef.current = true;
          setSpeaking(true);
        },
        onEnd: endSpeechWindow,
        onReplaced: () => setNote(speechEndNote("replaced by newer speech")),
        onError: (error) => setNote(`Speech failed: ${error}`),
      });
      if (!started) {
        speechWindowRef.current = previousWindow;
        speakingRef.current = false;
        setSpeaking(false);
        sessionRef.current?.speechEnded();
        setNote("This browser cannot speak replies.");
      }
    },
    [endSpeechWindow],
  );

  const endSpeechIfStuck = useCallback((): boolean => {
    const speechWindow = speechWindowRef.current;
    const stuck =
      speakingRef.current &&
      speechWindow !== null &&
      speakingStateIsStuck({
        speakingFlag: true,
        millisecondsPastExpectedEnd: Date.now() - speechWindow.expectedEndedAt,
        engineBusy: isSpeechEngineBusy(),
      });
    if (stuck) {
      stopSpeakingAloud();
      endSpeechWindow("the speaking state was stuck");
    }
    return stuck;
  }, [endSpeechWindow]);

  const lineOverlapsSpeech = useCallback(
    (startedAtMs: number) =>
      lineMayBeOwnSpeech({
        overlapsSpeechWindow: lineOverlapsSpeechWindow(speechWindowRef.current, startedAtMs),
        speakingFlag: speakingRef.current,
        speakingStateStuck: endSpeechIfStuck(),
      }),
    [endSpeechIfStuck],
  );

  useEffect(() => {
    if (!speaking) return;
    const timer = window.setInterval(endSpeechIfStuck, 500);
    return () => window.clearInterval(timer);
  }, [speaking, endSpeechIfStuck]);

  const stop = useCallback(async () => {
    setPhase((current) => (current === "listening" || current === "loading" ? "idle" : current));
    stopSpeaking("the voice conversation was turned off");
    onStoppedRef.current?.();
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
          onRecognizerTrouble: (error) => {
            if (generation !== generationRef.current) return;
            setNote(
              phaseAfterSessionEvent("listening", {
                kind: "recognizerTrouble",
                message: error.message,
              }).note,
            );
          },
          onCaptureRestored: (outcome) => {
            if (generation !== generationRef.current) return;
            setPhase(outcome.kind === "needsTap" ? "needsTap" : "listening");
            setNote(captureRestoreNote(outcome));
          },
          onLine: (text, startedAtMs) => {
            if (generation === generationRef.current) {
              handleLine(text, lineOverlapsSpeech(startedAtMs), generation);
            }
          },
        },
        keytermsRef.current,
        () => speakingRef.current,
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
  const presentation = voiceButtonPresentation(phase, speaking);
  const lookClassName = {
    neutral: "",
    active: "bg-cobalt text-white hover:bg-cobalt/90",
    alert: "text-clay ring-2 ring-clay",
  }[presentation.look];
  const composerAction = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={`shrink-0 shadow-none ${lookClassName}`}
      aria-label={presentation.label}
      title={presentation.label}
      aria-pressed={presentation.pressed}
      disabled={presentation.disabled}
      onClick={() => {
        if (phase === "needsTap") {
          void sessionRef.current?.restoreCapture().then((outcome) => {
            setPhase(outcome.kind === "needsTap" ? "needsTap" : "listening");
            setNote(captureRestoreNote(outcome));
          });
          return;
        }
        if (!listening) speak("Listening.");
        void (listening ? stop() : start());
      }}
    >
      <AudioLines
        size={17}
        aria-hidden="true"
        className={presentation.pulsing ? "animate-pulse" : undefined}
      />
    </Button>
  );

  let statusText: string | null = null;
  if (loading) {
    statusText =
      downloadFraction > 0 && downloadFraction < 1
        ? `Loading voice model: ${Math.round(downloadFraction * 100)}%`
        : "Loading voice model...";
  } else if (listening && speaking) {
    statusText = 'Speaking. Say "stop" to interrupt.';
  } else if (listening) {
    statusText = partial
      ? `Hearing: ${partial}`
      : (note ?? "Voice conversation on. Talk to your teammate.");
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

  return {
    listening,
    speaking,
    speak,
    stopSpeaking,
    stop,
    showNote: setNote,
    composerAction,
    composerStatus,
  };
}
