import dashjs from "dashjs";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { socket } from "../lib/socket";

type RemotePlayerState = {
  currentTime: number;
  isPlaying: boolean;
  sentAt: number;
  serverReceivedAt?: number;
};

type DashPlayerProps = {
  manifestUrl: string;
  roomId: string;
  onSyncDelay?: (delayMs: number) => void;
};

const SEEK_TOLERANCE_SECONDS = 0.75;

export function DashPlayer({ manifestUrl, roomId, onSyncDelay }: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const applyingRemoteState = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playerMessage, setPlayerMessage] = useState("Loading manifest");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setPlayerMessage("Loading manifest");
    const player = dashjs.MediaPlayer().create();
    player.initialize(video, manifestUrl, false);

    return () => {
      player.reset();
    };
  }, [manifestUrl]);

  useEffect(() => {
    if (!socket.connected) socket.connect();
    socket.emit("room:join", roomId);

    const applyRemoteState = async (state: RemotePlayerState) => {
      const video = videoRef.current;
      if (!video) return;

      applyingRemoteState.current = true;
      const drift = Math.abs(video.currentTime - state.currentTime);
      if (drift > SEEK_TOLERANCE_SECONDS) {
        video.currentTime = state.currentTime;
      }

      if (state.isPlaying && video.paused) {
        await video.play().catch(() => setPlayerMessage("Click Play to allow playback"));
      }

      if (!state.isPlaying && !video.paused) {
        video.pause();
      }

      onSyncDelay?.(Date.now() - state.sentAt);
      window.setTimeout(() => {
        applyingRemoteState.current = false;
      }, 150);
    };

    socket.on("player:state", applyRemoteState);

    return () => {
      socket.off("player:state", applyRemoteState);
    };
  }, [onSyncDelay, roomId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const publishState = () => {
      setIsPlaying(!video.paused);
      if (applyingRemoteState.current) return;
      socket.emit("player:state", {
        roomId,
        currentTime: video.currentTime,
        isPlaying: !video.paused,
        sentAt: Date.now()
      });
    };

    const updateMetadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : null);
      setPlayerMessage("Ready to play");
    };

    const showWaiting = () => setPlayerMessage("Buffering");
    const showPlaying = () => setPlayerMessage("Playing");
    const showError = () => setPlayerMessage("Video failed to load. Check the Manifest URL.");

    video.addEventListener("loadedmetadata", updateMetadata);
    video.addEventListener("canplay", updateMetadata);
    video.addEventListener("playing", showPlaying);
    video.addEventListener("waiting", showWaiting);
    video.addEventListener("error", showError);
    video.addEventListener("play", publishState);
    video.addEventListener("pause", publishState);
    video.addEventListener("seeked", publishState);

    return () => {
      video.removeEventListener("loadedmetadata", updateMetadata);
      video.removeEventListener("canplay", updateMetadata);
      video.removeEventListener("playing", showPlaying);
      video.removeEventListener("waiting", showWaiting);
      video.removeEventListener("error", showError);
      video.removeEventListener("play", publishState);
      video.removeEventListener("pause", publishState);
      video.removeEventListener("seeked", publishState);
    };
  }, [roomId]);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      await video.play().catch(() => setPlayerMessage("Browser blocked playback. Click the video controls."));
      return;
    }

    video.pause();
  };

  return (
    <div className="bg-black">
      <video
        ref={videoRef}
        className="aspect-video w-full bg-black"
        controls
        crossOrigin="anonymous"
        playsInline
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200">
        <button
          className="inline-flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-medium text-zinc-100 hover:border-emerald-500"
          type="button"
          onClick={togglePlayback}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span>{playerMessage}</span>
        <span>{duration === null ? "Duration unavailable" : `${Math.round(duration)} seconds`}</span>
      </div>
    </div>
  );
}
