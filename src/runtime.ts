import { CONNECTOR_NAME } from "./constants.js";
import type { Config } from "./config.js";
import { TtlCache } from "./cache.js";
import { HttpClient } from "./http.js";
import { createLogger, type Logger } from "./log.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { setRevealLinkTokens } from "./redact.js";

export interface Runtime {
  config: Config;
  client: HttpClient;
  secrets: readonly string[];
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  setRevealLinkTokens(config.revealLinkTokens);
  const now = overrides.now ?? Date.now;
  const secrets = config.token === undefined ? [] : [config.token];
  const logger = overrides.logger ?? createLogger(secrets);
  const client = new HttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: overrides.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    token: config.token,
    label: CONNECTOR_NAME,
  });
  return {
    config,
    client,
    secrets,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}
