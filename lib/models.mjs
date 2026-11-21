export const DEFAULT_BASE_URL = "http://127.0.0.1:8045";

const MODALITIES = ["text", "image", "audio", "video", "pdf"];
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i;
const DISPLAY_SUFFIX_RE = /\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i;
const STANDARD_VIDEO_MIME_RE =
  /^video\/(mp4|webm|quicktime|x-matroska|mpeg|ogg|3gpp|x-msvideo|avi|mov|x-flv|wmv|mp2t|h264|hevc)(?:;.*)?$/i;
const STANDARD_AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]+(?:;.*)?$/i;
const STANDARD_IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+(?:;.*)?$/i;

const modelCache = new Map();
const inFlightDiscovery = new Map();

export function clearModelCache() {
  modelCache.clear();
  inFlightDiscovery.clear();
}

export function normalizeBaseUrl(raw) {
  let url = typeof raw === "string" ? raw.trim() : "";
  if (!url) url = DEFAULT_BASE_URL;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(v1beta|v1)$/i, "");
  return url || DEFAULT_BASE_URL;
}

export function resolveAuth(auth) {
  const apiKey = typeof auth?.key === "string" ? auth.key.trim() : "";
  const rawUrl = auth?.metadata?.baseUrl ?? auth?.baseUrl ?? DEFAULT_BASE_URL;
  const baseUrl = normalizeBaseUrl(rawUrl);
  const rawAdmin =
    auth?.metadata?.adminToken ??
    auth?.metadata?.webPassword ??
    auth?.metadata?.balanceToken ??
    auth?.adminToken ??
    "";
  const adminToken = typeof rawAdmin === "string" ? rawAdmin.trim().replace(/^Bearer\s+/i, "") : "";
  return { apiKey, baseUrl, adminToken };
}

export function foldModelId(rawId) {
  const clean = String(rawId || "").trim().replace(/^models\//, "");
  const match = clean.match(EFFORT_SUFFIX_RE);
  if (match) {
    return {
      baseId: clean.slice(0, match.index),
      variant: match[1].toLowerCase(),
    };
  }
  return { baseId: clean, variant: null };
}

export function titleCaseModelId(id) {
  const upperTokens = new Set(["gpt", "oss", "ai", "api"]);
  return String(id || "")
    .split("-")
    .filter(Boolean)
    .map((tok) => {
      const lower = tok.toLowerCase();
      if (upperTokens.has(lower)) return lower.toUpperCase();
      if (/^\d+[bmkt]$/i.test(tok)) return tok.toUpperCase();
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(" ");
}

function toCapabilityModalities(list) {
  const set = new Set(Array.isArray(list) ? list : ["text"]);
  const out = {};
  for (const k of MODALITIES) out[k] = set.has(k);
  return out;
}

function firstPositive(...candidates) {
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractSupportedMimeKeys(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase());
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, enabled]) => enabled !== false)
      .map(([k]) => String(k).trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function deriveInputModalities(item) {
  const set = new Set(["text"]);
  if (item?.supports_images === true) {
    set.add("image");
  }
  const mimes = extractSupportedMimeKeys(item?.supported_mime_types);
  for (const mime of mimes) {
    if (STANDARD_IMAGE_MIME_RE.test(mime)) {
      set.add("image");
    } else if (STANDARD_AUDIO_MIME_RE.test(mime)) {
      set.add("audio");
    } else if (STANDARD_VIDEO_MIME_RE.test(mime)) {
      set.add("video");
    } else if (mime === "application/pdf" || mime.startsWith("application/pdf;")) {
      set.add("pdf");
    }
  }
  return MODALITIES.filter((m) => set.has(m));
}

function resolveProtocolSpec(baseId) {
  const lower = String(baseId || "").toLowerCase();
  if (lower.startsWith("claude")) {
    return { npm: "@ai-sdk/anthropic", apiPath: "/v1", family: "Claude" };
  }
  if (lower.startsWith("gemini") || lower.startsWith("imagen")) {
    return { npm: "@ai-sdk/google", apiPath: "/v1beta", family: "Gemini" };
  }
  const family = lower.startsWith("gpt")
    ? "GPT"
    : titleCaseModelId(lower.split("-")[0] || "OpenAI");
  return { npm: "@ai-sdk/openai-compatible", apiPath: "/v1", family };
}

function extractModelEntries(payload) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = item.id ?? item.name ?? item.model ?? "";
    if (typeof raw !== "string" || !raw.trim()) continue;
    const clean = raw.trim().replace(/^models\//, "");
    map.set(clean, item);
  }
  return map;
}

function cleanDisplayName(rawName, baseId, stripVariantSuffix = false) {
  if (typeof rawName !== "string") return "";
  let s = rawName.trim();
  if (!s) return "";
  if (stripVariantSuffix) {
    s = s.replace(DISPLAY_SUFFIX_RE, "").trim();
  }
  if (!s || s.toLowerCase() === String(baseId).toLowerCase()) return "";
  return s;
}

export function buildModelsFromRawEntries(rawEntries, baseUrl = DEFAULT_BASE_URL) {
  const root = normalizeBaseUrl(baseUrl);
  const grouped = new Map();

  for (const [rawId, item] of rawEntries.entries()) {
    const { baseId, variant } = foldModelId(rawId);
    if (!baseId) continue;
    let bucket = grouped.get(baseId);
    if (!bucket) {
      bucket = { baseItem: null, variants: new Set(), variantItems: [] };
      grouped.set(baseId, bucket);
    }
    if (variant) {
      bucket.variants.add(variant);
      bucket.variantItems.push(item);
    } else {
      bucket.baseItem = item;
    }
  }

  const models = {};
  const xhighGeminiModels = new Set();

  for (const [baseId, bucket] of grouped.entries()) {
    const primary = bucket.baseItem ?? bucket.variantItems[0] ?? {};
    const fallbackItem = bucket.variantItems[0] ?? {};

    let displayName = cleanDisplayName(
      primary.display_name ?? primary.displayName,
      baseId,
      !bucket.baseItem,
    );
    if (!displayName && bucket.baseItem) {
      displayName = cleanDisplayName(
        fallbackItem.display_name ?? fallbackItem.displayName,
        baseId,
        true,
      );
    }
    if (!displayName) {
      displayName = titleCaseModelId(baseId);
    }

    const variants = {};
    for (const effort of EFFORT_ORDER) {
      if (bucket.variants.has(effort)) {
        variants[effort] = {};
      }
    }

    const context =
      firstPositive(
        primary.context_length,
        primary.max_input_tokens,
        primary.inputTokenLimit,
        primary.max_context_length,
        primary.max_model_len,
        primary.input_token_limit,
        primary.maxTokens,
        primary.max_tokens,
        fallbackItem.context_length,
        fallbackItem.max_input_tokens,
        fallbackItem.inputTokenLimit,
      ) ?? 128000;

    const output =
      firstPositive(
        primary.max_output_tokens,
        primary.max_completion_tokens,
        primary.outputTokenLimit,
        primary.output_token_limit,
        fallbackItem.max_output_tokens,
        fallbackItem.max_completion_tokens,
        fallbackItem.outputTokenLimit,
      ) ?? 65536;

    const inputModalities = deriveInputModalities(primary);
    const isImageOutput = /image|imagen/i.test(baseId);
    const outputModalities = isImageOutput ? ["text", "image"] : ["text"];
    const supportsThinking =
      primary.supports_thinking === true ||
      bucket.variantItems.some((it) => it?.supports_thinking === true);
    const reasoning = supportsThinking || Object.keys(variants).length > 0;

    const { npm, apiPath, family } = resolveProtocolSpec(baseId);

    if (baseId.toLowerCase().startsWith("gemini") && "xhigh" in variants) {
      xhighGeminiModels.add(baseId);
    }

    models[baseId] = {
      id: baseId,
      providerID: "agt",
      name: displayName,
      family,
      api: {
        id: baseId,
        url: `${root}${apiPath}`,
        npm,
      },
      status: "active",
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output },
      capabilities: {
        temperature: true,
        reasoning,
        attachment: inputModalities.length > 1,
        toolcall: true,
        input: toCapabilityModalities(inputModalities),
        output: toCapabilityModalities(outputModalities),
        interleaved: false,
      },
      release_date: "",
      variants,
    };
  }

  return { models, xhighGeminiModels };
}

async function fetchModelMap(url, headers, fetchImpl, signal, timeoutMs = 5000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: combined });
    if (!res.ok) return null;
    const data = await res.json();
    return extractModelEntries(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverModelsLive(baseUrl, apiKey, opts = {}) {
  const root = normalizeBaseUrl(baseUrl);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const signal = opts.signal;

  if (!apiKey || typeof fetchImpl !== "function") return null;

  const v1Headers = {
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    accept: "application/json",
  };
  const betaHeaders = {
    "x-goog-api-key": apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
  };

  const [v1Map, betaMap] = await Promise.all([
    fetchModelMap(`${root}/v1/models`, v1Headers, fetchImpl, signal, timeoutMs),
    fetchModelMap(`${root}/v1beta/models`, betaHeaders, fetchImpl, signal, timeoutMs),
  ]);

  if (!v1Map && !betaMap) return null;

  const merged = new Map();
  if (betaMap) {
    for (const [id, item] of betaMap.entries()) {
      merged.set(id, { ...item });
    }
  }
  if (v1Map) {
    for (const [id, item] of v1Map.entries()) {
      const prev = merged.get(id);
      merged.set(id, prev ? { ...prev, ...item } : { ...item });
    }
  }

  if (merged.size === 0) return null;

  const { models, xhighGeminiModels } = buildModelsFromRawEntries(merged, root);
  if (Object.keys(models).length === 0) return null;

  modelCache.set(root, {
    models,
    xhighGeminiModels,
    discoveredAt: Date.now(),
  });
  return models;
}

export function getDiscoveredModels(baseUrl = DEFAULT_BASE_URL) {
  const entry = modelCache.get(normalizeBaseUrl(baseUrl));
  return entry ? entry.models : null;
}

export function isXhighGeminiModel(baseUrl, modelId) {
  const clean = String(modelId || "").split("@")[0].trim();
  if (!clean) return false;
  const entry = modelCache.get(normalizeBaseUrl(baseUrl));
  return Boolean(entry?.xhighGeminiModels?.has(clean));
}

export async function ensureModelsDiscovered(baseUrl, apiKey, opts = {}) {
  const root = normalizeBaseUrl(baseUrl);
  const existing = modelCache.get(root);
  if (existing) return existing.models;

  if (inFlightDiscovery.has(root)) {
    return inFlightDiscovery.get(root);
  }

  const promise = (async () => {
    try {
      return await discoverModelsLive(root, apiKey, {
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 3000,
      });
    } catch {
      return null;
    } finally {
      inFlightDiscovery.delete(root);
    }
  })();

  inFlightDiscovery.set(root, promise);
  return promise;
}

export async function reconcileModels(provider, ctx = {}, deps = {}) {
  const { auth, signal } = ctx;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const { apiKey, baseUrl } = resolveAuth(auth);
  const root = normalizeBaseUrl(baseUrl);

  const discovered = await discoverModelsLive(root, apiKey, {
    fetchImpl,
    signal,
    timeoutMs: deps.timeoutMs ?? 5000,
  });

  if (discovered) {
    return discovered;
  }

  const cached = modelCache.get(root)?.models;
  const fallbackBase =
    cached && Object.keys(cached).length > 0
      ? cached
      : provider?.models && Object.keys(provider.models).length > 0
        ? provider.models
        : {};
  const fallback = { ...fallbackBase };
  fallback[Symbol.for("magpie.fellBack")] = true;
  return fallback;
}
