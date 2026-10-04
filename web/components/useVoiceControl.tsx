"use client";

import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "./ui/button";
import { voiceAvailability } from "../lib/voice-control";
import { startVoiceSession, type VoiceSession } from "../lib/voice-session";

type VoicePhase = "idle" | "loading" | "listening" | "unavailable" | "error";

export interface UseVoiceControlOptions {
  keyterms: string[];
  /** Handles a completed line and returns a short note about what happened to it. */
  onLine: (text: string) => Promise<string> | string;
}

export interface VoiceControl {
  listening: boolean;
  stop: () => Promise<void>;
  composerAction: ReactNode;
  composerStatus: ReactNode;
}

export function useVoiceControl({ keyterms, onLine }: UseVoiceControlOptions): VoiceControl {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [downloadFraction, setDownloadFraction] = useState(0);
  const [partial, setPartial] = useState("");
  const [note, setNote] = useState<string | null>(null);
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

  const stop = useCallback(async () => {
    setPhase((current) => (current === "listening" || current === "loading" ? "idle" : current));
    await closeSession();
  }, [closeSession]);

  const handleLine = useCallback((text: string, generation: number) => {
    setPartial("");
    lineQueueRef.current = lineQueueRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (generation !== generationRef.current) {
              resolve();
              return;
            }
            void Promise.resolve(onLineRef.current(text))
              .then((lineNote) => setNote(lineNote))
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
          onLine: (text) => {
            if (generation === generationRef.current) handleLine(text, generation);
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
  }, [closeSession, handleLine]);

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
      onClick={() => void (listening ? stop() : start())}
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

  return { listening, stop, composerAction, composerStatus };
}
