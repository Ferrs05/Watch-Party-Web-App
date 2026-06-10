import { Activity, Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DashPlayer } from "./components/DashPlayer";

const defaultManifest = "http://localhost:4000/media/dash/stream.mpd";

export default function App() {
  const [roomId, setRoomId] = useState("demo-room");
  const [manifestUrl, setManifestUrl] = useState(defaultManifest);
  const [syncDelay, setSyncDelay] = useState<number | null>(null);

  const normalizedRoom = useMemo(() => roomId.trim() || "demo-room", [roomId]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Watch Party</h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-zinc-300">
            <Activity className="h-4 w-4 text-emerald-400" />
            {syncDelay === null ? "Waiting for sync event" : `Sync delay ${syncDelay} ms`}
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-[1fr_280px]">
          <div className="overflow-hidden rounded border border-zinc-800 bg-black">
            <DashPlayer
              manifestUrl={manifestUrl}
              roomId={normalizedRoom}
              onSyncDelay={setSyncDelay}
            />
          </div>

          <aside className="rounded border border-zinc-800 bg-zinc-900 p-4">
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Room</span>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-emerald-500"
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                />
              </label>

              <label className="block text-sm">
                <span className="mb-1 flex items-center gap-2 text-zinc-300">
                  <Link2 className="h-4 w-4" /> Manifest URL
                </span>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-emerald-500"
                  value={manifestUrl}
                  onChange={(event) => setManifestUrl(event.target.value)}
                />
              </label>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
