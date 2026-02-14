FROM oven/bun:latest AS builder

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install

COPY src ./src
COPY bunfig.toml tsconfig.json postcss.config.cjs tailwind.config.ts components.json ./

RUN bunx tailwindcss -c tailwind.config.ts -i src/index.css -o src/tailwind.css --minify
RUN bun build ./src/index.ts --compile --outfile=server

FROM itzg/minecraft-server:latest

ENV CONTROL_PORT=3000

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/server ./server
COPY docker/start.sh /app/docker/start.sh

RUN chmod +x /app/docker/start.sh

ENV CREATE_CONSOLE_IN_PIPE=true

EXPOSE 3000

WORKDIR /data

ENTRYPOINT ["/app/docker/start.sh"]
