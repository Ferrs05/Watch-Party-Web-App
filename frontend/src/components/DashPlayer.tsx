import dashjs from "dashjs";
import { useEffect, useRef } from "react";
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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
        await video.play().catch(() => undefined);
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
      if (applyingRemoteState.current) return;
      socket.emit("player:state", {
        roomId,
        currentTime: video.currentTime,
        isPlaying: !video.paused,
        sentAt: Date.now()
      });
    };

    video.addEventListener("play", publishState);
    video.addEventListener("pause", publishState);
    video.addEventListener("seeked", publishState);

    return () => {
      video.removeEventListener("play", publishState);
      video.removeEventListener("pause", publishState);
      video.removeEventListener("seeked", publishState);
    };
  }, [roomId]);

  return (
    <video
      ref={videoRef}
      className="aspect-video w-full bg-black"
      controls
      playsInline
    />
  );
}
