import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI, { toFile } from "openai";
import dotenv from "dotenv";
import fetch, { Headers } from "node-fetch";
import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

if (!globalThis.fetch) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  globalThis.fetch = fetch;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  globalThis.Headers = Headers;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
app.set("trust proxy", true);

const LOG_PREFIX = "[image-server]";
const maskSecret = (value: string | null | undefined) => {
  if (!value) {
    return "missing";
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    const errorWithExtras = error as Error & {
      status?: number;
      code?: string;
      type?: string;
      cause?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      status: errorWithExtras.status ?? null,
      code: errorWithExtras.code ?? null,
      type: errorWithExtras.type ?? null,
      cause:
        typeof errorWithExtras.cause === "string"
          ? errorWithExtras.cause
          : undefined,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
};

const logInfo = (event: string, details?: Record<string, unknown>) => {
  console.log(`${LOG_PREFIX} ${event}`, details ?? {});
};

const logError = (event: string, error: unknown, details?: Record<string, unknown>) => {
  console.error(`${LOG_PREFIX} ${event}`, {
    ...(details ?? {}),
    error: serializeError(error),
  });
};

const getRequestId = (req: Request) => req.header("x-request-id") ?? crypto.randomUUID();
const trimPromptForLog = (prompt: unknown) => String(prompt ?? "").trim().slice(0, 120);
const hasServerOpenAIKey = String(process.env.OPENAI_API_KEY ?? "").trim().length > 0;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = getRequestId(req);
  res.locals.requestId = requestId;
  const startedAt = Date.now();
  logInfo("request.start", {
    requestId,
    method: req.method,
    path: req.path,
    contentLength: req.header("content-length") ?? null,
  });
  res.on("finish", () => {
    logInfo("request.finish", {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.join(__dirname, "uploads")
);
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use("/images", express.static(UPLOADS_DIR));

const getOpenAIClient = (tokenFromRequest: unknown): OpenAI | null => {
  const token = String(
    (process.env.OPENAI_API_KEY ?? tokenFromRequest ?? "")
  ).trim();
  if (!token || token.length < 10) {
    return null;
  }
  return new OpenAI({ apiKey: token });
};

const getBaseUrl = (req: express.Request): string => {
  const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  if (configuredBaseUrl.length > 0) {
    return configuredBaseUrl;
  }
  return `${req.protocol}://${req.get("host")}`;
};

const saveBase64AsImage = (b64: string): string => {
  const filename = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), b64, "base64");
  logInfo("image.saved", {
    filename,
    bytesApprox: Math.round((b64.length * 3) / 4),
  });
  return filename;
};

// Fetch a remote URL and return its buffer + content-type.
// For URLs served by our own /images route, read from disk directly.
const urlToBuffer = async (
  url: string
): Promise<{ buffer: Buffer; contentType: string }> => {
  const localMatch = url.match(/\/images\/([^/?#]+)$/);
  if (localMatch) {
    const filepath = path.join(UPLOADS_DIR, localMatch[1]);
    if (fs.existsSync(filepath)) {
      logInfo("image.load.local", {
        filename: localMatch[1],
      });
      return { buffer: fs.readFileSync(filepath), contentType: "image/png" };
    }
  }
  logInfo("image.fetch.remote.start", { url });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "image/png";
  logInfo("image.fetch.remote.success", {
    url,
    contentType,
    bytes: buffer.length,
  });
  return { buffer, contentType };
};

app.post("/imagine-variations", async (req, res) => {
  const { prompt, openaiToken } = req.body;
  const requestId = res.locals.requestId as string;

  const openai = getOpenAIClient(openaiToken);
  if (!openai) {
    logInfo("imagine.auth.invalid", {
      requestId,
      usingServerKey: hasServerOpenAIKey,
      requestKeyPreview: maskSecret(String(openaiToken ?? "").trim()),
    });
    res.status(400).json({
      error:
        "Missing or invalid OpenAI API key. Set OPENAI_API_KEY on the server or provide it via the Settings UI.",
    });
    return;
  }

  try {
    logInfo("imagine.start", {
      requestId,
      promptPreview: trimPromptForLog(prompt),
      usingServerKey: hasServerOpenAIKey,
    });
    const result = await openai.images.generate({
      model: "gpt-image-1.5",
      prompt,
      n: 4,
      size: "1024x1024",
      quality: "medium",
    });

    const baseUrl = getBaseUrl(req);
    const urls = (result.data ?? [])
      .filter((item) => item.b64_json != null)
      .map((item) => {
        const filename = saveBase64AsImage(item.b64_json!);
        return `${baseUrl}/images/${filename}`;
      });
    logInfo("imagine.success", {
      requestId,
      outputCount: urls.length,
    });
    res.json({ variations: urls });
  } catch (error: any) {
    logError("imagine.error", error, {
      requestId,
      promptPreview: trimPromptForLog(prompt),
    });
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

app.post("/image-to-image-variations", async (req, res) => {
  const { prompt, url, openaiToken } = req.body;
  const requestId = res.locals.requestId as string;

  const openai = getOpenAIClient(openaiToken);
  if (!openai) {
    logInfo("image_to_image.auth.invalid", {
      requestId,
      usingServerKey: hasServerOpenAIKey,
      requestKeyPreview: maskSecret(String(openaiToken ?? "").trim()),
    });
    res.status(400).json({
      error:
        "Missing or invalid OpenAI API key. Set OPENAI_API_KEY on the server or provide it via the Settings UI.",
    });
    return;
  }

  try {
    logInfo("image_to_image.start", {
      requestId,
      promptPreview: trimPromptForLog(prompt),
      sourceUrl: url,
    });
    const { buffer, contentType } = await urlToBuffer(url);
    const imageFile = await toFile(buffer, "input.png", { type: contentType });

    const result = await openai.images.edit({
      model: "gpt-image-1.5",
      image: imageFile,
      prompt,
      n: 1,
      size: "1024x1024",
    });

    const baseUrl = getBaseUrl(req);
    const urls = (result.data ?? [])
      .filter((item) => item.b64_json != null)
      .map((item) => {
        const filename = saveBase64AsImage(item.b64_json!);
        return `${baseUrl}/images/${filename}`;
      });
    logInfo("image_to_image.success", {
      requestId,
      outputCount: urls.length,
    });
    res.json({ variations: urls });
  } catch (error: any) {
    logError("image_to_image.error", error, {
      requestId,
      promptPreview: trimPromptForLog(prompt),
      sourceUrl: url,
    });
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

// OpenAI has no direct upscaler; pass the original URL through so the UX
// (adding the image as a separate canvas node) still works as expected.
app.post("/upscale", async (req, res) => {
  const { url } = req.body;
  const requestId = res.locals.requestId as string;
  logInfo("upscale.passthrough", {
    requestId,
    sourceUrl: url,
  });
  res.json({ upscaled: url });
});

app.post("/sketch-to-image-variations", async (req, res) => {
  const { url, prompt, openaiToken } = req.body;
  const requestId = res.locals.requestId as string;

  const openai = getOpenAIClient(openaiToken);
  if (!openai) {
    logInfo("sketch_to_image.auth.invalid", {
      requestId,
      usingServerKey: hasServerOpenAIKey,
      requestKeyPreview: maskSecret(String(openaiToken ?? "").trim()),
    });
    res.status(400).json({
      error:
        "Missing or invalid OpenAI API key. Set OPENAI_API_KEY on the server or provide it via the Settings UI.",
    });
    return;
  }

  try {
    logInfo("sketch_to_image.start", {
      requestId,
      promptPreview: trimPromptForLog(prompt),
      sourceUrl: url,
    });
    const { buffer, contentType } = await urlToBuffer(url);
    const imageFile = await toFile(buffer, "sketch.png", { type: contentType });

    const result = await openai.images.edit({
      model: "gpt-image-1.5",
      image: imageFile,
      prompt: `Transform this sketch into a detailed, high-quality image: ${prompt}`,
      n: 1,
      size: "1024x1024",
    });

    const baseUrl = getBaseUrl(req);
    const urls = (result.data ?? [])
      .filter((item) => item.b64_json != null)
      .map((item) => {
        const filename = saveBase64AsImage(item.b64_json!);
        return `${baseUrl}/images/${filename}`;
      });
    logInfo("sketch_to_image.success", {
      requestId,
      outputCount: urls.length,
    });
    res.json({ variations: urls });
  } catch (error: any) {
    logError("sketch_to_image.error", error, {
      requestId,
      promptPreview: trimPromptForLog(prompt),
      sourceUrl: url,
    });
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

// Upload a base64-encoded image (from canvas saves) and return a hosted URL.
app.post("/upload", async (req, res) => {
  const { imageData, mimeType = "image/png" } = req.body;
  const requestId = res.locals.requestId as string;
  if (!imageData) {
    logInfo("upload.invalid", {
      requestId,
      reason: "missing imageData",
    });
    res.status(400).json({ error: "Missing imageData field" });
    return;
  }
  try {
    const ext = String(mimeType).split("/")[1]?.split("+")[0] || "png";
    const filename = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(
      path.join(UPLOADS_DIR, filename),
      String(imageData),
      "base64"
    );
    const baseUrl = getBaseUrl(req);
    logInfo("upload.success", {
      requestId,
      filename,
      mimeType,
    });
    res.json({ url: `${baseUrl}/images/${filename}` });
  } catch (error: any) {
    logError("upload.error", error, {
      requestId,
      mimeType,
    });
    res.status(500).json({ error: error.message ?? String(error) });
  }
});

const clientDistDir = path.resolve(__dirname, "../../dist");
const clientIndexHtmlPath = path.join(clientDistDir, "index.html");
if (fs.existsSync(clientIndexHtmlPath)) {
  app.use(express.static(clientDistDir));
  app.get("*", (_req, res) => {
    res.sendFile(clientIndexHtmlPath);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logInfo("startup", {
    port: PORT,
    serverOpenAIKey: maskSecret(String(process.env.OPENAI_API_KEY ?? "").trim()),
    uploadsDir: UPLOADS_DIR,
    clientDistExists: fs.existsSync(clientIndexHtmlPath),
    runningOnVercel: Boolean(process.env.VERCEL),
  });
  console.log(`Server is running on http://localhost:${PORT}`);
});
