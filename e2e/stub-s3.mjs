// e2e 用零依赖桩 S3：接受任意 SigV4 签名请求（不校验），PUT/GET/DELETE/HEAD
// 落到 e2e/.tmp/s3/ 目录。由 run-server.sh 与 api 同进程组启动。
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), ".tmp", "s3");
mkdirSync(root, { recursive: true });

// URL 形如 /bucket/prefix/materials/xxx.ext（path-style）；取 bucket 之后的路径做对象键
function keyOf(url) {
  const path = normalize(decodeURIComponent(new URL(url, "http://x").pathname)).replace(/^\/+/, "");
  return join(root, path);
}

const server = createServer((req, res) => {
  const key = keyOf(req.url);
  try {
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        mkdirSync(dirname(key), { recursive: true });
        writeFileSync(key, Buffer.concat(chunks));
        res.writeHead(200, { "ETag": '"e2e-stub-etag"' });
        res.end();
      });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (!existsSync(key)) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      const body = req.method === "HEAD" ? null : readFileSync(key);
      res.writeHead(200, { "Content-Length": statSync(key).size });
      res.end(body);
      return;
    }
    if (req.method === "DELETE") {
      rmSync(key, { force: true });
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  } catch {
    res.writeHead(500);
    res.end();
  }
});

server.listen(3102, "127.0.0.1", () => console.log("stub-s3 on :3102"));
