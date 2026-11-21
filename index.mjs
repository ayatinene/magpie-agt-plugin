import {
  DEFAULT_BASE_URL,
  getDiscoveredModels,
  normalizeBaseUrl,
  reconcileModels,
  resolveAuth,
} from "./lib/models.mjs";
import { getAgtUsage } from "./lib/quota.mjs";
import { createAgtFetch } from "./lib/fetch.mjs";

export const OFFICIAL_ICON_URL =
  "https://raw.githubusercontent.com/lbjlaq/Antigravity-Manager/main/src-tauri/icons/128x128.png";

function coerceBool(val, fallback) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
  }
  return fallback;
}

function coerceNonNegativeNum(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readLiveOptions(input, staticOptions) {
  const m = input?.magpie;
  const rawFromOpts =
    typeof m?.options === "function" ? (m.options("agt") ?? m.options()) : undefined;
  const uiOpts = rawFromOpts && typeof rawFromOpts === "object" ? rawFromOpts : {};

  const pickBool = (camelKey, snakeKey, fallback) => {
    if (staticOptions && camelKey in staticOptions) return coerceBool(staticOptions[camelKey], fallback);
    if (staticOptions && snakeKey in staticOptions) return coerceBool(staticOptions[snakeKey], fallback);
    if (snakeKey in uiOpts) return coerceBool(uiOpts[snakeKey], fallback);
    if (camelKey in uiOpts) return coerceBool(uiOpts[camelKey], fallback);
    if (typeof m?.option === "function") {
      try {
        const v = m.option.length <= 1 ? m.option(snakeKey) : m.option("agt", snakeKey);
        if (typeof v === "boolean") return v;
      } catch {
        // ignore
      }
    }
    return fallback;
  };

  const pickNum = (camelKey, snakeKey, fallback) => {
    if (staticOptions && camelKey in staticOptions) return coerceNonNegativeNum(staticOptions[camelKey], fallback);
    if (staticOptions && snakeKey in staticOptions) return coerceNonNegativeNum(staticOptions[snakeKey], fallback);
    if (snakeKey in uiOpts) return coerceNonNegativeNum(uiOpts[snakeKey], fallback);
    if (camelKey in uiOpts) return coerceNonNegativeNum(uiOpts[camelKey], fallback);
    if (typeof m?.option === "function") {
      try {
        const v = m.option.length <= 1 ? m.option(snakeKey) : m.option("agt", snakeKey);
        if (v !== undefined && v !== null) return coerceNonNegativeNum(v, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  };

  return {
    showAccountDetails: pickBool("showAccountDetails", "show_account_details", true),
    onlyProxyPool: pickBool("onlyProxyPool", "only_proxy_pool", true),
    refreshAgtOnUsage: pickBool("refreshAgtOnUsage", "refresh_agt_on_usage", true),
    foldEffortVariants: pickBool("foldEffortVariants", "fold_effort_variants", false),
    preserveCacheEffort: pickBool("preserveCacheEffort", "preserve_cache_effort", true),
    cacheTtlSec: pickNum("cacheTtlSec", "cache_ttl_sec", 0),
    refreshCooldownSec: pickNum("refreshCooldownSec", "refresh_cooldown_sec", 30),
    maxAccountDetails: Math.floor(pickNum("maxAccountDetails", "max_account_details", 0)),
  };
}

async function server(input, options) {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      const existing = cfg.provider.agt ?? {};
      const baseUrl = normalizeBaseUrl(existing.api || DEFAULT_BASE_URL);
      cfg.provider.agt = {
        ...existing,
        name: existing.name || "Antigravity Tools",
        npm: existing.npm || "@ai-sdk/google",
        api: existing.api || `${baseUrl}/v1beta`,
        models: existing.models ?? {},
      };
    },

    provider: {
      id: "agt",
      async models(provider, ctx) {
        const live = readLiveOptions(input, options);
        return reconcileModels(provider, ctx, {
          foldEffortVariants: live.foldEffortVariants,
        });
      },
    },

    auth: {
      provider: "agt",
      single: true,
      icon: OFFICIAL_ICON_URL,
      options: [
        {
          key: "show_account_details",
          label: "Show per-account details",
          labels: { zh: "显示各账号配额明细" },
          description:
            "Show each Antigravity Tools account's status and remaining share per pool.",
          descriptions: { zh: "显示每个 Antigravity Tools 账号的状态和各池剩余比例。" },
          default: true,
        },
        {
          key: "only_proxy_pool",
          label: "Only proxy-online accounts",
          labels: { zh: "仅统计代理池在线账号" },
          description:
            "Match the Antigravity Tools dashboard: skip accounts whose proxy is disabled when weighting pool quotas.",
          descriptions: { zh: "与 Antigravity Tools 首页一致，只统计未停用代理的在线账号。" },
          default: true,
        },
        {
          key: "refresh_agt_on_usage",
          label: "Trigger Antigravity Tools quota refresh",
          labels: { zh: "刷新用量时同步刷新 Antigravity Tools 配额" },
          description:
            "Trigger Antigravity Tools to fetch fresh upstream quotas before reading account usage (with 30s cooldown protection).",
          descriptions: { zh: "刷新卡片用量前先触发 Antigravity Tools 拉取最新配额（带 30 秒冷却防抖）。" },
          default: true,
        },
        {
          key: "fold_effort_variants",
          label: "Fold effort-suffixed models into variants",
          labels: { zh: "折叠思考强度后缀模型为变体" },
          description:
            "Hide separate -low/-medium/-high/-xhigh models and merge them into base model variants (off by default to keep both).",
          descriptions: {
            zh: "隐藏独立的 -low/-medium/-high/-xhigh 模型，合并为基础模型的思考强度变体（默认关闭，同时保留两者）。",
          },
          default: false,
        },
        {
          key: "preserve_cache_effort",
          label: "Preserve session effort for cache hits",
          labels: { zh: "后台降档对齐会话档位（保缓存）" },
          description:
            "Keep warm-prefix auxiliary requests (lowered effort with capped max output tokens) on the session's active effort level to avoid cross-model prompt cache misses.",
          descriptions: {
            zh: "命中热缓存前缀的后台辅助请求同时降低思考档位并收紧最大输出上限时，自动对齐回会话当前档位，避免跨上游模型 ID 击穿缓存。",
          },
          default: true,
        },
      ],
      methods: [
        {
          type: "api",
          label: "Antigravity Tools API Key",
          labels: { zh: "Antigravity Tools 代理密钥" },
          placeholder: "sk-...",
          prompts: [
            {
              type: "text",
              key: "baseUrl",
              message: "Antigravity Tools base URL",
              messages: { zh: "Antigravity Tools 服务地址（本机默认 http://127.0.0.1:8045）" },
              placeholder: DEFAULT_BASE_URL,
            },
            {
              type: "password",
              key: "adminToken",
              message: "Antigravity Tools Web/Admin password (for /api/accounts quota; optional)",
              messages: { zh: "Antigravity Tools 管理密码（用于读取账号池配额，留空则回退使用代理密钥）" },
              placeholder: "",
            },
          ],
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const { apiKey, baseUrl } = resolveAuth(auth);
        return {
          apiKey,
          baseURL: baseUrl,
          fetch: createAgtFetch({
            baseUrl,
            apiKey,
            getAuth,
            getOptions: () => readLiveOptions(input, options),
          }),
        };
      },

      async usage(getAuth, provider, ctx) {
        const auth = await getAuth();
        const { apiKey, baseUrl, adminToken } = resolveAuth(auth);
        const live = readLiveOptions(input, options);
        return getAgtUsage({
          baseUrl,
          apiKey,
          adminToken,
          onlyProxyPool: live.onlyProxyPool,
          showAccountDetails: live.showAccountDetails,
          maxAccountDetails: live.maxAccountDetails,
          foldEffortVariants: live.foldEffortVariants,
          refreshAgtOnUsage: live.refreshAgtOnUsage,
          cacheTtlSec: live.cacheTtlSec,
          refreshCooldownSec: live.refreshCooldownSec,
          discoveredModels:
            getDiscoveredModels(baseUrl, { foldEffortVariants: live.foldEffortVariants }) ??
            provider?.models,
          signal: ctx?.signal,
        });
      },
    },
  };
}

export default {
  id: "magpie-agt-plugin",
  server,
};
