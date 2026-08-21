import { buildApp } from "./app.js";
import { parseAppEnv } from "./env.js";

const env = parseAppEnv();

const app = buildApp({ logger: { level: env.LOG_LEVEL } });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
