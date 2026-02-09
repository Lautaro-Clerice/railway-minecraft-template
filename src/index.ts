import { readdir, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import index from "./index.html";
import mc from "minecraftstatuspinger";
import type { ServerWebSocket } from "bun";
import { env } from "./env";

const MAX_PREVIEW_BYTES = 200_000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const FILES_ROOT = path.resolve("/data");
const CONSOLE_PIPE = "/tmp/minecraft-console-in";
const LOG_PATH = "/data/logs/latest.log";
const LOG_TAIL_BYTES = 20_000;
const LOG_POLL_MS = 1000;
const MC_STATUS_CACHE_MS = 8000;

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

const requireAuth = () => true;

const isTruthy = (value: string | undefined) => {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const normalizeConsoleCommand = (command: string) =>
  command.replace(/\r?\n/g, " ").trim();

const getLogTailBytes = (value: string | null) => {
  if (!value) return LOG_TAIL_BYTES;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return LOG_TAIL_BYTES;
  return Math.max(0, parsed);
};

const getLogPollMs = (value: string | null) => {
  if (!value) return LOG_POLL_MS;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return LOG_POLL_MS;
  return Math.max(250, parsed);
};

const getMCServerPort = () => {
  const port = Number.parseInt(
    env.MC_SERVER_PORT ?? env.SERVER_PORT ?? "25565",
    10,
  );
  return Number.isNaN(port) ? 25565 : port;
};

const getControlPort = () => {
  const port = Number.parseInt(
    env.CONTROL_PORT ?? env.APP_PORT ?? "3000",
    10,
  );
  return Number.isNaN(port) ? 3000 : port;
};

type ConsoleLogSocketData = {
  tailBytes: number;
  position: number;
  buffer: string;
  watcher: ReturnType<typeof watch> | null;
  interval: ReturnType<typeof setInterval> | null;
  pumping: boolean;
};

type StatusSnapshot = {
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
};

const createBaseStatusSnapshot = (): StatusSnapshot => ({
  host: env.MC_SERVER_HOST,
  port: getMCServerPort(),
  publicAddress:
    env.RAILWAY_TCP_PROXY_DOMAIN && env.RAILWAY_TCP_PROXY_PORT
      ? `${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}`
      : null,
  motd: null,
  version: null,
  latency: null,
  players: { online: 0, max: 0, sample: [] },
});

let statusCache:
  | {
      data: StatusSnapshot;
      fetchedAt: number;
    }
  | null = null;
let statusInFlight: Promise<StatusSnapshot> | null = null;

const normalizeMotd = (motd: unknown) => {
  if (!motd) return null;
  if (typeof motd === "string") return motd;
  if (typeof motd === "object" && motd && "clean" in motd) {
    const clean = (motd as { clean?: string | string[] }).clean;
    if (Array.isArray(clean)) return clean.join(" ").trim();
    if (typeof clean === "string") return clean.trim();
  }
  if (typeof motd === "object" && motd && "raw" in motd) {
    const raw = (motd as { raw?: string | string[] }).raw;
    if (Array.isArray(raw)) return raw.join(" ").trim();
    if (typeof raw === "string") return raw.trim();
  }
  return null;
};

const parseStatusPayload = (statusRaw: string) => {
  try {
    return JSON.parse(statusRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const getStatusPayload = (payload: { status: Record<string, unknown> | null; statusRaw: string }) =>
  payload.status ?? parseStatusPayload(payload.statusRaw);

const extractVersionFromLog = (text: string) => {
  const patterns = [
    /Starting minecraft server version ([0-9][\w.\-]+)/i,
    /Minecraft version ([0-9][\w.\-]+)/i,
    /running (?:.+ )?version ([0-9][\w.\-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
};

const readLogTail = async (bytes = 25_000) => {
  try {
    const info = await stat(LOG_PATH);
    if (!info.isFile()) return null;
    const startAt = Math.max(0, info.size - bytes);
    return await Bun.file(LOG_PATH).slice(startAt, info.size).text();
  } catch {
    return null;
  }
};

const fetchServerStatus = async () => {
  const now = Date.now();
  if (statusCache && now - statusCache.fetchedAt < MC_STATUS_CACHE_MS) {
    return statusCache.data;
  }
  if (statusInFlight) return statusInFlight;

  statusInFlight = (async () => {
    const baseSnapshot = createBaseStatusSnapshot();

    try {
      const res = await mc.lookup({
        host: env.MC_SERVER_HOST,
        port: getMCServerPort(),
        timeout: 2500,
        ping: true,
        SRVLookup: true,
        JSONParse: true,
        throwOnParseError: false,
      });
      const statusPayload = getStatusPayload(res);
      if (!statusPayload) {
        throw new Error("Server status unavailable");
      }

      const snapshot: StatusSnapshot = {
        ...baseSnapshot,
        motd: normalizeMotd(statusPayload.description ?? statusPayload.motd),
        version:
          (statusPayload.version &&
          typeof statusPayload.version === "object" &&
          "name" in statusPayload.version
            ? (statusPayload.version as { name?: string }).name
            : statusPayload.version) ?? null,
        latency: typeof res.latency === "number" ? res.latency : null,
        players: {
          online:
            (statusPayload.players &&
            typeof statusPayload.players === "object" &&
            "online" in statusPayload.players
              ? Number((statusPayload.players as { online?: number }).online ?? 0)
              : 0) ?? 0,
          max:
            (statusPayload.players &&
            typeof statusPayload.players === "object" &&
            "max" in statusPayload.players
              ? Number((statusPayload.players as { max?: number }).max ?? 0)
              : 0) ?? 0,
          sample:
            statusPayload.players &&
            typeof statusPayload.players === "object" &&
            Array.isArray((statusPayload.players as { sample?: unknown }).sample)
              ? (statusPayload.players as { sample?: Array<{ name?: string } | string> }).sample
                  ?.map((player) => (typeof player === "string" ? player : player.name))
                  .filter((value): value is string => Boolean(value))
              : [],
        },
      };

      statusCache = { data: snapshot, fetchedAt: Date.now() };
      statusInFlight = null;
      return snapshot;
    } catch (error) {
      let snapshot = { ...baseSnapshot };

      // No protocol fallback available; rely on log-based version extraction.

      if (!snapshot.version) {
        const tail = await readLogTail();
        if (tail) {
          snapshot = { ...snapshot, version: extractVersionFromLog(tail) };
        }
      }

      statusCache = { data: snapshot, fetchedAt: Date.now() };
      statusInFlight = null;
      return snapshot;
    }

  })();

  try {
    return await statusInFlight;
  } finally {
    statusInFlight = null;
  }
};

const sendLogLine = (ws: ServerWebSocket<ConsoleLogSocketData>, line: string) => {
  try {
    ws.send(line);
  } catch {
    // ignore
  }
};

const pumpLog = async (
  ws: ServerWebSocket<ConsoleLogSocketData>,
  opts: { resetToTail?: boolean } = {},
) => {
  if (ws.data.pumping) return;
  ws.data.pumping = true;
  try {
    let info;
    try {
      info = await stat(LOG_PATH);
    } catch {
      return;
    }

    if (!info.isFile()) return;

    if (opts.resetToTail) {
      ws.data.position = Math.max(0, info.size - ws.data.tailBytes);
      ws.data.buffer = "";
    }

    if (info.size < ws.data.position) {
      // Log rotated/truncated.
      ws.data.position = Math.max(0, info.size - ws.data.tailBytes);
      ws.data.buffer = "";
    }

    if (info.size === ws.data.position) return;

    const chunk = await Bun.file(LOG_PATH).slice(ws.data.position, info.size).text();
    ws.data.position = info.size;
    ws.data.buffer += chunk;

    const lines = ws.data.buffer.split(/\r?\n/);
    ws.data.buffer = lines.pop() ?? "";
    for (const line of lines) {
      sendLogLine(ws, line);
    }
  } finally {
    ws.data.pumping = false;
  }
};

const normalizeRelativePath = (value: string | null) => {
  const raw = value ?? "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+/g, "/");
};

const resolveSafePath = (value: string | null) => {
  const relative = normalizeRelativePath(value);
  const resolved = path.resolve(FILES_ROOT, `.${relative}`);
  const rootWithSep = FILES_ROOT.endsWith(path.sep)
    ? FILES_ROOT
    : `${FILES_ROOT}${path.sep}`;

  if (resolved !== FILES_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error("Invalid path.");
  }

  return { relative, resolved };
};

const ensureAuth = () => {
  if (!requireAuth()) {
    return json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
};

const server = Bun.serve({
  port: getControlPort(),
  maxRequestBodySize: MAX_UPLOAD_BYTES,
  routes: {
    "/api/files": {
      GET: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        try {
          const { searchParams } = new URL(req.url);
          const { relative, resolved } = resolveSafePath(
            searchParams.get("path"),
          );
          const info = await stat(resolved);
          if (!info.isDirectory()) {
            return json({ error: "Path is not a folder." }, { status: 400 });
          }

          const entries = await readdir(resolved, { withFileTypes: true });
          const items = await Promise.all(
            entries.map(async (entry) => {
              const fullPath = path.join(resolved, entry.name);
              const info = await stat(fullPath);
              return {
                name: entry.name,
                path: path.posix.join(relative, entry.name),
                type: entry.isDirectory() ? "dir" : "file",
                size: info.size,
                mtime: info.mtime.toISOString(),
              };
            }),
          );

          items.sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === "dir" ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });

          return json({ path: relative, entries: items });
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : "List failed." },
            { status: 400 },
          );
        }
      },
      DELETE: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        try {
          const { searchParams } = new URL(req.url);
          const { relative, resolved } = resolveSafePath(
            searchParams.get("path"),
          );
          if (resolved === FILES_ROOT) {
            return json({ error: "Refusing to delete root." }, { status: 400 });
          }

          const targetInfo = await stat(resolved);
          if (targetInfo.isDirectory()) {
            await rm(resolved, { recursive: true, force: true });
          } else {
            await rm(resolved, { force: true });
          }

          return json({ ok: true, path: relative });
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : "Delete failed." },
            { status: 400 },
          );
        }
      },
    },
    "/api/files/content": {
      GET: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        try {
          const { searchParams } = new URL(req.url);
          const { relative, resolved } = resolveSafePath(
            searchParams.get("path"),
          );
          const info = await stat(resolved);

          if (!info.isFile()) {
            return json({ error: "Path is not a file." }, { status: 400 });
          }

          if (info.size > MAX_PREVIEW_BYTES) {
            return json(
              { error: "File too large to preview." },
              { status: 413 },
            );
          }

          const file = Bun.file(resolved);
          const sample = new Uint8Array(
            await file.slice(0, 1024).arrayBuffer(),
          );

          if (sample.includes(0)) {
            return json(
              { error: "Binary file preview is not supported." },
              { status: 415 },
            );
          }

          const content = await file.text();
          return json({ path: relative, content });
        } catch (error) {
          return json(
            {
              error: error instanceof Error ? error.message : "Preview failed.",
            },
            { status: 400 },
          );
        }
      },
    },
    "/api/files/upload": {
      POST: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        try {
          const { searchParams } = new URL(req.url);
          const { relative, resolved } = resolveSafePath(
            searchParams.get("path"),
          );
          const fileNameHeader = req.headers.get("x-file-name");
          const safeName = path.basename(fileNameHeader || "upload.bin");
          const destinationRelative = path.posix.join(relative, safeName);
          const { resolved: destination } = resolveSafePath(destinationRelative);

          if (!req.body) {
            return json({ error: "Missing upload body." }, { status: 400 });
          }

          const response = new Response(req.body);
          await Bun.write(destination, response);

          return json({ ok: true, path: destinationRelative });
        } catch (error) {
          return json(
            {
              error: error instanceof Error ? error.message : "Upload failed.",
            },
            { status: 400 },
          );
        }
      },
    },
    "/api/console": {
      POST: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        try {
          const body = (await req.json()) as { command?: string };
          const command = normalizeConsoleCommand(body.command ?? "");

          if (!command) {
            return json({ error: "Command is required." }, { status: 400 });
          }

          if (!isTruthy(env.CREATE_CONSOLE_IN_PIPE)) {
            return json(
              {
                error:
                  "CREATE_CONSOLE_IN_PIPE must be set to true to use the console pipe.",
              },
              { status: 400 },
            );
          }

          const info = await stat(CONSOLE_PIPE);
          if (!info.isFIFO()) {
            return json(
              { error: "Console pipe is not available." },
              { status: 400 },
            );
          }

          await Bun.write(CONSOLE_PIPE, `${command}\n`);
          return json({ ok: true });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Console command failed.",
            },
            { status: 400 },
          );
        }
      },
    },
    "/api/server/status": {
      GET: async () => {
        const authError = ensureAuth();
        if (authError) return authError;
        try {
          const data = await fetchServerStatus();
          const cached =
            statusCache &&
            Date.now() - statusCache.fetchedAt < MC_STATUS_CACHE_MS + 250;
          return json({
            ok: true,
            data,
            cached,
            fetchedAt: statusCache?.fetchedAt ?? Date.now(),
          });
        } catch (error) {
          if (statusCache) {
            return json({
              ok: true,
              data: statusCache.data,
              cached: true,
              stale: true,
              error: error instanceof Error ? error.message : "Status ping failed.",
              fetchedAt: statusCache.fetchedAt,
            });
          }
          return json({
            ok: true,
            data: createBaseStatusSnapshot(),
            cached: false,
            stale: true,
            error: error instanceof Error ? error.message : "Status ping failed.",
            fetchedAt: Date.now(),
          });
        }
      },
    },
    "/api/console/ws": {
      GET: (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        const { searchParams } = new URL(req.url);
        const tailBytes = getLogTailBytes(searchParams.get("tail"));

        const upgraded = server.upgrade(req, {
          data: {
            tailBytes,
            position: 0,
            buffer: "",
            watcher: null,
            interval: null,
            pumping: false,
          } satisfies ConsoleLogSocketData,
        });

        if (upgraded) return;
        return new Response("Upgrade failed.", { status: 400 });
      },
    },
    "/api/console/logs": {
      GET: async (req) => {
        const authError = ensureAuth();
        if (authError) return authError;

        const { searchParams } = new URL(req.url);
        const tailBytes = getLogTailBytes(searchParams.get("tail"));
        const pollMs = getLogPollMs(searchParams.get("poll"));

        let buffer = "";
        let position = 0;
        let closed = false;
        let interval: ReturnType<typeof setInterval> | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();

            const sendLine = (line: string) => {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            };

            const sendComment = (value: string) => {
              controller.enqueue(encoder.encode(`: ${value}\n\n`));
            };

            const pump = async () => {
              if (closed) return;
              try {
                let info;
                try {
                  info = await stat(LOG_PATH);
                } catch {
                  return;
                }

                if (!info.isFile()) {
                  return;
                }

                if (info.size < position) {
                  position = 0;
                  buffer = "";
                }

                if (info.size === position) {
                  return;
                }

                const chunk = await Bun.file(LOG_PATH)
                  .slice(position, info.size)
                  .text();
                position = info.size;
                buffer += chunk;

                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  sendLine(line);
                }
              } catch {
                return;
              }
            };

            const init = async () => {
              sendComment("connected");
              try {
                const info = await stat(LOG_PATH);
                if (info.isFile()) {
                  const startAt = Math.max(0, info.size - tailBytes);
                  position = startAt;
                  await pump();
                }
              } catch {
                // File may not be ready yet; keep polling.
              }
              interval = setInterval(() => {
                void pump();
              }, pollMs);
            };

            void init();
          },
          cancel() {
            closed = true;
            if (interval) clearInterval(interval);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
    "/*": index,
  },
  websocket: {
    open(ws) {
      // Only the /api/console/ws route upgrades with our data shape.
      const data = ws.data as ConsoleLogSocketData;
      if (!data || typeof data.tailBytes !== "number") return;

      void pumpLog(ws as ServerWebSocket<ConsoleLogSocketData>, { resetToTail: true });

      // Prefer filesystem events; keep a slow interval as a reliability backstop.
      try {
        data.watcher = watch(
          LOG_PATH,
          { persistent: false },
          () => void pumpLog(ws as ServerWebSocket<ConsoleLogSocketData>),
        );
      } catch {
        data.watcher = null;
      }

      data.interval = setInterval(() => {
        void pumpLog(ws as ServerWebSocket<ConsoleLogSocketData>);
      }, Math.max(750, LOG_POLL_MS));
    },
    close(ws) {
      const data = ws.data as ConsoleLogSocketData;
      if (!data) return;
      if (data.interval) clearInterval(data.interval);
      data.interval = null;
      if (data.watcher) data.watcher.close();
      data.watcher = null;
    },
  },
});

console.log(`🚀 Server running at ${server.url}`);
