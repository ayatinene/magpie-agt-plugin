import {
  ensureModelsDiscovered,
  getDiscoveredModels,
  isXhighGeminiModel,
  normalizeBaseUrl,
  resolveAuth,
} from "./models.mjs";

export function detectProtocol(pathname) {
  if (/\/models(?:\/|$)|:(?:streamGenerateContent|generateContent|countTokens|embedContent)\b/i.test(pathname)) {
    return "gemini";
  }
  if (/\/messages(?:\/|$)/i.test(pathname)) {
    return "anthropic";
  }
  if (/\/chat\/completions(?:\/|$)|\/responses(?:\/|$)/i.test(pathname)) {
    return "openai";
  }
  return "other";
}

export function extractGeminiModelFromPath(pathname) {
  const m = pathname.match(/\/models\/([^/:?#]+)/i);
  if (!m) return "";
  return m[1].split("@")[0].trim();
}

export function rewriteUpstreamUrl(rawUrl, baseUrl) {
  const root = normalizeBaseUrl(baseUrl);
  const parsed = new URL(rawUrl, root);
  const pathname = parsed.pathname;
  const protocol = detectProtocol(pathname);

  if (protocol === "gemini") {
    const modelsIdx = pathname.toLowerCase().lastIndexOf("/models");
    if (modelsIdx >= 0) {
      return {
        protocol,
        url: `${root}/v1beta${pathname.slice(modelsIdx)}${parsed.search}`,
      };
    }
    const cleanPath = pathname.replace(/^(?:\/v1beta)+/i, "");
    return {
      protocol,
      url: `${root}/v1beta${cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`}${parsed.search}`,
    };
  }

  if (protocol === "anthropic") {
    const msgIdx = pathname.toLowerCase().lastIndexOf("/messages");
    return {
      protocol,
      url: `${root}/v1${pathname.slice(msgIdx)}${parsed.search}`,
    };
  }

  if (protocol === "openai") {
    const lower = pathname.toLowerCase();
    const chatIdx = lower.lastIndexOf("/chat/completions");
    const respIdx = lower.lastIndexOf("/responses");
    const idx = chatIdx >= 0 ? chatIdx : respIdx;
    return {
      protocol,
      url: `${root}/v1${pathname.slice(idx)}${parsed.search}`,
    };
  }

  return {
    protocol,
    url: `${root}${pathname}${parsed.search}`,
  };
}

function decodeBodyText(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return new TextDecoder("utf-8").decode(body);
  }
  return null;
}

export function normalizeRateLimitErrorBody(rawText, status, requestedModel) {
  const model = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const isOverloadStatus = status === 503 || status === 529;
  const indicatesOverload =
    isOverloadStatus &&
    (!rawText.trim() || /(overload|capacity|unavailable|busy|503|529|resource|server)/i.test(rawText));
  const indicatesQuota = status === 429 && /(quota|exhausted|resource_exhausted|limit|exceeded)/i.test(rawText);

  let parsed = null;
  try {
    const candidate = JSON.parse(rawText);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate;
    }
  } catch {
    parsed = null;
  }

  const buildMsg = (origMsg) => {
    const parts = [];
    const base = String(origMsg || "").trim();
    if (model && !base.includes(model)) {
      parts.push(`model ${model}:`);
    }
    if (base) {
      parts.push(base);
    } else {
      parts.push(isOverloadStatus ? "upstream service unavailable" : "rate limit exceeded");
    }
    const joined = parts.join(" ");
    const extra = [];
    if (indicatesOverload && !/overloaded/i.test(joined)) {
      extra.push("overloaded");
    }
    if (indicatesQuota) {
      if (!/RESOURCE_EXHAUSTED/i.test(joined)) extra.push("RESOURCE_EXHAUSTED");
      if (!/quota/i.test(joined)) extra.push("quota");
    }
    return extra.length ? `${joined} (${extra.join(" ")})` : joined;
  };

  if (parsed) {
    const errObj = parsed.error && typeof parsed.error === "object" ? { ...parsed.error } : null;
    if (errObj) {
      errObj.message = buildMsg(errObj.message ?? parsed.message ?? "");
      if (model && !errObj.model) errObj.model = model;
      if (indicatesOverload && !errObj.type) errObj.type = "overloaded_error";
      if (indicatesQuota && !errObj.status) errObj.status = "RESOURCE_EXHAUSTED";
      return {
        body: JSON.stringify({ ...parsed, error: errObj }),
        contentType: "application/json",
      };
    }

    const updated = { ...parsed };
    updated.message = buildMsg(updated.message ?? updated.error ?? "");
    if (model && !updated.model) updated.model = model;
    if (indicatesOverload && !updated.type) updated.type = "overloaded_error";
    if (indicatesQuota && !updated.status) updated.status = "RESOURCE_EXHAUSTED";
    return {
      body: JSON.stringify(updated),
      contentType: "application/json",
    };
  }

  const msg = buildMsg(rawText);
  return {
    body: JSON.stringify({
      error: {
        message: msg,
        ...(model ? { model } : {}),
        ...(indicatesOverload ? { type: "overloaded_error" } : {}),
        ...(indicatesQuota ? { status: "RESOURCE_EXHAUSTED" } : {}),
      },
    }),
    contentType: "application/json",
  };
}

export function createAgtFetch(config = {}) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return async function agtFetch(input, init = {}) {
    const authSnapshot = typeof config.getAuth === "function" ? resolveAuth(await config.getAuth()) : null;
    const baseUrl = normalizeBaseUrl(authSnapshot?.baseUrl || config.baseUrl);
    const apiKey = authSnapshot?.apiKey || config.apiKey || "";

    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { protocol, url: targetUrl } = rewriteUpstreamUrl(rawUrl, baseUrl);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    }

    const effort = headers.get("x-magpie-effort");
    headers.delete("x-magpie-effort");

    if (apiKey) {
      if (protocol === "gemini") {
        headers.set("x-goog-api-key", apiKey);
        headers.set("authorization", `Bearer ${apiKey}`);
        headers.delete("x-api-key");
      } else if (protocol === "anthropic") {
        headers.set("x-api-key", apiKey);
        headers.set("authorization", `Bearer ${apiKey}`);
        headers.delete("x-goog-api-key");
      } else if (protocol === "openai") {
        headers.set("authorization", `Bearer ${apiKey}`);
        headers.delete("x-goog-api-key");
        headers.delete("x-api-key");
      } else {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
    }

    let body = init?.body;
    if (body === undefined && input instanceof Request && input.body !== null) {
      body = await input.text();
    }

    let requestedModel = protocol === "gemini" ? extractGeminiModelFromPath(new URL(targetUrl).pathname) : "";
    const bodyText = decodeBodyText(body);

    if (bodyText !== null) {
      let parsedBody = null;
      try {
        const obj = JSON.parse(bodyText);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsedBody = obj;
        }
      } catch {
        parsedBody = null;
      }

      if (!requestedModel && parsedBody && typeof parsedBody.model === "string") {
        requestedModel = parsedBody.model.split("@")[0].trim();
      }

      if (
        protocol === "gemini" &&
        effort?.trim().toLowerCase() === "xhigh" &&
        parsedBody &&
        requestedModel
      ) {
        if (!getDiscoveredModels(baseUrl)) {
          await ensureModelsDiscovered(baseUrl, apiKey, {
            fetchImpl,
            signal: init?.signal,
            timeoutMs: 3000,
          });
        }
        if (isXhighGeminiModel(baseUrl, requestedModel)) {
          const genCfg =
            parsedBody.generationConfig && typeof parsedBody.generationConfig === "object"
              ? { ...parsedBody.generationConfig }
              : {};
          const prevThinking =
            genCfg.thinkingConfig && typeof genCfg.thinkingConfig === "object"
              ? { ...genCfg.thinkingConfig }
              : {};
          const nextThinking = {
            ...prevThinking,
            includeThoughts: true,
            thinkingLevel: "xhigh",
          };
          delete nextThinking.thinkingBudget;
          genCfg.thinkingConfig = nextThinking;
          parsedBody.generationConfig = genCfg;
          body = JSON.stringify(parsedBody);
          headers.delete("content-length");
        }
      }
    }

    const method = init?.method ?? (input instanceof Request ? input.method : "POST");
    const res = await fetchImpl(targetUrl, {
      ...init,
      method,
      headers,
      body,
    });

    if (res.status === 429 || res.status === 503 || res.status === 529) {
      const rawErrText = await res.text();
      const normalized = normalizeRateLimitErrorBody(rawErrText, res.status, requestedModel);
      const outHeaders = new Headers(res.headers);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.set("content-type", normalized.contentType);
      return new Response(normalized.body, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders,
      });
    }

    return res;
  };
}
