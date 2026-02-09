import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CREATE_CONSOLE_IN_PIPE: z.string().optional(),
    MC_SERVER_HOST: z.string().default("127.0.0.1"),
    MC_SERVER_PORT: z.string().optional(),
    SERVER_PORT: z.string().optional(),
    RAILWAY_TCP_PROXY_DOMAIN: z.string().default(""),
    RAILWAY_TCP_PROXY_PORT: z.string().default(""),
    CONTROL_PORT: z.string().optional(),
    APP_PORT: z.string().optional(),
    RCON_HOST: z.string().optional(),
    RCON_PORT: z.string().optional(),
    RCON_PASSWORD: z.string().optional(),
    RAILWAY_CLIENT_ID: z.string().optional(),
    RAILWAY_CLIENT_SECRET: z.string().optional(),
  },
  runtimeEnv: Bun.env,
  emptyStringAsUndefined: true,
});
