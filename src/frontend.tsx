import "./tailwind.css";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Check,
  Copy,
  Folder,
  FileText,
  Users,
  RefreshCw,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
} from "lucide-react";
import { FitAddon, init, Terminal } from "ghostty-web";

type FileEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));


const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

function App() {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"console" | "files">("console");

  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const [terminalReady, setTerminalReady] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [logStatus, setLogStatus] = useState<"connecting" | "connected" | "error">(
    "connecting",
  );
  const [serverStatus, setServerStatus] = useState<{
    host: string;
    port: number;
    publicAddress: string | null;
    motd: string | null;
    version: string | null;
    latency: number | null;
    players: {
      online: number;
      max: number;
      sample: string[];
    };
  } | null>(null);
  const [serverStatusMeta, setServerStatusMeta] = useState<{
    cached?: boolean;
    stale?: boolean;
    error?: string;
    fetchedAt?: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef("");
  const logStreamRef = useRef<WebSocket | null>(null);
  const prompt = "server> ";

  const writePrompt = (term: Terminal) => {
    term.write(prompt);
  };

  const writeLogLine = (line: string) => {
    const term = terminalInstanceRef.current;
    if (!term) return;
    term.write("\r\x1b[2K");
    term.write(line.length ? `${line}\r\n` : "\r\n");
    term.write(`${prompt}${inputBufferRef.current}`);
  };

  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    const items = [{ name: "root", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ name: part, path: acc });
    }
    return items;
  }, [currentPath]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [entries, query]);

  useEffect(() => {
    void fetchEntries("/");
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeTab !== "files") return;
      if (!searchRef.current) return;
      const isTypingTarget =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "INPUT" ||
          event.target.tagName === "TEXTAREA" ||
          event.target.isContentEditable);
      if (isTypingTarget) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current.focus();
      }
      if (event.key === "Escape") {
        if (document.activeElement === searchRef.current) {
          searchRef.current.blur();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    const setupTerminal = async () => {
      if (!terminalRef.current || terminalInstanceRef.current) return;
      setConsoleError(null);
      try {
        await init();
        if (cancelled || !terminalRef.current) return;
        const term = new Terminal({
          fontSize: 13,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          cursorBlink: true,
          theme: {
            background: "#0b0c10",
            foreground: "#e9e9ee",
            cursor: "#d7ff5a",
            cursorAccent: "#0b0c10",
            selectionBackground: "#1b1f2b",
            selectionForeground: "#f4f5f7",
          },
        });
        terminalInstanceRef.current = term;
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;
        term.open(terminalRef.current);
        requestAnimationFrame(() => fitAddon.fit());
        term.write("Console ready.\r\n");
        writePrompt(term);
        term.onData((data) => {
          const activeTerm = terminalInstanceRef.current;
          if (!activeTerm) return;
          for (const chunk of data) {
            if (chunk === "\r" || chunk === "\n") {
              const commandText = inputBufferRef.current;
              inputBufferRef.current = "";
              activeTerm.write("\r\n");
              void sendCommand(commandText, { rePrompt: false });
              writePrompt(activeTerm);
              continue;
            }
            if (chunk === "\u007f" || chunk === "\b") {
              if (inputBufferRef.current.length > 0) {
                inputBufferRef.current = inputBufferRef.current.slice(0, -1);
                activeTerm.write("\b \b");
              }
              continue;
            }
            inputBufferRef.current += chunk;
            activeTerm.write(chunk);
          }
        });
        setTerminalReady(true);
      } catch (err) {
        setConsoleError(
          err instanceof Error ? err.message : "Failed to load terminal.",
        );
        setTerminalReady(false);
      }
    };

    void setupTerminal();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!terminalReady || !terminalInstanceRef.current) return;
    let cancelled = false;
    let retry = 0;
    let retryTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      if (!terminalInstanceRef.current) return;
      setLogStatus("connecting");

      const wsUrl = new URL("/api/console/ws", window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

      const ws = new WebSocket(wsUrl.toString());
      logStreamRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        writeLogLine("Console log stream connected.");
        setLogStatus("connected");
      };

      ws.onmessage = (event) => {
        const line = typeof event.data === "string" ? event.data : "";
        writeLogLine(line);
      };

      ws.onerror = () => {
        setLogStatus("error");
      };

      ws.onclose = () => {
        setLogStatus("error");
        if (cancelled) return;
        retry += 1;
        const backoff = Math.min(8000, 450 * 2 ** Math.min(5, retry));
        const jitter = Math.round(Math.random() * 200);
        retryTimer = window.setTimeout(connect, backoff + jitter);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = null;
      logStreamRef.current?.close();
      logStreamRef.current = null;
    };
  }, [terminalReady]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/server/status");
        const payload = (await res.json()) as
          | {
              ok: true;
              data: {
                host: string;
                port: number;
                publicAddress: string | null;
                motd: string | null;
                version: string | null;
                latency: number | null;
                players: { online: number; max: number; sample: string[] };
              };
              cached?: boolean;
              stale?: boolean;
              error?: string;
              fetchedAt?: number;
            }
          | { ok: false; error?: string };

        if (!res.ok || !payload.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Status ping failed.",
          );
        }

        if (cancelled) return;
        setServerStatus(payload.data);
        setServerStatusMeta({
          cached: payload.cached,
          stale: payload.stale,
          error: payload.error,
          fetchedAt: payload.fetchedAt,
        });
      } catch (error) {
        if (cancelled) return;
        setServerStatusMeta({
          error: error instanceof Error ? error.message : "Status ping failed.",
          fetchedAt: Date.now(),
        });
      }
    };

    void fetchStatus();
    timer = window.setInterval(fetchStatus, 12_000);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "console") return;
    if (!terminalInstanceRef.current || !fitAddonRef.current) return;
    requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [activeTab, terminalReady]);

  useEffect(() => {
    const el = terminalRef.current;
    if (!el || !fitAddonRef.current) return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [terminalReady]);

  const fetchEntries = async (path: string) => {
    setIsLoading(true);
    setError(null);
    setSelected(null);
    setPreview("");
    setPreviewError(null);
    setQuery("");
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      const data = (await res.json()) as { entries?: FileEntry[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load directory.");
      }
      setEntries(data.entries ?? []);
      setCurrentPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory.");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPreview = async (entry: FileEntry) => {
    setPreview("");
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load file.");
      }
      setPreview(data.content ?? "");
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to load file.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleEntryClick = async (entry: FileEntry) => {
    if (entry.type === "dir") {
      await fetchEntries(entry.path);
      return;
    }
    setSelected(entry);
    await fetchPreview(entry);
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadName(file.name || "upload.bin");
    setError(null);
    try {
      const uploadName = file.name || "upload.bin";
      const uploadPath = `/api/files/upload?path=${encodeURIComponent(currentPath)}`;
      const totalBytes = Math.max(file.size, 1);
      let uploadedBytes = 0;
      const reader = file.stream().getReader();
      const monitoredStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            setUploadProgress(100);
            controller.close();
            return;
          }
          uploadedBytes += value.byteLength;
          const percent = Math.min(
            100,
            Math.round((uploadedBytes / totalBytes) * 100),
          );
          setUploadProgress(percent);
          controller.enqueue(value);
        },
        cancel(reason) {
          void reader.cancel(reason);
        },
      });
      const res = await fetch(uploadPath, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": uploadName,
        },
        body: monitoredStream,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Upload failed.");
      }
      await fetchEntries(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      setUploadName(null);
      setUploadProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(deleteTarget.path)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Delete failed.");
      }
      if (selected?.path === deleteTarget.path) {
        setSelected(null);
        setPreview("");
      }
      await fetchEntries(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteTarget(null);
    }
  };

  const sendCommand = async (
    rawCommand: string,
    options: { rePrompt?: boolean } = {},
  ) => {
    const term = terminalInstanceRef.current;
    const commandText = rawCommand.trim();
    if (!term) return;
    const shouldPrompt = options.rePrompt ?? true;
    if (!commandText) {
      if (shouldPrompt) writePrompt(term);
      return;
    }
    try {
      const res = await fetch("/api/console", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: commandText }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Console command failed.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Console request failed.";
      if (shouldPrompt) {
        term.write(`${message}\r\n`);
      } else {
        writeLogLine(message);
        return;
      }
    }
    if (shouldPrompt) writePrompt(term);
  };

  const dotClass =
    logStatus === "connected"
      ? "dash-dot"
      : logStatus === "error"
        ? "dash-dot dash-dot--error"
        : "dash-dot dash-dot--connecting";

  const handleCopySelected = async () => {
    if (!selected) return;
    const full = `/data${selected.path}`;
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // ignore
    }
  };

  const runMacro = (command: string) => {
    const term = terminalInstanceRef.current;
    if (!term) return;
    inputBufferRef.current = "";
    term.write(`\r\n› ${command}\r\n`);
    void sendCommand(command, { rePrompt: false });
    writePrompt(term);
  };

  const runPlayers = () => runMacro("list");

  const playerList = useMemo(() => {
    if (serverStatus) return serverStatus.players.sample ?? [];
    return [];
  }, [serverStatus]);

  const playerCountLabel = useMemo(() => {
    if (serverStatus) {
      return `${serverStatus.players.online}/${serverStatus.players.max}`;
    }
    return "—";
  }, [serverStatus]);

  return (
    <div className="min-h-screen dash-bg text-foreground">
      <div className="dash-shell dash-appear">
        <header className="dash-topbar">
          <div>
            <div className="dash-kicker">Minecraft Control</div>
            <h1 className="dash-title">Server Operations</h1>
            <p className="dash-sub">
              Manage files under <span className="text-foreground/90">/data</span>{" "}
              and send console commands. Press <kbd className="dash-key">/</kbd> to
              search files.
            </p>
          </div>
        </header>

        <nav className="dash-nav" aria-label="Dashboard sections">
          <button
            type="button"
            className="dash-navbtn"
            aria-current={activeTab === "console" ? "page" : undefined}
            onClick={() => setActiveTab("console")}
          >
            <TerminalIcon className="h-4 w-4 opacity-75" />
            Console
          </button>
          <button
            type="button"
            className="dash-navbtn"
            aria-current={activeTab === "files" ? "page" : undefined}
            onClick={() => setActiveTab("files")}
          >
            <Folder className="h-4 w-4 opacity-75" />
            Files
          </button>
        </nav>

        {activeTab === "console" ? (
          <section className="mt-6 grid gap-4" aria-label="Console">
            <div className="dash-surface">
              <div className="dash-panelhead">
                <div>
                  <div className="dash-paneltitle">Console</div>
                  <div className="text-xs text-muted-foreground">
                    Logs stream into the terminal. Type a command and press Enter.
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="dash-chip">
                    <span className={dotClass} />
                    {serverStatus ? "online" : "unknown"}
                  </span>
                  <span className="dash-chip">players: {playerCountLabel}</span>
                  {serverStatus?.publicAddress ? (
                    <span className="dash-chip">{serverStatus.publicAddress}</span>
                  ) : null}
                </div>
              </div>

              <div className="dash-bodypad">
                {consoleError ? (
                  <div className="dash-mutedbox text-destructive">
                    {consoleError}
                  </div>
                ) : null}
                <div className="mt-3 h-[420px] w-full rounded-2xl border border-border/80 bg-[#0b0c10] p-3">
                  <div className="h-full w-full overflow-hidden rounded-xl bg-[#0b0c10]">
                    <div
                      ref={terminalRef}
                      className="ghostty-console ghostty-console--inset h-full w-full"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-12">
              <section className="dash-surface lg:col-span-8" aria-label="Server snapshot">
                <div className="dash-panelhead">
                  <div className="dash-paneltitle">Server snapshot</div>
                </div>

                <div className="dash-bodypad space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Status
                      </div>
                      <div className="mt-1 text-sm text-foreground/95">
                        {serverStatus ? "online" : "unknown"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Address
                      </div>
                      <div className="mt-1 truncate text-sm text-foreground/95">
                        {serverStatus?.publicAddress ?? "—"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Version
                      </div>
                      <div className="mt-1 text-sm text-foreground/95">
                        {serverStatus?.version ?? "—"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Players
                      </div>
                      <div className="mt-1 text-sm text-foreground/95">
                        {playerCountLabel}
                      </div>
                    </div>
                  </div>

                  {serverStatusMeta?.error ? (
                    <div className="dash-mutedbox text-destructive">
                      {serverStatusMeta.error}
                    </div>
                  ) : null}

                  {serverStatus?.motd ? (
                    <div className="dash-mutedbox">{serverStatus.motd}</div>
                  ) : null}
                </div>
              </section>

              <section className="dash-surface lg:col-span-4" aria-label="Online players">
                <div className="dash-panelhead">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="dash-paneltitle">Online</div>
                    <span className="dash-chip">{playerCountLabel}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 rounded-full bg-background/40 px-4"
                      onClick={runPlayers}
                      disabled={!terminalReady}
                    >
                      <Users className="h-4 w-4 opacity-80" />
                      Refresh
                    </Button>
                  </div>
                </div>

                <div className="dash-bodypad space-y-3">
                  {playerList.length ? (
                    <div className="grid gap-2">
                      {playerList.map((name) => (
                        <div
                          key={name}
                          className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/30 px-3 py-2"
                        >
                          <div className="min-w-0 truncate text-sm text-foreground/95">
                            {name}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 shrink-0 rounded-full bg-background px-4"
                            onClick={() => runMacro(`op ${name}`)}
                            disabled={!terminalReady}
                          >
                            OP
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="dash-mutedbox">No players detected.</div>
                  )}

                  {playerList.length ? (
                    <div className="text-[11px] text-muted-foreground">
                      Tip: OP runs via the console pipe (shows in the terminal output).
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          </section>
        ) : (
          <section className="dash-split" aria-label="Files">
            <div className="dash-surface">
              <div className="dash-panelhead">
                <div>
                  <div className="dash-paneltitle">File Browser</div>
                  <div className="text-xs text-muted-foreground">
                    {filteredEntries.length} item{filteredEntries.length === 1 ? "" : "s"}
                    {query.trim() ? " (filtered)" : ""} · root is{" "}
                    <span className="text-foreground/90">/data</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(event) =>
                      handleUpload(event.target.files?.[0] ?? null)
                    }
                  />

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-full bg-background/40 px-4"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    <Upload className="h-4 w-4 opacity-80" />
                    Upload
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-full bg-background/40 px-4"
                    onClick={() => fetchEntries(currentPath)}
                    disabled={isLoading}
                  >
                    <RefreshCw
                      className={cn("h-4 w-4 opacity-80", isLoading && "animate-spin")}
                    />
                    Refresh
                  </Button>
                </div>
              </div>

              <div className="dash-bodypad space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {breadcrumbs.map((crumb, index) => (
                    <span key={crumb.path} className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg px-2 py-1 transition hover:bg-background/40 hover:text-foreground/90"
                        onClick={() => fetchEntries(crumb.path)}
                      >
                        {crumb.name}
                      </button>
                      {index < breadcrumbs.length - 1 ? <span>/</span> : null}
                    </span>
                  ))}
                </div>

                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search files (press /)…"
                  className="h-11 w-full rounded-2xl border border-border/70 bg-background/35 px-4 text-sm text-foreground/90 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
                />

                {error ? (
                  <div className="dash-mutedbox text-destructive">{error}</div>
                ) : null}

                {uploading ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        {uploadProgress >= 100
                          ? `Finalizing ${uploadName ?? "file"}...`
                          : `Uploading ${uploadName ?? "file"}...`}
                      </span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-background/35">
                      <div
                        className="h-full bg-primary transition-[width]"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                <ScrollArea className="h-[420px] pr-3">
                  <div className="flex flex-col gap-2">
                    {filteredEntries.length === 0 && !isLoading ? (
                      <div className="dash-mutedbox">
                        {entries.length === 0
                          ? "No files found in this folder."
                          : "No matches."}
                      </div>
                    ) : null}

                    {filteredEntries.map((entry) => (
                      <div
                        key={entry.path}
                        className="dash-row"
                        aria-selected={selected?.path === entry.path}
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          onClick={() => handleEntryClick(entry)}
                        >
                          {entry.type === "dir" ? (
                            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-sm text-foreground/95">
                              {entry.name}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {entry.type === "dir" ? "Folder" : formatSize(entry.size)}
                              {" · "}
                              {formatTimestamp(entry.mtime)}
                            </div>
                          </div>
                        </button>

                        <div className="flex items-center gap-2">
                          <span className="dash-chip">{entry.type}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 rounded-full hover:bg-background/40"
                            onClick={() => setDeleteTarget(entry)}
                            aria-label={`Delete ${entry.name}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>

            <aside className="dash-surface" aria-label="Preview">
              <div className="dash-panelhead">
                <div className="dash-paneltitle">Preview</div>
                {selected ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 rounded-full bg-background/40 px-4"
                      onClick={handleCopySelected}
                      disabled={copied}
                    >
                      {copied ? (
                        <Check className="h-4 w-4 opacity-80" />
                      ) : (
                        <Copy className="h-4 w-4 opacity-80" />
                      )}
                      {copied ? "Copied" : "Copy path"}
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="dash-bodypad space-y-3">
                {selected ? (
                  <>
                    <div className="space-y-1">
                      <div className="truncate text-sm text-foreground/95">
                        {selected.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        <span className="text-foreground/80">/data</span>
                        {selected.path}
                      </div>
                    </div>

                    {selected.type === "dir" ? (
                      <div className="dash-mutedbox">
                        This is a folder. Open it to browse its contents.
                      </div>
                    ) : previewLoading ? (
                      <div className="dash-mutedbox">Loading preview…</div>
                    ) : previewError ? (
                      <div className="dash-mutedbox text-destructive">
                        {previewError}
                      </div>
                    ) : (
                      <ScrollArea className="h-[420px] rounded-2xl border border-border/70 bg-background/30">
                        <pre className="whitespace-pre-wrap p-4 text-[12px] leading-relaxed text-foreground/90">
                          {preview || "No preview available."}
                        </pre>
                      </ScrollArea>
                    )}
                  </>
                ) : (
                  <div className="dash-mutedbox">
                    Select a file to preview its contents.
                  </div>
                )}
              </div>
            </aside>
          </section>
        )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `This will permanently remove ${deleteTarget.name}.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
