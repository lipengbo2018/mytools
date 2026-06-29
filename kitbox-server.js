const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
  });
  response.end();
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
  try {
    const config = await readAuthorizedConfig(request);
    writeDefaultConfig(config);
    sendJson(response, 200, {
      message: "默认配置已更新",
      categories: config.categories.length,
      tools: config.tools.length,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { message: error.message || "上传失败" });
  }
}

async function handleDeploy(request, response) {
  try {
    const config = await readAuthorizedConfig(request);
    writeDefaultConfig(config);
    const statusBeforeCommit = await runGit(["status", "--short"]);
    if (!statusBeforeCommit.stdout.includes("mytools.default.json")) {
      sendJson(response, 200, {
        message: "默认配置无变化，无需部署",
        categories: config.categories.length,
        tools: config.tools.length,
      });
      return;
    }

    await runGit(["add", "mytools.default.json"]);
    const hasStagedChanges = await hasGitStagedChanges();
    if (!hasStagedChanges) {
      sendJson(response, 200, {
        message: "默认配置无变化，无需部署",
        categories: config.categories.length,
        tools: config.tools.length,
      });
      return;
    }

    const commitMessage = `Update default config ${new Date().toISOString().slice(0, 10)}`;
    await runGit(["commit", "-m", commitMessage]);
    await runGit(["push"]);
    const latestCommit = await runGit(["rev-parse", "--short", "HEAD"]);
    sendJson(response, 200, {
      message: "默认配置已提交并推送，GitHub Pages 将自动部署",
      categories: config.categories.length,
      tools: config.tools.length,
      commit: latestCommit.stdout.trim(),
      pagesUrl: "https://lipengbo2018.github.io/mytools/",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { message: error.message || "部署失败" });
  }
}

async function readAuthorizedConfig(request) {
  if (!uploadPassword) {
    throw new Error("服务端未配置上传口令");
  }

  const body = JSON.parse(await readRequestBody(request));
  if (body.password !== uploadPassword) {
    const error = new Error("口令错误");
    error.statusCode = 403;
    throw error;
  }

  return normalizeConfig(body.config);
}

function writeDefaultConfig(config) {
  const targetPath = path.join(rootDir, "mytools.default.json");
  fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: rootDir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function hasGitStagedChanges() {
  try {
    await runGit(["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
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
      "Access-Control-Allow-Origin": "*",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    sendOptions(response);
    return;
  }
  if (request.method === "POST" && request.url === "/api/default-config") {
    handleUpload(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/api/deploy-config") {
    handleDeploy(request, response);
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
