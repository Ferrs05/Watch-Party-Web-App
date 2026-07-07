import { Activity, BarChart3, Clapperboard, Copy, Download, Eye, Film, LogIn, Plus, Settings, Star, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DashPlayer, type QoSMetrics, type RoomState } from "./components/DashPlayer";
import { socket } from "./lib/socket";

const defaultManifest = "http://localhost:4000/media/dash/stream.mpd";
const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

type RoleIntent = "host" | "viewer";
type SessionMode = "lobby" | "room";

type VideoCatalogItem = {
  id: string;
  title: string;
  manifestUrl: string;
  relativePath: string;
};

const initialMetrics: QoSMetrics = {
  startupDelayMs: null,
  bufferingRatio: 0,
  bufferingEvents: 0,
  averageBitrateKbps: null,
  syncDelayMs: null
};

function getClientId() {
  return crypto.randomUUID();
}

function createRoomName() {
  return `room-${Math.random().toString(36).slice(2, 7)}`;
}

export default function App() {
  const [clientId] = useState(getClientId);
  const [sessionMode, setSessionMode] = useState<SessionMode>("lobby");
  const [roleIntent, setRoleIntent] = useState<RoleIntent>("viewer");
  const [roomId, setRoomId] = useState(createRoomName);
  const [joinRoomId, setJoinRoomId] = useState("demo-room");
  const [manifestUrl, setManifestUrl] = useState(defaultManifest);
  const [selectedVideoId, setSelectedVideoId] = useState<string>("default");
  const [videos, setVideos] = useState<VideoCatalogItem[]>([]);
  const [metrics, setMetrics] = useState<QoSMetrics>(initialMetrics);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [syncDelay, setSyncDelay] = useState<number | null>(null);
  const [roomMessage, setRoomMessage] = useState("Choose a room action to begin.");
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const normalizedRoom = useMemo(() => roomId.trim() || "demo-room", [roomId]);
  const isHost = sessionMode === "room" && roomState?.hostClientId === clientId;
  const metricsJsonUrl = `${backendUrl}/rooms/${encodeURIComponent(normalizedRoom)}/metrics`;
  const metricsCsvUrl = `${backendUrl}/rooms/${encodeURIComponent(normalizedRoom)}/metrics.csv`;
  const activeVideo = videos.find((video) => video.manifestUrl === manifestUrl || video.id === roomState?.videoId);

  useEffect(() => {
    let cancelled = false;
    fetch(`${backendUrl}/videos`)
      .then((response) => response.json())
      .then((data: { videos: VideoCatalogItem[] }) => {
        if (cancelled) return;
        setVideos(data.videos);
        const firstVideo = data.videos[0];
        if (firstVideo) {
          setSelectedVideoId(firstVideo.id);
          setManifestUrl(firstVideo.manifestUrl);
        }
      })
      .catch(() => setRoomMessage("Video catalog is unavailable. Check the backend server."));

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedVideo = videos.find((video) => video.id === selectedVideoId);

  const enterRoom = (nextRole: RoleIntent, nextRoom: string) => {
    const roomName = nextRoom.trim();
    if (!roomName) return;
    const video = selectedVideo ?? videos[0];
    if (video) {
      setSelectedVideoId(video.id);
      setManifestUrl(video.manifestUrl);
    }
    setRoomId(roomName);
    setRoleIntent(nextRole);
    setRoomState(null);
    setMetrics(initialMetrics);
    setSyncDelay(null);
    setShowRoomSettings(false);
    setSessionMode("room");
    setRoomMessage(nextRole === "host" ? "Room started. Share the room name with viewers." : "Joining as viewer. Waiting for host timeline.");
  };

  const startRoom = () => enterRoom("host", roomId);
  const joinRoom = () => enterRoom("viewer", joinRoomId);

  const leaveRoom = () => {
    socket.disconnect();
    setSessionMode("lobby");
    setRoomState(null);
    setRoomMessage("Choose a room action to begin.");
  };

  const applySelectedVideo = () => {
    if (!isHost) {
      setRoomMessage("Only the host can change the room video.");
      return;
    }

    if (!selectedVideo) return;
    setManifestUrl(selectedVideo.manifestUrl);
    socket.emit("room:manifest", {
      roomId: normalizedRoom,
      clientId,
      videoId: selectedVideo.id,
      manifestUrl: selectedVideo.manifestUrl
    });
    setRoomMessage(`${selectedVideo.title} applied to the room.`);
  };

  const prepareNewRoom = () => {
    const nextRoom = createRoomName();
    setRoomId(nextRoom);
    setRoomMessage("New room name prepared. Start it when ready.");
  };

  const copyRoomName = async () => {
    await navigator.clipboard.writeText(normalizedRoom).catch(() => undefined);
    setRoomMessage("Room name copied.");
  };

  const handleRoomState = (state: RoomState) => {
    setRoomState(state);
    if (state.manifestUrl && state.manifestUrl !== manifestUrl) {
      setManifestUrl(state.manifestUrl);
    }
    if (state.videoId) setSelectedVideoId(state.videoId);
    if (state.hostClientId === clientId) setRoomMessage("You are hosting this room.");
    else if (!state.hostClientId) setRoomMessage("No host is active in this room yet.");
    else setRoomMessage("You are synced to the host timeline.");
  };

  if (sessionMode === "lobby") {
    return (
      <main className="app-shell lobby-shell">
        <section className="hero-panel">
          <div className="hero-copy">
            <p className="eyebrow">MPEG-DASH Watch Party</p>
            <h1>Start a room, choose a server video, watch in sync.</h1>
            <p className="hero-text">Setiap browser masuk netral dulu. Host dibuat hanya saat memilih Start room, sedangkan viewer masuk lewat Join room dan mengikuti timeline host.</p>
          </div>
          <div className="hero-actions">
            <span className="role-pill" data-host="false"><Activity className="h-4 w-4" /> Neutral</span>
            <span className="status-pill"><Film className="h-4 w-4" />{videos.length || 0} videos</span>
          </div>
        </section>

        <section className="lobby-grid">
          <div className="lobby-card">
            <div className="sheet-header">
              <div><p className="eyebrow">Host</p><h2>Start room</h2></div>
              <button className="icon-button" type="button" onClick={prepareNewRoom} title="Generate room"><Plus className="h-5 w-5" /></button>
            </div>
            <label><span>Room name</span><input value={roomId} onChange={(event) => setRoomId(event.target.value)} /></label>
            <div className="video-picker lobby-video-picker">
              <div className="sheet-header compact"><div><p className="eyebrow">Server Library</p><h2>Choose video</h2></div></div>
              <div className="video-grid">
                {videos.map((video) => (
                  <button className="video-option" data-active={selectedVideoId === video.id} key={video.id} type="button" onClick={() => setSelectedVideoId(video.id)}>
                    <Clapperboard className="h-5 w-5" />
                    <span>{video.title}</span>
                  </button>
                ))}
              </div>
            </div>
            <button className="primary-button wide-button" type="button" onClick={startRoom} disabled={videos.length === 0}><Star className="h-4 w-4" /> Start room as host</button>
          </div>

          <div className="lobby-card join-card">
            <div className="sheet-header"><div><p className="eyebrow">Viewer</p><h2>Join room</h2></div></div>
            <label><span>Room name from host</span><input value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value)} /></label>
            <p className="helper-text">Viewer tidak memilih video. Server room akan mengirim video yang dipilih host.</p>
            <button className="ghost-button wide-button" type="button" onClick={joinRoom}><LogIn className="h-4 w-4" /> Join as viewer</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MPEG-DASH Watch Party</p>
          <h1>Watch Party</h1>
        </div>
        <div className="topbar-actions">
          <span className="role-pill" data-host={isHost}>{isHost ? <Star className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{isHost ? "Host" : "Viewer"}</span>
          <span className="status-pill"><Users className="h-4 w-4" />{roomState?.peerCount ?? 1}</span>
          <button className="icon-button" type="button" onClick={() => setShowRoomSettings((value) => !value)} title="Room settings"><Settings className="h-5 w-5" /></button>
          <button className="icon-button" type="button" onClick={() => setShowDiagnostics((value) => !value)} title="Diagnostics"><BarChart3 className="h-5 w-5" /></button>
          <button className="ghost-button" type="button" onClick={leaveRoom}>Leave</button>
        </div>
      </header>

      <section className="room-strip">
        <div><span className="strip-label">Room</span><strong>{normalizedRoom}</strong></div>
        <div><span className="strip-label">Video</span><strong>{activeVideo?.title ?? roomState?.videoTitle ?? "Loading catalog"}</strong></div>
        <div><span className="strip-label">Status</span><strong>{roomMessage}</strong></div>
      </section>

      <section className="player-layout">
        <DashPlayer clientId={clientId} manifestUrl={manifestUrl} roomId={normalizedRoom} isHost={isHost} roleIntent={roleIntent} videoId={selectedVideoId} onMetrics={setMetrics} onRoomManifest={setManifestUrl} onRoomMessage={setRoomMessage} onRoomState={handleRoomState} onSyncDelay={setSyncDelay} />
      </section>

      {showRoomSettings && (
        <section className="sheet" aria-label="Room settings">
          <div className="sheet-header">
            <div><p className="eyebrow">Room Setup</p><h2>Room and video</h2></div>
            <button className="ghost-button" type="button" onClick={copyRoomName}><Copy className="h-4 w-4" /> Copy room</button>
          </div>
          <div className="video-picker no-border">
            <div className="sheet-header compact"><div><p className="eyebrow">Server Library</p><h2>Choose video</h2></div><button className="primary-button" type="button" onClick={applySelectedVideo} disabled={!isHost || videos.length === 0}><Film className="h-4 w-4" /> Apply to room</button></div>
            <div className="video-grid">
              {videos.map((video) => (<button className="video-option" data-active={selectedVideoId === video.id} key={video.id} type="button" onClick={() => setSelectedVideoId(video.id)} disabled={!isHost}><Clapperboard className="h-5 w-5" /><span>{video.title}</span></button>))}
            </div>
            {!isHost && <p className="helper-text">Only the host can choose the room video. Viewers automatically receive the selected video.</p>}
          </div>
        </section>
      )}

      {showDiagnostics && (
        <section className="sheet diagnostics" aria-label="QoS diagnostics">
          <div className="sheet-header"><div><p className="eyebrow">Diagnostics</p><h2>QoS metrics</h2></div><div className="export-actions"><a className="ghost-button" href={metricsJsonUrl} target="_blank" rel="noreferrer"><Download className="h-4 w-4" /> JSON</a><a className="ghost-button" href={metricsCsvUrl} target="_blank" rel="noreferrer"><Download className="h-4 w-4" /> CSV</a></div></div>
          <div className="metric-grid">
            <div><span>Startup delay</span><strong>{metrics.startupDelayMs === null ? "-" : `${metrics.startupDelayMs} ms`}</strong></div>
            <div><span>Buffering ratio</span><strong>{(metrics.bufferingRatio * 100).toFixed(1)}%</strong></div>
            <div><span>Buffer events</span><strong>{metrics.bufferingEvents}</strong></div>
            <div><span>Average bitrate</span><strong>{metrics.averageBitrateKbps === null ? "-" : `${metrics.averageBitrateKbps} kbps`}</strong></div>
            <div><span>Sync delay</span><strong>{metrics.syncDelayMs === null ? "-" : `${metrics.syncDelayMs} ms`}</strong></div>
            <div><span>Room sync</span><strong>{syncDelay === null ? "Waiting" : `${syncDelay} ms`}</strong></div>
          </div>
        </section>
      )}
    </main>
  );
}
