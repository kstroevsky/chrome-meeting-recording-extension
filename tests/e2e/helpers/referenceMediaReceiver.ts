import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

export type ReferenceMediaReceiverConfig = {
  webhookSecret: string;
  mediaBearer: string;
  s3: {
    endpoint: string;
    bucket: string;
    region?: string;
    forcePathStyle?: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    uploadOrigin: string;
  };
  uploadUrlTtlSeconds?: number;
  playbackUrlTtlSeconds?: number;
  uploadAttemptTtlMs?: number;
  partSignResponseDelayMsOnce?: number;
  partSizeBytes?: number;
  capabilityApiBase?: string;
  cleanupOnExit?: boolean;
};

export type ReferenceMediaReceiverProcess = {
  origin: string;
  webhookUrl: string;
  statePath: string;
  stop(): Promise<void>;
  crash(): Promise<void>;
  restart(overrides?: Partial<ReferenceMediaReceiverConfig>): Promise<void>;
};

export async function startReferenceMediaReceiverProcess(
  workDir: string,
  config: ReferenceMediaReceiverConfig,
): Promise<ReferenceMediaReceiverProcess> {
  await fs.mkdir(workDir, { recursive: true });
  const tls = await createSelfSignedCertificate(workDir);
  const port = await reservePort();
  const origin = `https://127.0.0.1:${port}`;
  const statePath = path.join(workDir, "receiver-state.json");
  let child: ChildProcess | null = null;
  let currentConfig = config;

  const launch = async () => {
    if (child) throw new Error("Reference media receiver is already running");
    const cli = path.resolve(process.cwd(), "reference-media-receiver/src/cli.mjs");
    const next = spawn(process.execPath, [cli], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        TLS_KEY_PATH: tls.keyPath,
        TLS_CERT_PATH: tls.certPath,
        STATE_PATH: statePath,
        WEBHOOK_SECRET: currentConfig.webhookSecret,
        MEDIA_BEARER: currentConfig.mediaBearer,
        S3_ENDPOINT: currentConfig.s3.endpoint,
        S3_BUCKET: currentConfig.s3.bucket,
        S3_REGION: currentConfig.s3.region ?? "auto",
        S3_FORCE_PATH_STYLE: currentConfig.s3.forcePathStyle ? "true" : "false",
        S3_UPLOAD_ORIGIN: currentConfig.s3.uploadOrigin,
        AWS_ACCESS_KEY_ID: currentConfig.s3.accessKeyId,
        AWS_SECRET_ACCESS_KEY: currentConfig.s3.secretAccessKey,
        ...(currentConfig.uploadUrlTtlSeconds
          ? { UPLOAD_URL_TTL_SECONDS: String(currentConfig.uploadUrlTtlSeconds) }
          : {}),
        ...(currentConfig.playbackUrlTtlSeconds
          ? { PLAYBACK_URL_TTL_SECONDS: String(currentConfig.playbackUrlTtlSeconds) }
          : {}),
        ...(currentConfig.uploadAttemptTtlMs
          ? { UPLOAD_ATTEMPT_TTL_MS: String(currentConfig.uploadAttemptTtlMs) }
          : {}),
        ...(currentConfig.partSignResponseDelayMsOnce
          ? { PART_SIGN_RESPONSE_DELAY_MS_ONCE: String(currentConfig.partSignResponseDelayMsOnce) }
          : {}),
        ...(currentConfig.partSizeBytes
          ? { PART_SIZE_BYTES: String(currentConfig.partSizeBytes) }
          : {}),
        ...(currentConfig.capabilityApiBase
          ? { CONFORMANCE_CAPABILITY_API_BASE: currentConfig.capabilityApiBase }
          : {}),
        CLEANUP_ON_EXIT: currentConfig.cleanupOnExit === false ? "0" : "1",
      },
    });
    child = next;
    await waitForReady(next, origin);
  };

  const terminate = async (signal: NodeJS.Signals) => {
    const running = child;
    if (!running) return;
    child = null;
    running.kill(signal);
    await waitForExit(running, signal === "SIGKILL" ? 5_000 : 15_000);
  };

  await launch();
  return {
    origin,
    webhookUrl: `${origin}/webhook`,
    statePath,
    stop: () => terminate("SIGTERM"),
    crash: () => terminate("SIGKILL"),
    async restart(overrides = {}) {
      await terminate("SIGTERM");
      currentConfig = {
        ...currentConfig,
        ...overrides,
        s3: overrides.s3 ?? currentConfig.s3,
      };
      await launch();
    },
  };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a receiver port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function createSelfSignedCertificate(
  workDir: string,
): Promise<{ keyPath: string; certPath: string }> {
  const keyPath = path.join(workDir, "reference-receiver.key");
  const certPath = path.join(workDir, "reference-receiver.crt");
  const configPath = path.join(workDir, "reference-receiver-openssl.cnf");
  await fs.writeFile(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-config",
      configPath,
    ],
    { stdio: "ignore" },
  );
  return { keyPath, certPath };
}

async function waitForReady(child: ChildProcess, origin: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Reference receiver did not become ready at ${origin}: ${stderr.slice(-2000)}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(`Reference media receiver listening at ${origin}`)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Reference receiver exited before startup (code ${code}): ${stderr.slice(-2000)}`));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Reference receiver did not stop in time"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
