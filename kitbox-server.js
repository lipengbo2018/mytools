const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 4174);
const uploadPassword = process.env.KITBOX_UPLOAD_PASSWORD;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("配置格式无效");
  }
  const categories = Array.isArray(config.categories) ? config.categories : [];
  const tools = Array.isArray(config.tools) ? config.tools : [];
  return {
    version: 1,
    categories: categories
      .filter((item) => item && item.name)
      .map((item) => ({
        id: String(item.id || ""),
        name: String(item.name).trim(),
      })),
    tools: tools
      .filter((item) => item && item.name && item.url)
      .map((item) => ({
        id: String(item.id || ""),
        name: String(item.name).trim(),
        url: String(item.url).trim(),
        categoryIds: Array.isArray(item.categoryIds)
          ? item.categoryIds.map((id) => String(id)).filter(Boolean)
          : [],
        isFavorite: Boolean(item.isFavorite),
      })),
  };
}

async function handleUpload(request, response) {
  if (!uploadPassword) {
    sendJson(response, 500, { message: "服务端未配置上传口令" });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request));
    if (body.password !== uploadPassword) {
      sendJson(response, 403, { message: "口令错误" });
      return;
    }

    const config = normalizeConfig(body.config);
    const targetPath = path.join(rootDir, "mytools.default.json");
    fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    sendJson(response, 200, {
      message: "默认配置已更新",
      categories: config.categories.length,
      tools: config.tools.length,
    });
  } catch (error) {
    sendJson(response, 400, { message: error.message || "上传失败" });
  }
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(rootDir, safePath));

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/default-config") {
    handleUpload(request, response);
    return;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response);
    return;
  }
  response.writeHead(405);
  response.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`KitBox server running at http://localhost:${port}/mytools.html`);
});
