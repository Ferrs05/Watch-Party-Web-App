import dashjs from "dashjs";
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { socket } from "../lib/socket";

type RemotePlayerState = {
  clientId: string;
  currentTime: number;
  isPlaying: boolean;
  sentAt: number;
  serverReceivedAt?: number;
};

export type RoomState = {
  roomId: string;
  manifestUrl: string;
  videoId?: string;
  videoTitle?: string;
  currentTime: number;
  isPlaying: boolean;
  updatedAt: number;
  updatedBy?: string;
  hostClientId?: string;
  hostSocketId?: string;
  peerCount: number;
};

export type QoSMetrics = {
  startupDelayMs: number | null;
  bufferingRatio: number;
  bufferingEvents: number;
  averageBitrateKbps: number | null;
  syncDelayMs: number | null;
};

type DashPlayerProps = {
  clientId: string;
  manifestUrl: string;
  roomId: string;
  isHost: boolean;
  roleIntent: "host" | "viewer";
  videoId?: string;
  onMetrics?: (metrics: QoSMetrics) => void;
  onRoomState?: (state: RoomState) => void;
  onRoomManifest?: (manifestUrl: string) => void;
  onRoomMessage?: (message: string) => void;
  onSyncDelay?: (delayMs: number) => void;
};

const SEEK_TOLERANCE_SECONDS = 0.75;
const VIEWER_CATCHUP_TOLERANCE_SECONDS = 1.25;
const HOST_HEARTBEAT_MS = 1500;
const METRICS_INTERVAL_MS = 1000;

const emptyMetrics: QoSMetrics = {
  startupDelayMs: null,
  bufferingRatio: 0,
  bufferingEvents: 0,
  averageBitrateKbps: null,
  syncDelayMs: null
};

function projectedHostTime(state: RoomState | RemotePlayerState) {
  const receivedAt = "serverReceivedAt" in state ? state.serverReceivedAt : (state as RoomState).updatedAt;
  if (!state.isPlaying || !receivedAt) return state.currentTime;
  return state.currentTime + Math.max(Date.now() - receivedAt, 0) / 1000;
}

export function DashPlayer({
  clientId,
  manifestUrl,
  roomId,
  isHost,
  roleIntent,
  videoId,
  onMetrics,
  onRoomState,
  onRoomManifest,
  onRoomMessage,
  onSyncDelay
}: DashPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const applyingRemoteState = useRef(false);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const latestRoomState = useRef<RoomState | null>(null);
  const sessionStartedAt = useRef(Date.now());
  const playRequestedAt = useRef<number | null>(null);
  const startupDelayMs = useRef<number | null>(null);
  const bufferingStartedAt = useRef<number | null>(null);
  const totalBufferingMs = useRef(0);
  const bufferingEvents = useRef(0);
  const bitrateSamples = useRef<number[]>([]);
  const lastSyncDelayMs = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playerMessage, setPlayerMessage] = useState("Loading manifest");
  const [metrics, setMetrics] = useState<QoSMetrics>(emptyMetrics);

  const canControl = useMemo(() => isHost, [isHost]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setPlayerMessage("Loading manifest");
    setMetrics(emptyMetrics);
    setIsPlaying(false);
    sessionStartedAt.current = Date.now();
    playRequestedAt.current = null;
    startupDelayMs.current = null;
    bufferingStartedAt.current = null;
    totalBufferingMs.current = 0;
    bufferingEvents.current = 0;
    bitrateSamples.current = [];
    lastSyncDelayMs.current = null;

    const player = dashjs.MediaPlayer().create();
    playerRef.current = player;
    player.initialize(video, manifestUrl, false);

    return () => {
      player.reset();
      playerRef.current = null;
    };
  }, [manifestUrl]);

  const applyHostTimeline = async (state: RoomState | RemotePlayerState) => {
    const video = videoRef.current;
    if (!video || isHost) return;

    applyingRemoteState.current = true;
    const targetTime = projectedHostTime(state);
    const drift = video.currentTime - targetTime;
    if (Math.abs(drift) > VIEWER_CATCHUP_TOLERANCE_SECONDS) {
      video.currentTime = Math.max(targetTime, 0);
    }

    if (state.isPlaying && video.paused) {
      await video.play().catch(() => setPlayerMessage("Click the page once to allow synced playback"));
    }

    if (!state.isPlaying && !video.paused) {
      video.pause();
    }

    window.setTimeout(() => {
      applyingRemoteState.current = false;
    }, 150);
  };

  useEffect(() => {
    if (!socket.connected) socket.connect();
    socket.emit("room:join", { roomId, clientId, roleIntent, videoId, manifestUrl });

    const applyRoomState = async (state: RoomState) => {
      latestRoomState.current = state;
      onRoomState?.(state);
      if (state.manifestUrl && state.manifestUrl !== manifestUrl) {
        onRoomManifest?.(state.manifestUrl);
      }
      if (state.updatedBy !== clientId) {
        await applyHostTimeline(state);
      }
    };

    const applyRemoteState = async (state: RemotePlayerState) => {
      if (state.clientId === clientId) return;
      const delay = Date.now() - state.sentAt;
      lastSyncDelayMs.current = delay;
      onSyncDelay?.(delay);
      await applyHostTimeline(state);
    };

    const handleRoomError = (event: { message: string }) => {
      onRoomMessage?.(event.message);
      setPlayerMessage(event.message);
    };

    socket.on("room:state", applyRoomState);
    socket.on("player:state", applyRemoteState);
    socket.on("room:error", handleRoomError);

    return () => {
      socket.off("room:state", applyRoomState);
      socket.off("player:state", applyRemoteState);
      socket.off("room:error", handleRoomError);
    };
  }, [clientId, isHost, manifestUrl, onRoomManifest, onRoomMessage, onRoomState, onSyncDelay, roleIntent, roomId, videoId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const publishState = () => {
      setIsPlaying(!video.paused);
      if (applyingRemoteState.current || !canControl) return;
      socket.emit("player:state", {
        roomId,
        clientId,
        currentTime: video.currentTime,
        isPlaying: !video.paused,
        sentAt: Date.now()
      });
    };

    const updateMetadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : null);
      setPlayerMessage(isHost ? "Ready to host" : "Waiting for host sync");
    };

    const showWaiting = () => {
      if (bufferingStartedAt.current === null) {
        bufferingStartedAt.current = Date.now();
        bufferingEvents.current += 1;
      }
      setPlayerMessage("Buffering locally");
    };

    const showPlaying = () => {
      if (playRequestedAt.current !== null && startupDelayMs.current === null) {
        startupDelayMs.current = Date.now() - playRequestedAt.current;
      }

      if (bufferingStartedAt.current !== null) {
        totalBufferingMs.current += Date.now() - bufferingStartedAt.current;
        bufferingStartedAt.current = null;
      }

      setPlayerMessage(isHost ? "Hosting live" : "Following host");
    };

    const showError = () => setPlayerMessage("Video failed to load. Check the Manifest URL or encoding.");

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
  }, [canControl, clientId, isHost, roomId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !canControl || video.paused) return;
      socket.emit("player:state", {
        roomId,
        clientId,
        currentTime: video.currentTime,
        isPlaying: true,
        sentAt: Date.now()
      });
    }, HOST_HEARTBEAT_MS);

    return () => window.clearInterval(interval);
  }, [canControl, clientId, roomId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isHost && latestRoomState.current) {
        void applyHostTimeline(latestRoomState.current);
      }
    }, HOST_HEARTBEAT_MS);

    return () => window.clearInterval(interval);
  }, [isHost]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const player = playerRef.current as unknown as {
        getQualityFor?: (type: string) => number;
        getBitrateInfoListFor?: (type: string) => Array<{ bitrate: number }>;
      } | null;

      const quality = player?.getQualityFor?.("video");
      const bitrates = player?.getBitrateInfoListFor?.("video") ?? [];
      const bitrate = typeof quality === "number" ? bitrates[quality]?.bitrate : undefined;
      if (bitrate) bitrateSamples.current.push(Math.round(bitrate / 1000));

      const elapsedMs = Math.max(Date.now() - sessionStartedAt.current, 1);
      const currentBufferingMs = bufferingStartedAt.current === null ? 0 : Date.now() - bufferingStartedAt.current;
      const totalMs = totalBufferingMs.current + currentBufferingMs;
      const samples = bitrateSamples.current;
      const nextMetrics: QoSMetrics = {
        startupDelayMs: startupDelayMs.current,
        bufferingRatio: Number((totalMs / elapsedMs).toFixed(4)),
        bufferingEvents: bufferingEvents.current,
        averageBitrateKbps: samples.length
          ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
          : null,
        syncDelayMs: lastSyncDelayMs.current
      };

      setMetrics(nextMetrics);
      onMetrics?.(nextMetrics);
      if (socket.connected) {
        socket.emit("metrics:sample", {
          roomId,
          clientId,
          ...nextMetrics,
          sentAt: Date.now()
        });
      }
    }, METRICS_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [clientId, onMetrics, roomId]);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (!canControl) {
      playRequestedAt.current = Date.now();
      if (latestRoomState.current) {
        await applyHostTimeline(latestRoomState.current);
        if (!latestRoomState.current.isPlaying) {
          video.pause();
          setPlayerMessage("Ready to follow host");
          return;
        }
      }
      await video.play().catch(() => setPlayerMessage("Click once to allow synced playback."));
      return;
    }

    if (video.paused) {
      playRequestedAt.current = Date.now();
      await video.play().catch(() => setPlayerMessage("Browser blocked playback. Click the video controls."));
      return;
    }

    video.pause();
  };

  return (
    <section className="watch-stage" aria-label="Watch party player">
      <video
        ref={videoRef}
        className="watch-video"
        controls={canControl}
        crossOrigin="anonymous"
        playsInline
      />
      <div className="watch-controls">
        <button
          className="play-button"
          type="button"
          onClick={togglePlayback}
          title={canControl ? "Control playback" : "Enable synced playback on this device"}
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          {isHost ? (isPlaying ? "Pause room" : "Play room") : "Follow host"}
        </button>
        <div className="player-status">
          <span>{playerMessage}</span>
          <span>{duration === null ? "Preparing video" : `${Math.round(duration / 60)} min`}</span>
        </div>
      </div>
    </section>
  );
}




