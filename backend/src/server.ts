import cors from "cors";
import express from "express";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const mediaRoot = path.join(projectRoot, "media");
const defaultManifestUrl = "http://localhost:4000/media/dash/stream.mpd";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = new Set([
  process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  }
};

app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins),
    methods: ["GET", "POST"]
  }
});

type VideoCatalogItem = {
  id: string;
  title: string;
  manifestUrl: string;
  relativePath: string;
};

type PlayerEvent = {
  roomId: string;
  clientId: string;
  currentTime: number;
  isPlaying: boolean;
  sentAt: number;
};

type RoomJoinEvent = {
  roomId: string;
  clientId: string;
  roleIntent?: "host" | "viewer";
  manifestUrl?: string;
  videoId?: string;
};

type ManifestChangeEvent = {
  roomId: string;
  clientId: string;
  manifestUrl: string;
  videoId?: string;
};

type RoomState = {
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

type MetricsSample = {
  roomId: string;
  clientId?: string;
  startupDelayMs?: number | null;
  bufferingRatio?: number;
  bufferingEvents?: number;
  averageBitrateKbps?: number | null;
  syncDelayMs?: number | null;
  sentAt: number;
};

type RoomPeer = {
  socketId: string;
  clientId: string;
  role: "host" | "viewer";
  joinedAt: number;
};

const rooms = new Map<string, RoomState>();
const metricsByRoom = new Map<string, MetricsSample[]>();
const peersByRoom = new Map<string, Map<string, RoomPeer>>();

function titleFromPath(relativePath: string) {
  const directory = path.dirname(relativePath).replace(/\\/g, "/");
  const name = directory === "." ? "Default DASH Video" : directory.split("/").filter(Boolean).pop() ?? "DASH Video";
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function discoverVideos() {
  const found: VideoCatalogItem[] = [];

  function walk(directory: string) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === "stream.mpd") {
        const relativePath = path.relative(mediaRoot, fullPath).replace(/\\/g, "/");
        const id = relativePath.replace(/\/stream\.mpd$/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
        found.push({
          id,
          title: titleFromPath(relativePath),
          manifestUrl: `http://localhost:${port}/media/${relativePath}`,
          relativePath
        });
      }
    }
  }

  walk(mediaRoot);

  if (!found.some((video) => video.manifestUrl === defaultManifestUrl)) {
    found.unshift({
      id: "default",
      title: "Default DASH Video",
      manifestUrl: defaultManifestUrl,
      relativePath: "dash/stream.mpd"
    });
  }

  return found.sort((a, b) => a.title.localeCompare(b.title));
}

function videoByManifest(manifestUrl: string) {
  return discoverVideos().find((video) => video.manifestUrl === manifestUrl);
}

function videoById(videoId?: string) {
  if (!videoId) return undefined;
  return discoverVideos().find((video) => video.id === videoId);
}

function defaultVideo() {
  return discoverVideos()[0] ?? {
    id: "default",
    title: "Default DASH Video",
    manifestUrl: defaultManifestUrl,
    relativePath: "dash/stream.mpd"
  };
}

function getRoomState(roomId: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const video = defaultVideo();
  const created: RoomState = {
    roomId,
    manifestUrl: video.manifestUrl,
    videoId: video.id,
    videoTitle: video.title,
    currentTime: 0,
    isPlaying: false,
    updatedAt: Date.now(),
    peerCount: 0
  };
  rooms.set(roomId, created);
  return created;
}

function getRoomPeers(roomId: string) {
  const peers = peersByRoom.get(roomId) ?? new Map<string, RoomPeer>();
  peersByRoom.set(roomId, peers);
  return peers;
}

function isHost(roomId: string, clientId: string) {
  const state = getRoomState(roomId);
  return state.hostClientId === clientId;
}

function assignHostIfNeeded(roomId: string) {
  const state = getRoomState(roomId);
  const peers = getRoomPeers(roomId);
  const hostPeer = Array.from(peers.values()).find((peer) => peer.clientId === state.hostClientId);
  state.hostSocketId = hostPeer?.socketId;
  state.peerCount = peers.size;
  return state;
}

function publicRoomState(roomId: string) {
  const state = assignHostIfNeeded(roomId);
  return {
    ...state,
    peerCount: getRoomPeers(roomId).size
  };
}

function publishRoomState(roomId: string) {
  const state = publicRoomState(roomId);
  io.to(roomId).emit("room:state", state);
}

function roomMetricsCsv(roomId: string) {
  const rows = metricsByRoom.get(roomId) ?? [];
  const header = ["sentAt", "clientId", "startupDelayMs", "bufferingRatio", "bufferingEvents", "averageBitrateKbps", "syncDelayMs"];
  const lines = rows.map((row) => [
    row.sentAt,
    row.clientId ?? "",
    row.startupDelayMs ?? "",
    row.bufferingRatio ?? "",
    row.bufferingEvents ?? "",
    row.averageBitrateKbps ?? "",
    row.syncDelayMs ?? ""
  ].join(","));
  return [header.join(","), ...lines].join("\n");
}

app.get("/", (_req, res) => {
  res.type("text/plain").send([
    "Watch Party backend is running.",
    "Health check: /health",
    "Video catalog: /videos",
    "Room state: /rooms/:roomId",
    "Room metrics JSON: /rooms/:roomId/metrics",
    "Room metrics CSV: /rooms/:roomId/metrics.csv",
    "Open the frontend at http://localhost:5173"
  ].join("\n"));
});

app.get("/videos", (_req, res) => {
  res.json({ videos: discoverVideos() });
});

app.get("/media/dash", (_req, res) => {
  res.type("text/plain").send("DASH directory is not browsable. Use the frontend video picker or /videos catalog.");
});

app.use("/media", express.static(mediaRoot));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "watch-party-backend", rooms: rooms.size, videos: discoverVideos().length });
});

app.get("/rooms/:roomId", (req, res) => {
  const roomId = req.params.roomId;
  res.json({
    ...publicRoomState(roomId),
    peers: Array.from(getRoomPeers(roomId).values()),
    recentMetrics: metricsByRoom.get(roomId)?.slice(-10) ?? []
  });
});

app.get("/rooms/:roomId/metrics", (req, res) => {
  const roomId = req.params.roomId;
  res.json({ roomId, samples: metricsByRoom.get(roomId) ?? [] });
});

app.get("/rooms/:roomId/metrics.csv", (req, res) => {
  const roomId = req.params.roomId;
  res.header("Content-Type", "text/csv");
  res.attachment(`${roomId}-metrics.csv`);
  res.send(roomMetricsCsv(roomId));
});

io.on("connection", (socket) => {
  socket.on("room:join", async (event: RoomJoinEvent | string) => {
    const roomId = typeof event === "string" ? event : event.roomId;
    const clientId = typeof event === "string" ? socket.id : event.clientId;
    const roleIntent = typeof event === "string" ? "viewer" : event.roleIntent ?? "viewer";
    const video = typeof event === "string" ? undefined : videoById(event.videoId) ?? videoByManifest(event.manifestUrl ?? "");
    if (!roomId || !clientId) return;

    await socket.join(roomId);
    socket.data.clientId = clientId;
    socket.data.roomId = roomId;

    const peers = getRoomPeers(roomId);
    peers.set(socket.id, { socketId: socket.id, clientId, role: roleIntent, joinedAt: Date.now() });

    const state = getRoomState(roomId);
    if (!state.hostClientId && roleIntent === "host") {
      state.hostClientId = clientId;
      state.hostSocketId = socket.id;
      if (video) {
        state.videoId = video.id;
        state.videoTitle = video.title;
        state.manifestUrl = video.manifestUrl;
      }
    }
    state.peerCount = peers.size;

    socket.emit("room:state", publicRoomState(roomId));
    socket.to(roomId).emit("room:peer-joined", { socketId: socket.id, clientId, peerCount: state.peerCount });
    publishRoomState(roomId);
  });

  socket.on("room:manifest", (event: ManifestChangeEvent) => {
    const selectedVideo = videoById(event.videoId) ?? videoByManifest(event.manifestUrl);
    if (!event.roomId || !event.clientId || !selectedVideo || !isHost(event.roomId, event.clientId)) {
      socket.emit("room:error", { message: "Only the room host can change the video." });
      return;
    }

    const state = getRoomState(event.roomId);
    state.manifestUrl = selectedVideo.manifestUrl;
    state.videoId = selectedVideo.id;
    state.videoTitle = selectedVideo.title;
    state.currentTime = 0;
    state.isPlaying = false;
    state.updatedAt = Date.now();
    state.updatedBy = event.clientId;
    publishRoomState(event.roomId);
  });

  socket.on("player:state", (event: PlayerEvent) => {
    if (!event.roomId || !event.clientId || !isHost(event.roomId, event.clientId)) {
      socket.emit("room:error", { message: "Only the room host can control playback." });
      return;
    }

    const state = getRoomState(event.roomId);
    state.currentTime = event.currentTime;
    state.isPlaying = event.isPlaying;
    state.updatedAt = Date.now();
    state.updatedBy = event.clientId;

    socket.to(event.roomId).emit("player:state", { ...event, serverReceivedAt: state.updatedAt });
    publishRoomState(event.roomId);
  });

  socket.on("metrics:sample", (sample: MetricsSample) => {
    if (!sample.roomId) return;
    const samples = metricsByRoom.get(sample.roomId) ?? [];
    samples.push({ ...sample, sentAt: sample.sentAt ?? Date.now() });
    metricsByRoom.set(sample.roomId, samples.slice(-500));
  });

  socket.on("disconnecting", () => {
    const joinedRooms = Array.from(socket.rooms).filter((roomId) => roomId !== socket.id);
    socket.data.joinedRooms = joinedRooms;
  });

  socket.on("disconnect", () => {
    const joinedRooms = (socket.data.joinedRooms as string[] | undefined) ?? [];
    for (const roomId of joinedRooms) {
      const peers = getRoomPeers(roomId);
      peers.delete(socket.id);
      if (peers.size === 0) {
        peersByRoom.delete(roomId);
        rooms.delete(roomId);
        metricsByRoom.delete(roomId);
        continue;
      }
      publishRoomState(roomId);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Backend ready on http://localhost:${port}`);
  console.log(`Video catalog: http://localhost:${port}/videos`);
});
