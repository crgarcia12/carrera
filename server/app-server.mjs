import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const sourceDir = path.join(rootDir, "src", "web");

const staticDir = process.argv.includes("--dev") || !existsSync(distDir) ? sourceDir : distDir;
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const backendOrigin = process.env.BACKEND_ORIGIN ?? "https://viberacing-backend.redriver-e1f73e16.eastus.azurecontainerapps.io";
const backendUrl = new URL(backendOrigin);

const requestImpl = backendUrl.protocol === "https:" ? httpsRequest : httpRequest;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

const server = createServer((req, res) => {
  if (!req.url) {
    sendText(res, 400, "Missing request URL.");
    return;
  }

  if (isProxyRequest(req.url)) {
    proxyHttpRequest(req, res);
    return;
  }

  serveStatic(req.url, res);
});

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !isProxyRequest(req.url)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  proxyWebSocket(req, socket, head);
});

server.listen(port, () => {
  console.log(`Serving ${staticDir} on http://localhost:${port}`);
  console.log(`Proxying /health and /racehub to ${backendOrigin}`);
});

function isProxyRequest(requestUrl) {
  return requestUrl.startsWith("/health") || requestUrl.startsWith("/racehub");
}

function serveStatic(requestUrl, res) {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const requestedPath = path.resolve(staticDir, `.${pathname}`);

  if (!requestedPath.startsWith(staticDir)) {
    sendText(res, 403, "Forbidden.");
    return;
  }

  let filePath = requestedPath;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = path.join(staticDir, "index.html");
  }

  const extension = path.extname(filePath).toLowerCase();
  const shouldBypassCache = extension === ".html" || extension === ".js" || extension === ".css";
  res.writeHead(200, {
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
    "Cache-Control": shouldBypassCache ? "no-cache" : "public, max-age=300"
  });

  createReadStream(filePath).pipe(res);
}

function proxyHttpRequest(req, res) {
  const upstream = createUpstreamRequest(req.url, req.method ?? "GET", req.headers, false, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? "Bad Gateway", upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    sendText(res, 502, `Upstream request failed: ${error.message}`);
  });

  req.pipe(upstream);
}

function proxyWebSocket(req, clientSocket, head) {
  const upstream = createUpstreamRequest(req.url ?? "/racehub", "GET", req.headers, true);

  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const responseLines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          responseLines.push(`${name}: ${item}`);
        }
        continue;
      }

      if (value !== undefined) {
        responseLines.push(`${name}: ${value}`);
      }
    }

    clientSocket.write(`${responseLines.join("\r\n")}\r\n\r\n`);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    if (upstreamHead.length > 0) {
      clientSocket.write(upstreamHead);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
  });

  upstream.on("response", (upstreamRes) => {
    clientSocket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Bad Gateway"}\r\n\r\n`);
    upstreamRes.pipe(clientSocket);
  });

  upstream.on("error", (error) => {
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUpstream WebSocket failed: ${error.message}`);
    clientSocket.destroy();
  });

  upstream.end();
}

function createUpstreamRequest(requestUrl, method, sourceHeaders, isUpgrade, onResponse) {
  const url = new URL(requestUrl, backendUrl);
  const headers = createProxyHeaders(sourceHeaders, isUpgrade);

  return requestImpl(
    {
      protocol: backendUrl.protocol,
      hostname: backendUrl.hostname,
      port: backendUrl.port || (backendUrl.protocol === "https:" ? 443 : 80),
      method,
      path: `${url.pathname}${url.search}`,
      headers
    },
    onResponse
  );
}

function createProxyHeaders(sourceHeaders, isUpgrade) {
  const headers = { ...sourceHeaders, host: backendUrl.host };

  delete headers.origin;
  delete headers.referer;

  if (isUpgrade) {
    headers.origin = backendUrl.origin;
  } else {
    delete headers.connection;
    delete headers.upgrade;
  }

  return headers;
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}
