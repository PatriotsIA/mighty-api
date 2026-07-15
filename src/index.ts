import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "./config";
import spacesRouter from "./routes/spaces";
import { AxiosError } from "axios";

export const app = express();

const corsOrigins =
  config.corsOrigin === "*"
    ? "*"
    : config.corsOrigin
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

// Keep CORS at the application layer; do not also configure Function URL CORS.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins === "*" || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
// Helmet after CORS
app.use(helmet());
app.use(express.json());
app.use(
  pinoHttp({
    autoLogging: true,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              translateTime: "SYS:standard",
              colorize: true,
            },
          },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/spaces", spacesRouter);

app.use(
  (
    err: Error | AxiosError,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if ((err as AxiosError).isAxiosError) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status ?? 500;
      const data = axiosErr.response?.data ?? { message: axiosErr.message };
      return res.status(status).json({
        error: "Mighty API error",
        detail: data,
      });
    }

    console.error(err);
    return res.status(500).json({ error: err.message });
  },
);

if (require.main === module) {
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Mighty API listening on port ${config.port}`);
  });

  server.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error("Server error", error);
  });
}
