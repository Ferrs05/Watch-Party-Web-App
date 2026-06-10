import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const mediaRoot = path.join(projectRoot, "media");

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

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "Watch Party backend is running.",
      "Health check: /health",
      "DASH manifest: /media/dash/stream.mpd",
      "Open the frontend at http://localhost:5173"
    ].join("\n")
  );
});

app.get("/media/dash", (_req, res) => {
  res.type("text/plain").send(
    "DASH directory is not browsable. Use /media/dash/stream.mpd as the Manifest URL."
  );
});

app.use("/media", express.static(mediaRoot));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "watch-party-backend" });
});

const io = new Server(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins),
    methods: ["GET", "POST"]
  }
});

type PlayerEvent = {
  roomId: string;
  currentTime: number;
  isPlaying: boolean;
  sentAt: number;
};

io.on("connection", (socket) => {
  socket.on("room:join", (roomId: string) => {
    socket.join(roomId);
    socket.to(roomId).emit("room:peer-joined", { socketId: socket.id });
  });

  socket.on("player:state", (event: PlayerEvent) => {
    socket.to(event.roomId).emit("player:state", {
      ...event,
      serverReceivedAt: Date.now()
    });
  });
});

httpServer.listen(port, () => {
  console.log(`Backend ready on http://localhost:${port}`);
  console.log(`DASH manifest: http://localhost:${port}/media/dash/stream.mpd`);
});
