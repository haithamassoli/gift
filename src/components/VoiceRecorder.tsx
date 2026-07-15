import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n";
import { VOICE_MAX_SECONDS } from "../gifts/catalog";

type RecState = "idle" | "recording" | "recorded";

const buttonBase =
  "inline-flex min-h-[48px] items-center justify-center rounded-full px-6 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400";
const outlineButton = `${buttonBase} border border-white/15 text-stone-300 hover:border-white/30`;

export function VoiceRecorder({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const { t } = useLang();
  const [state, setState] = useState<RecState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [denied, setDenied] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef = useRef<string | null>(null);

  const clearTimers = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (autoStopRef.current !== null) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const setUrl = (next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setAudioUrl(next);
  };

  // Clean up the mic, timers, and object URL if we unmount mid-recording.
  useEffect(() => {
    return () => {
      clearTimers();
      stopTracks();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  // Feature detection — render nothing where recording is unsupported.
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return null;
  }

  const stop = () => {
    clearTimers();
    recorderRef.current?.stop();
  };

  const start = async () => {
    setDenied(false);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setDenied(true);
      return;
    }
    streamRef.current = stream;

    // ponytail: webm recordings don't play on iOS < 17.4 recipients; transcode
    // server-side if that support matrix ever matters.
    const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "audio/webm;codecs=opus";
    mimeRef.current = mimeType;

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stopTracks();
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      setUrl(URL.createObjectURL(blob));
      setState("recorded");
      onChange(blob);
    });

    recorder.start();
    setElapsed(0);
    setState("recording");
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    autoStopRef.current = setTimeout(stop, VOICE_MAX_SECONDS * 1000);
  };

  const rerecord = () => {
    setUrl(null);
    onChange(null);
    setState("idle");
  };

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-stone-300">
        {t.create.voiceLabel}
      </span>

      {state === "idle" && (
        <div>
          <button type="button" onClick={start} className={outlineButton}>
            {t.create.record}
          </button>
          {denied && (
            <p className="mt-2 text-sm text-stone-400">{t.create.micDenied}</p>
          )}
        </div>
      )}

      {state === "recording" && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={stop}
            className={`${buttonBase} bg-rose-500 text-white hover:bg-rose-400`}
          >
            {t.create.stop}
          </button>
          <span className="text-sm tabular-nums text-stone-400">
            {elapsed}s / {VOICE_MAX_SECONDS}s
          </span>
        </div>
      )}

      {state === "recorded" && audioUrl && (
        <div className="flex flex-col gap-3">
          <audio controls src={audioUrl} className="w-full" />
          <button type="button" onClick={rerecord} className={outlineButton}>
            {t.create.rerecord}
          </button>
        </div>
      )}
    </div>
  );
}
