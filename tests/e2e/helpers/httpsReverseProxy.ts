import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export type HttpsReverseProxy = {
  origin: string;
  stop(): Promise<void>;
};

/**
 * Gives a local HTTP CRM API the exact HTTPS origin its media capability advertises.
 * The browser is launched with ignoreHTTPSErrors for this one-day self-signed cert.
 */
export async function startHttpsReverseProxy(
  workDir: string,
  publicOrigin: string,
  upstreamOrigin: string,
): Promise<HttpsReverseProxy> {
  const published = new URL(publicOrigin);
  const upstream = new URL(upstreamOrigin);
  if (
    published.protocol !== "https:" ||
    !["127.0.0.1", "localhost"].includes(published.hostname)
  ) {
    throw new Error("R0 CRM public origin must be loopback HTTPS");
  }
  if (
    !published.port ||
    published.pathname !== "/" ||
    published.search ||
    published.hash
  ) {
    throw new Error(
      "R0 CRM public origin must be an origin with an explicit port",
    );
  }
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    !["127.0.0.1", "localhost"].includes(upstream.hostname) ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error("R0 CRM upstream must be a loopback HTTP(S) origin");
  }

  await fs.mkdir(workDir, { recursive: true });
  const tls = await createSelfSignedCertificate(workDir);
  const sockets = new Set<import("node:stream").Duplex>();
  const server = https.createServer(tls, (request, response) => {
    const requestUrl = request.url ?? "/";
    if (!requestUrl.startsWith("/")) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("R0 CRM proxy accepts origin-form requests only");
      return;
    }
    const target = new URL(requestUrl, upstream);
    const transport = target.protocol === "https:" ? https : http;
    const proxied = transport.request(
      target,
      {
        method: request.method,
        headers: {
          ...request.headers,
          host: target.host,
          "x-forwarded-host": published.host,
          "x-forwarded-proto": "https",
        },
        ...(target.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    proxied.on("error", (error) => {
      if (!response.headersSent)
        response.writeHead(502, { "content-type": "text/plain" });
      response.end(
        `R0 CRM proxy error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    request.pipe(proxied);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(published.port), published.hostname, () => resolve());
  });

  return {
    origin: published.origin,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createSelfSignedCertificate(
  workDir: string,
): Promise<{ key: Buffer; cert: Buffer }> {
  const keyPath = path.join(workDir, "crm-r0-proxy.key");
  const certPath = path.join(workDir, "crm-r0-proxy.crt");
  const configPath = path.join(workDir, "crm-r0-proxy-openssl.cnf");
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
  return { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };
}
