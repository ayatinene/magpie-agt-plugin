import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { OFFICIAL_ICON_URL } from "../index.mjs";
import {
  clearQuotaCache,
  computeAgtUsage,
  getAgtUsage,
  isAccountAbnormal,
  isValidationBlockActive,
} from "../lib/quota.mjs";
import { createAgtFetch, normalizeRateLimitErrorBody, rewriteUpstreamUrl } from "../lib/fetch.mjs";
import {
  DEFAULT_BASE_URL,
  clearModelCache,
  getDiscoveredModels,
  isXhighGeminiModel,
  reconcileModels,
} from "../lib/models.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");

const futureIso = (hoursAhead) => new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString();

function makeAccount({
  id = "acc-1",
  name = "UserOne",
  email = "userone@example.invalid",
  tier = "FREE",
  disabled = false,
  proxy_disabled = false,
  proxy_disabled_reason = "",
  banned = false,
  validation_blocked = false,
  validation_blocked_until = 0,
  is_forbidden = false,
  gemini5h = 100,
  gemini7d = 100,
  gemini5hReset = futureIso(2),
  gemini7dReset = futureIso(48),
  claude5h = 100,
  claude7d = 100,
  claude5hReset = futureIso(3),
  claude7dReset = futureIso(72),
  includeClaude = true,
  argon7d = null,
  argon7dReset = futureIso(96),
  extraGroups = [],
  models = null,
} = {}) {
  const quota_groups = [
    {
      display_name: "Gemini Models",
      buckets: [
        { bucket_id: "gemini_5h", window: "5h", remaining_fraction: gemini5h / 100, reset_time: gemini5hReset },
        { bucket_id: "gemini_weekly", window: "weekly", remaining_fraction: gemini7d / 100, reset_time: gemini7dReset },
      ],
    },
  ];
  if (includeClaude) {
    quota_groups.push({
      display_name: "Claude and GPT models",
      buckets: [
        { bucket_id: "3p_5h", window: "5h", remaining_fraction: claude5h / 100, reset_time: claude5hReset },
        { bucket_id: "3p_weekly", window: "weekly", remaining_fraction: claude7d / 100, reset_time: claude7dReset },
      ],
    });
  }
  if (argon7d !== null) {
    quota_groups.push({
      display_name: "Gemini 4 Argon",
      buckets: [
        { bucket_id: "argon_weekly", window: "weekly", remaining_fraction: argon7d / 100, reset_time: argon7dReset },
      ],
    });
  }
  for (const g of extraGroups) {
    quota_groups.push(g);
  }

  const defaultModels = [
    { name: "gemini-4-neon-high", reset_time: gemini5hReset },
    { name: "gemini-4-hydrogen-high", reset_time: gemini5hReset },
    ...(includeClaude
      ? [
          { name: "claude-opus-5-5-high", reset_time: claude5hReset },
          { name: "claude-sonnet-5-5-high", reset_time: claude5hReset },
        ]
      : []),
    ...(argon7d !== null || tier === "ULTRA"
      ? [{ name: "gemini-4-argon-high", reset_time: argon7d !== null ? argon7dReset : gemini7dReset }]
      : []),
  ];

  return {
    id,
    name,
    email,
    disabled,
    proxy_disabled,
    proxy_disabled_reason,
    banned,
    validation_blocked,
    validation_blocked_until,
    quota: {
      subscription_tier: tier,
      is_forbidden,
      quota_groups,
      models: models ?? defaultModels,
    },
  };
}

function makeSampleV1Payload() {
  const geminiMimes = {
    "image/png": true,
    "image/jpeg": true,
    "audio/mp3": true,
    "audio/wav": true,
    "video/mp4": true,
    "video/webm": true,
    "application/pdf": true,
  };
  const claudeMimes = {
    "image/png": true,
    "image/jpeg": true,
    "video/jpeg2000": true,
    "video/videoframe/jpeg2000": true,
  };
  return {
    object: "list",
    data: [
      { id: "gemini-4-neon", display_name: "Gemini 4 Neon", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-neon-minimal", display_name: "Gemini 4 Neon (Minimal)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-neon-xhigh", display_name: "Gemini 4 Neon (XHigh)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-neon-high", display_name: "Gemini 4 Neon (High)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-neon-low", display_name: "Gemini 4 Neon (Low)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-neon-medium", display_name: "Gemini 4 Neon (Medium)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-hydrogen", display_name: "Gemini 4 Hydrogen", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-hydrogen-xhigh", display_name: "Gemini 4 Hydrogen (XHigh)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-hydrogen-tiered", display_name: "Gemini 4 Hydrogen", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-hydrogen-tiered-high", display_name: "Gemini 4 Hydrogen (High)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-hydrogen-tiered-xhigh", display_name: "Gemini 4 Hydrogen (XHigh)", context_length: 1048576, max_output_tokens: 262144, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-3.8-flash-tiered", context_length: 1048576, max_output_tokens: 65536, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-argon", display_name: "Gemini 4 Argon", context_length: 1048576, max_output_tokens: 65536, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-4-argon-high", display_name: "Gemini 4 Argon (High)", context_length: 1048576, max_output_tokens: 65536, supports_images: true, supports_thinking: true, supported_mime_types: geminiMimes },
      { id: "gemini-3.1-flash-image", display_name: "Gemini 3.1 Flash Image", context_length: 65536, max_output_tokens: 65536, supports_images: true, supported_mime_types: claudeMimes },
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", context_length: 1000000, max_output_tokens: 128000, supports_images: true, supports_thinking: true, supported_mime_types: claudeMimes },
      { id: "claude-opus-5-5-high", display_name: "Claude Opus 5.5 (High)", context_length: 1000000, max_output_tokens: 128000, supports_images: true, supports_thinking: true, supported_mime_types: claudeMimes },
      { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", context_length: 1000000, max_output_tokens: 128000, supports_images: true, supports_thinking: true, supported_mime_types: claudeMimes },
      { id: "gpt-oss-120b", display_name: "GPT-OSS 120B", context_length: 131072, max_output_tokens: 32768, supports_thinking: true },
      { id: "gpt-oss-120b-medium", display_name: "GPT-OSS 120B (Medium)", context_length: 131072, max_output_tokens: 32768, supports_thinking: true },
    ],
  };
}

test("1. Weighted quota math: tier weights, barrel short-board, abnormal/disabled exclusion, fallback & nearest reset", () => {
  const nowMs = Date.now();
  const rSoon = new Date(nowMs + 1800 * 1000).toISOString();
  const rLater = new Date(nowMs + 7200 * 1000).toISOString();
  const rWeek = new Date(nowMs + 5 * 86400 * 1000).toISOString();
  const rArgon = new Date(nowMs + 6 * 86400 * 1000).toISOString();

  const accounts = [
    // ULTRA (weight 2.0): G 5h=100, 7d=50 -> effective=50; C 5h=80, 7d=0 -> effective=0; Argon falls back to Gemini weekly=50
    makeAccount({
      id: "u1",
      name: "UltraAcc",
      tier: "ULTRA",
      gemini5h: 100,
      gemini7d: 50,
      gemini5hReset: rLater,
      gemini7dReset: rWeek,
      claude5h: 80,
      claude7d: 0,
      claude5hReset: rLater,
      claude7dReset: rWeek,
    }),
    // PRO (weight 1.5): G 5h=60, 7d=80 -> effective=60; C 5h=40, 7d=100 -> effective=40; explicit Argon 7d=100
    makeAccount({
      id: "p1",
      name: "ProAcc",
      tier: "PRO",
      gemini5h: 60,
      gemini7d: 80,
      gemini5hReset: rSoon,
      gemini7dReset: rWeek,
      claude5h: 40,
      claude7d: 100,
      claude5hReset: rSoon,
      claude7dReset: rWeek,
      argon7d: 100,
      argon7dReset: rArgon,
    }),
    // FREE (weight 1.0): proxy_disabled -> excluded when onlyProxyPool=true and proxyOnline > 0
    makeAccount({
      id: "f1",
      name: "PausedFree",
      tier: "FREE",
      proxy_disabled: true,
      gemini5h: 100,
      gemini7d: 100,
      claude5h: 100,
      claude7d: 100,
    }),
    // Abnormal 403 validation blocked -> always excluded from active pool
    makeAccount({
      id: "b1",
      name: "BlockedAcc",
      tier: "ULTRA",
      validation_blocked: true,
      validation_blocked_until: 0,
      gemini5h: 100,
      gemini7d: 100,
    }),
    // Abnormal 403 reason on proxy_disabled -> abnormal
    makeAccount({
      id: "b2",
      name: "ForbiddenReason",
      tier: "PRO",
      proxy_disabled: true,
      proxy_disabled_reason: "forbidden (403): access denied",
      gemini5h: 100,
      gemini7d: 100,
    }),
  ];

  assert.equal(isValidationBlockActive(accounts[3], Math.floor(nowMs / 1000)), true);
  assert.equal(isAccountAbnormal(accounts[3], Math.floor(nowMs / 1000)), true);
  assert.equal(isAccountAbnormal(accounts[4], Math.floor(nowMs / 1000)), true);
  assert.equal(isAccountAbnormal(accounts[2], Math.floor(nowMs / 1000)), false);

  const res = computeAgtUsage(accounts, { onlyProxyPool: true, showAccountDetails: false, nowMs });

  // Gemini effective: (50*2.0 + 60*1.5) / 3.5 = 190 / 3.5 = 54.28 -> round 54 -> used = 46
  const neon = res.windows.find((w) => w.model === "gemini-4-neon");
  const hydro = res.windows.find((w) => w.model === "gemini-4-hydrogen");
  assert.ok(neon && hydro);
  assert.equal(neon.used, 46);
  assert.equal(hydro.used, 46);
  assert.equal(neon.resetsAt, rSoon);

  // Claude effective: (0*2.0 + 40*1.5) / 3.5 = 17.14 -> round 17 -> used = 83
  const opus = res.windows.find((w) => w.model === "claude-opus-5-5");
  const sonnet = res.windows.find((w) => w.model === "claude-sonnet-5-5");
  const claude5h = res.windows.find((w) => w.aside && w.pool === "Claude & GPT" && w.name === "5 hours");
  assert.ok(opus && sonnet && claude5h);
  assert.equal(opus.used, 83);
  assert.equal(sonnet.used, 83);
  assert.equal(claude5h.used, 83);

  // Argon: Ultra falls back to Gemini weekly (50 * 2.0) + Pro explicit (100 * 1.5) = 250 / 3.5 = 71.4 -> round 71 -> used = 29
  const argon = res.windows.find((w) => w.model === "gemini-4-argon");
  assert.ok(argon);
  assert.equal(argon.used, 29);

  // Fallback when all non-abnormal accounts are proxy_disabled: falls back to available pool
  const fallbackOnly = [
    makeAccount({
      id: "f2",
      name: "OnlyPaused",
      tier: "FREE",
      proxy_disabled: true,
      gemini5h: 70,
      gemini7d: 90,
      includeClaude: false,
    }),
  ];
  const fbRes = computeAgtUsage(fallbackOnly, { onlyProxyPool: true, showAccountDetails: false, nowMs });
  assert.equal(fbRes.windows.find((w) => w.model === "gemini-4-neon")?.used, 30);
  assert.equal(fbRes.windows.find((w) => w.model === "claude-sonnet-5-5"), undefined);
});

test("2. Non-abbreviated account details, max 1 ' · ' delimiter, odd filler, maxAccountDetails cap & 0 unlimited", () => {
  const accounts = [
    makeAccount({
      id: "a1",
      name: "Alice",
      email: "alice@example.invalid",
      tier: "PRO",
      gemini5h: 100,
      gemini7d: 49,
      claude5h: 100,
      claude7d: 100,
      argon7d: 100,
    }),
    makeAccount({
      id: "a2",
      name: "Bob",
      email: "bob@example.invalid",
      tier: "PRO",
      gemini5h: 80,
      gemini7d: 70,
      claude5h: 60,
      claude7d: 50,
      argon7d: 90,
    }),
    makeAccount({
      id: "a3",
      name: "Charlie",
      email: "charlie@example.invalid",
      tier: "FREE",
      gemini5h: 100,
      gemini7d: 100,
      includeClaude: false,
    }),
  ];

  const withDetails = computeAgtUsage(accounts, { showAccountDetails: true, maxAccountDetails: 0 });
  const withoutDetails = computeAgtUsage(accounts, { showAccountDetails: false });

  // Non-aside windows must strictly be per-model
  for (const res of [withDetails, withoutDetails]) {
    const nonAside = res.windows.filter((w) => !w.aside);
    assert.ok(nonAside.length >= 4);
    for (const w of nonAside) {
      assert.ok(w.model && Array.isArray(w.models) && w.models.length === 1);
      assert.ok(w.pool);
    }
  }

  // Non-abbreviated detail format
  const aliceWin = withDetails.windows.find((w) => w.name === "Alice · PRO");
  assert.ok(aliceWin && aliceWin.aside === true);
  assert.equal(aliceWin.display, "Gemini 100%/49% · Claude 100%/100%  Argon 100%");

  // Single-pool account has zero ' · ' delimiter
  const charlieWin = withDetails.windows.find((w) => w.name === "Charlie · FREE");
  assert.ok(charlieWin);
  assert.equal(charlieWin.display, "Gemini 100%/100%");
  assert.equal(charlieWin.display.includes(" · "), false);

  // At most one " · " delimiter per display
  for (const w of withDetails.windows) {
    if (typeof w.display === "string") {
      assert.ok(w.display.split(" · ").length <= 2, `too many ' · ' segments in: ${w.display}`);
    }
  }

  // Odd pool summary count (5) gets a filler cell
  const filler = withDetails.windows.find((w) => w.name === "账号池");
  assert.ok(filler && filler.aside === true && filler.display === "3/3 在线");
  assert.equal(withDetails.windows.find((w) => w.name === "其他账号"), undefined);
  assert.equal(JSON.stringify(withDetails).includes("example.invalid"), false);

  // maxAccountDetails cap shows first N accounts + summary cell
  const capped = computeAgtUsage(accounts, { showAccountDetails: true, maxAccountDetails: 2 });
  assert.ok(capped.windows.find((w) => w.name === "Alice · PRO"));
  assert.ok(capped.windows.find((w) => w.name === "Bob · PRO"));
  assert.equal(capped.windows.find((w) => w.name === "Charlie · FREE"), undefined);
  const moreCell = capped.windows.find((w) => w.name === "其他账号");
  assert.ok(moreCell && moreCell.aside === true && moreCell.display === "另有 1 个账号");

  // Disabled details omits account windows and filler
  assert.equal(withoutDetails.windows.find((w) => w.name === "Alice · PRO"), undefined);
  assert.equal(withoutDetails.windows.find((w) => w.name === "账号池"), undefined);
});

test("3. Dynamic model discovery from /v1/models and /v1beta/models fallback", async () => {
  clearModelCache();
  const sampleV1 = makeSampleV1Payload();

  const models = await reconcileModels(
    { id: "agt" },
    { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18045" } } },
    {
      fetchImpl: async (url) => {
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify(sampleV1), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
  );

  // Default mode (foldEffortVariants = false): preserves -tiered, base aliases WITH variants, AND effort-suffixed models
  assert.ok(models["gemini-4-hydrogen-tiered"], "gemini-4-hydrogen-tiered must be preserved");
  assert.deepEqual(Object.keys(models["gemini-4-hydrogen-tiered"].variants), ["high", "xhigh"]);
  assert.ok(models["gemini-3.8-flash-tiered"], "gemini-3.8-flash-tiered must be preserved");
  assert.equal(models["gemini-3.8-flash-tiered"].name, "Gemini 3.8 Flash Tiered");
  assert.deepEqual(Object.keys(models["gemini-3.8-flash-tiered"].variants), []);

  // Canonical variant order on base model: minimal, low, medium, high, xhigh, max
  assert.deepEqual(Object.keys(models["gemini-4-neon"].variants), ["minimal", "low", "medium", "high", "xhigh"]);

  // Suffixed models also emitted independently with variants: {}, preserved display name, and reasoning: true
  assert.ok(models["gemini-4-neon-xhigh"], "gemini-4-neon-xhigh must coexist by default");
  assert.equal(models["gemini-4-neon-xhigh"].api.id, "gemini-4-neon-xhigh");
  assert.equal(models["gemini-4-neon-xhigh"].name, "Gemini 4 Neon (XHigh)");
  assert.deepEqual(models["gemini-4-neon-xhigh"].variants, {});
  assert.equal(models["gemini-4-neon-xhigh"].capabilities.reasoning, true);

  assert.ok(models["gemini-4-hydrogen-tiered-xhigh"]);
  assert.equal(models["gemini-4-hydrogen-tiered-xhigh"].name, "Gemini 4 Hydrogen (XHigh)");
  assert.deepEqual(models["gemini-4-hydrogen-tiered-xhigh"].variants, {});

  assert.ok(models["claude-opus-5-5-high"]);
  assert.equal(models["claude-opus-5-5-high"].name, "Claude Opus 5.5 (High)");
  assert.equal(models["claude-opus-5-5-high"].api.npm, "@ai-sdk/anthropic");
  assert.deepEqual(models["claude-opus-5-5-high"].variants, {});

  assert.ok(models["gpt-oss-120b-medium"]);
  assert.equal(models["gpt-oss-120b-medium"].name, "GPT-OSS 120B (Medium)");
  assert.equal(models["gpt-oss-120b-medium"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["gpt-oss-120b-medium"].variants, {});

  // Protocol routing
  assert.equal(models["claude-opus-5-5"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["claude-opus-5-5"].api.url, "http://127.0.0.1:18045/v1");
  assert.equal(models["gemini-4-neon"].api.npm, "@ai-sdk/google");
  assert.equal(models["gemini-4-neon"].api.url, "http://127.0.0.1:18045/v1beta");
  assert.equal(models["gpt-oss-120b"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["gpt-oss-120b"].api.url, "http://127.0.0.1:18045/v1");
  assert.deepEqual(Object.keys(models["gpt-oss-120b"].variants), ["medium"]);

  // Image model output & reasoning: false; non-standard video/jpeg2000 excluded from video modality
  const flashImg = models["gemini-3.1-flash-image"];
  assert.ok(flashImg);
  assert.equal(flashImg.capabilities.reasoning, false);
  assert.equal(flashImg.capabilities.output.image, true);
  assert.equal(flashImg.capabilities.output.text, true);
  assert.equal(flashImg.capabilities.input.image, true);
  assert.equal(flashImg.capabilities.input.video, false);
  assert.equal(models["claude-opus-5-5"].capabilities.input.video, false);
  assert.equal(models["gemini-4-neon"].capabilities.input.video, true);
  assert.equal(models["gemini-4-neon"].capabilities.input.pdf, true);

  // Runtime cache populated and supports live switching between unfolded and folded modes
  const cachedDefault = getDiscoveredModels("http://127.0.0.1:18045");
  assert.ok(cachedDefault?.["gemini-4-neon"]);
  assert.ok(cachedDefault?.["gemini-4-neon-xhigh"]);
  const cachedFolded = getDiscoveredModels("http://127.0.0.1:18045", { foldEffortVariants: true });
  assert.ok(cachedFolded?.["gemini-4-neon"]);
  assert.equal(cachedFolded?.["gemini-4-neon-xhigh"], undefined);
  assert.deepEqual(Object.keys(cachedFolded["gemini-4-neon"].variants), ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18045", "gemini-4-neon"), true);
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18045", "gemini-4-neon-xhigh"), false);
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18045", "gemini-4-hydrogen-tiered"), true);
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18045", "gemini-4-argon"), false);

  // Offline fallback returns cached models tagged with magpie.fellBack (respecting foldEffortVariants)
  const fellBack = await reconcileModels(
    { id: "agt" },
    { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18045" } } },
    { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
  );
  assert.equal(fellBack[Symbol.for("magpie.fellBack")], true);
  assert.ok(fellBack["gemini-4-neon"]);
  assert.ok(fellBack["gemini-4-neon-xhigh"]);

  const fellBackFolded = await reconcileModels(
    { id: "agt" },
    { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18045" } } },
    { foldEffortVariants: true, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
  );
  assert.equal(fellBackFolded[Symbol.for("magpie.fellBack")], true);
  assert.ok(fellBackFolded["gemini-4-neon"]);
  assert.equal(fellBackFolded["gemini-4-neon-xhigh"], undefined);

  // /v1beta/models fallback when /v1/models fails on a fresh baseUrl:
  // test both default (coexist) and foldEffortVariants: true (synthesizes base from suffixed-only entry)
  clearModelCache();
  const betaFetch = async (url) => {
    if (url.endsWith("/v1/models")) return new Response("Not Found", { status: 404 });
    return new Response(
      JSON.stringify({
        models: [
          { name: "models/gemini-5-nova-xhigh", displayName: "Gemini 5 Nova (XHigh)", inputTokenLimit: 2000000, outputTokenLimit: 65536 },
        ],
      }),
      { status: 200 },
    );
  };
  const betaDefault = await reconcileModels(
    { id: "agt" },
    { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18046" } } },
    { fetchImpl: betaFetch },
  );
  assert.equal(betaDefault["gemini-5-nova"], undefined);
  assert.ok(betaDefault["gemini-5-nova-xhigh"]);
  assert.equal(betaDefault["gemini-5-nova-xhigh"].name, "Gemini 5 Nova (XHigh)");
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18046", "gemini-5-nova"), true);

  const betaFolded = await reconcileModels(
    { id: "agt" },
    { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18046" } } },
    { foldEffortVariants: true, fetchImpl: betaFetch },
  );
  assert.ok(betaFolded["gemini-5-nova"]);
  assert.equal(betaFolded["gemini-5-nova"].name, "Gemini 5 Nova");
  assert.equal(betaFolded["gemini-5-nova"].limit.context, 2000000);
  assert.deepEqual(Object.keys(betaFolded["gemini-5-nova"].variants), ["xhigh"]);
  assert.equal(betaFolded["gemini-5-nova-xhigh"], undefined);
  assert.equal(isXhighGeminiModel("http://127.0.0.1:18046", "gemini-5-nova"), true);
});

test("4. Multi-protocol URL rewriting (Gemini, Anthropic, OpenAI chat/completions & responses) and auth headers", async () => {
  assert.deepEqual(
    rewriteUpstreamUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse", "http://127.0.0.1:8045"),
    { protocol: "gemini", url: "http://127.0.0.1:8045/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse" },
  );
  assert.deepEqual(
    rewriteUpstreamUrl("http://127.0.0.1:8045/v1beta/v1beta/models/gemini-4-argon:generateContent", "http://127.0.0.1:8045/v1beta"),
    { protocol: "gemini", url: "http://127.0.0.1:8045/v1beta/models/gemini-4-argon:generateContent" },
  );
  assert.deepEqual(
    rewriteUpstreamUrl("https://api.anthropic.com/v1/messages", "http://127.0.0.1:8045"),
    { protocol: "anthropic", url: "http://127.0.0.1:8045/v1/messages" },
  );
  assert.deepEqual(
    rewriteUpstreamUrl("http://127.0.0.1:8045/v1/v1/messages?beta=true", "http://127.0.0.1:8045/v1"),
    { protocol: "anthropic", url: "http://127.0.0.1:8045/v1/messages?beta=true" },
  );
  assert.deepEqual(
    rewriteUpstreamUrl("https://api.openai.com/v1/chat/completions", "http://127.0.0.1:8045"),
    { protocol: "openai", url: "http://127.0.0.1:8045/v1/chat/completions" },
  );
  assert.deepEqual(
    rewriteUpstreamUrl("http://127.0.0.1:8045/v1/v1/responses?stream=true", "http://127.0.0.1:8045/v1"),
    { protocol: "openai", url: "http://127.0.0.1:8045/v1/responses?stream=true" },
  );

  const calls = [];
  const mockFetch = createAgtFetch({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body });
      return new Response("{}", { status: 200 });
    },
  });

  await mockFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "stale" },
    body: JSON.stringify({ contents: [] }),
  });
  assert.equal(calls[0].url, "http://127.0.0.1:18045/v1beta/models/gemini-4-neon:generateContent");
  assert.equal(calls[0].headers["x-goog-api-key"], "sk-test-key");
  assert.equal(calls[0].headers.authorization, "Bearer sk-test-key");
  assert.equal(calls[0].headers["x-api-key"], undefined);

  await mockFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "stale" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
  });
  assert.equal(calls[1].url, "http://127.0.0.1:18045/v1/messages");
  assert.equal(calls[1].headers["x-api-key"], "sk-test-key");
  assert.equal(calls[1].headers.authorization, "Bearer sk-test-key");
  assert.equal(calls[1].headers["x-goog-api-key"], undefined);

  await mockFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "stale", "x-goog-api-key": "stale" },
    body: JSON.stringify({ model: "gpt-oss-120b", messages: [] }),
  });
  assert.equal(calls[2].url, "http://127.0.0.1:18045/v1/chat/completions");
  assert.equal(calls[2].headers.authorization, "Bearer sk-test-key");
  assert.equal(calls[2].headers["x-api-key"], undefined);
  assert.equal(calls[2].headers["x-goog-api-key"], undefined);
});

test("5. Dynamic xhigh detection (neon, hydrogen, tiered, synthetic gemini-5-nova), strips thinkingBudget, leaves argon untouched", async () => {
  clearModelCache();
  const captured = [];
  let discoveryCalls = 0;
  const mockFetch = createAgtFetch({
    baseUrl: "http://127.0.0.1:18047",
    apiKey: "sk-test-key",
    fetchImpl: async (url, init) => {
      if (url.endsWith("/v1/models")) {
        discoveryCalls++;
        const payload = makeSampleV1Payload();
        payload.data.push(
          { id: "gemini-5-nova", display_name: "Gemini 5 Nova" },
          { id: "gemini-5-nova-xhigh", display_name: "Gemini 5 Nova (XHigh)" },
        );
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.endsWith("/v1beta/models")) {
        return new Response("Not Found", { status: 404 });
      }
      captured.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body),
      });
      return new Response("{}", { status: 200 });
    },
  });

  const basePayload = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: {
      temperature: 0.7,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "high", thinkingBudget: 8192 },
    },
  };

  // Lazy warmup triggers on first xhigh request, detects neon + strips thinkingBudget
  await mockFetch("http://127.0.0.1:18047/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Magpie-Effort": "xhigh", "Content-Length": "999" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(discoveryCalls, 1);
  assert.equal(captured[0].body.generationConfig.thinkingConfig.thinkingLevel, "xhigh");
  assert.equal(captured[0].body.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal("thinkingBudget" in captured[0].body.generationConfig.thinkingConfig, false);
  assert.equal(captured[0].headers.has("x-magpie-effort"), false);
  assert.equal(captured[0].headers.has("content-length"), false);

  // Cached discovery reused for hydrogen, hydrogen-tiered, and synthetic gemini-5-nova
  for (const model of ["gemini-4-hydrogen", "gemini-4-hydrogen-tiered", "gemini-5-nova"]) {
    await mockFetch(`http://127.0.0.1:18047/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Magpie-Effort": "xhigh" },
      body: JSON.stringify(basePayload),
    });
  }
  assert.equal(discoveryCalls, 1);
  assert.equal(captured[1].body.generationConfig.thinkingConfig.thinkingLevel, "xhigh");
  assert.equal(captured[2].body.generationConfig.thinkingConfig.thinkingLevel, "xhigh");
  assert.equal(captured[3].body.generationConfig.thinkingConfig.thinkingLevel, "xhigh");

  // argon + xhigh -> left untouched as "high" with thinkingBudget preserved
  await mockFetch("http://127.0.0.1:18047/v1beta/models/gemini-4-argon:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Magpie-Effort": "xhigh" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(captured[4].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(captured[4].body.generationConfig.thinkingConfig.thinkingBudget, 8192);
  assert.equal(captured[4].headers.has("x-magpie-effort"), false);

  // neon + high -> left untouched as "high"
  await mockFetch("http://127.0.0.1:18047/v1beta/models/gemini-4-neon:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Magpie-Effort": "high" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(captured[5].body.generationConfig.thinkingConfig.thinkingLevel, "high");

  // suffixed model gemini-4-neon-xhigh passes through cleanly without effort rewrite
  await mockFetch("http://127.0.0.1:18047/v1beta/models/gemini-4-neon-xhigh:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(captured[6].url, "http://127.0.0.1:18047/v1beta/models/gemini-4-neon-xhigh:generateContent");
  assert.equal(captured[6].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(captured[6].body.generationConfig.thinkingConfig.thinkingBudget, 8192);

  // Even if X-Magpie-Effort: xhigh is attached to suffixed gemini-4-neon-xhigh, it does not rewrite
  await mockFetch("http://127.0.0.1:18047/v1beta/models/gemini-4-neon-xhigh:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Magpie-Effort": "xhigh" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(captured[7].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(captured[7].body.generationConfig.thinkingConfig.thinkingBudget, 8192);
  assert.equal(captured[7].headers.has("x-magpie-effort"), false);
});

test("6. Dynamic quota pool discovery (including synthetic 4th pool) & reset_time model-to-pool matching", () => {
  const rGem5h = futureIso(2);
  const rGem7d = futureIso(48);
  const rClaude5h = futureIso(3);
  const rClaude7d = futureIso(72);
  const rArgon = futureIso(96);
  const rVideo = futureIso(120);

  const acc = makeAccount({
    name: "MultiPoolUser",
    tier: "PRO",
    gemini5h: 90,
    gemini7d: 50,
    gemini5hReset: rGem5h,
    gemini7dReset: rGem7d,
    claude5h: 80,
    claude7d: 60,
    claude5hReset: rClaude5h,
    claude7dReset: rClaude7d,
    argon7d: 35,
    argon7dReset: rArgon,
    extraGroups: [
      {
        display_name: "Video Studio",
        buckets: [
          { bucket_id: "video_weekly", window: "weekly", remaining_fraction: 0.75, reset_time: rVideo },
        ],
      },
    ],
    models: [
      { name: "gemini-4-neon-xhigh", reset_time: rGem5h },
      { name: "gemini-pro-orchestrator-g1-pro", reset_time: rArgon },
      { name: "claude-sonnet-5-5-high", reset_time: rClaude5h },
      { name: "gpt-oss-120b-medium", reset_time: rClaude5h },
      { name: "veo-3", reset_time: rVideo },
    ],
  });

  const usage = computeAgtUsage([acc], { showAccountDetails: true });

  // Verify reset_time matching mapped gemini-pro-orchestrator-g1-pro -> Gemini 4 Argon (65% used)
  const orch = usage.windows.find((w) => w.model === "gemini-pro-orchestrator-g1-pro");
  assert.ok(orch);
  assert.equal(orch.pool, "Gemini 4 Argon");
  assert.equal(orch.used, 65);

  // Verify synthetic 4th pool "Video Studio" discovered and veo-3 mapped to it (25% used)
  const veo = usage.windows.find((w) => w.model === "veo-3");
  assert.ok(veo);
  assert.equal(veo.pool, "Video Studio");
  assert.equal(veo.used, 25);

  const videoAside = usage.windows.find((w) => w.aside && w.pool === "Video Studio");
  assert.ok(videoAside && videoAside.used === 25);

  const detail = usage.windows.find((w) => w.name === "MultiPoolUser · PRO");
  assert.ok(detail);
  assert.equal(detail.display, "Gemini 90%/50% · Claude 80%/60%  Argon 35%  Video Studio 75%");
  assert.ok(detail.display.split(" · ").length <= 2);

  // Fallback to acc.quota.models without discoveredModels handles foldEffortVariants cleanly
  const noDiscDefault = computeAgtUsage([acc], { showAccountDetails: false });
  assert.ok(noDiscDefault.windows.find((w) => w.model === "gemini-4-neon"));
  assert.ok(noDiscDefault.windows.find((w) => w.model === "gemini-4-neon-xhigh"));
  const noDiscFolded = computeAgtUsage([acc], { showAccountDetails: false, foldEffortVariants: true });
  assert.ok(noDiscFolded.windows.find((w) => w.model === "gemini-4-neon"));
  assert.equal(noDiscFolded.windows.find((w) => w.model === "gemini-4-neon-xhigh"), undefined);

  // When discoveredModels contains both base aliases and effort-suffixed models (default foldEffortVariants: false),
  // BOTH keep their exact IDs in usage.windows and BOTH map to the right quota pool
  const discoveredCoexist = {
    "gemini-4-neon": { id: "gemini-4-neon", name: "Gemini 4 Neon", family: "Gemini" },
    "gemini-4-neon-xhigh": { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", family: "Gemini" },
    "gemini-pro-orchestrator-g1-pro": { id: "gemini-pro-orchestrator-g1-pro", name: "Gemini Pro Orchestrator G1 Pro", family: "Gemini" },
    "gemini-pro-orchestrator-g1-pro-high": { id: "gemini-pro-orchestrator-g1-pro-high", name: "Gemini Pro Orchestrator G1 Pro (High)", family: "Gemini" },
    "veo-3": { id: "veo-3", name: "Veo 3", family: "Veo" },
    "veo-3-high": { id: "veo-3-high", name: "Veo 3 (High)", family: "Veo" },
  };
  const coexistUsage = computeAgtUsage([acc], {
    showAccountDetails: false,
    discoveredModels: discoveredCoexist,
  });
  const neonBaseWin = coexistUsage.windows.find((w) => w.model === "gemini-4-neon");
  const neonXhighWin = coexistUsage.windows.find((w) => w.model === "gemini-4-neon-xhigh");
  const orchHighWin = coexistUsage.windows.find((w) => w.model === "gemini-pro-orchestrator-g1-pro-high");
  const veoHighWin = coexistUsage.windows.find((w) => w.model === "veo-3-high");
  assert.ok(neonBaseWin && neonBaseWin.pool === "Gemini" && neonBaseWin.used === 50);
  assert.ok(neonXhighWin && neonXhighWin.pool === "Gemini" && neonXhighWin.used === 50);
  assert.equal(neonXhighWin.name, "Gemini 4 Neon (XHigh)");
  assert.ok(orchHighWin && orchHighWin.pool === "Gemini 4 Argon" && orchHighWin.used === 65);
  assert.ok(veoHighWin && veoHighWin.pool === "Video Studio" && veoHighWin.used === 25);

  // When foldEffortVariants: true, suffixed IDs are folded back to base IDs only
  const foldedUsage = computeAgtUsage([acc], {
    showAccountDetails: false,
    foldEffortVariants: true,
    discoveredModels: discoveredCoexist,
  });
  assert.ok(foldedUsage.windows.find((w) => w.model === "gemini-4-neon"));
  assert.equal(foldedUsage.windows.find((w) => w.model === "gemini-4-neon-xhigh"), undefined);
  assert.equal(foldedUsage.windows.find((w) => w.model === "veo-3-high"), undefined);
});

test("7. 429 / 503 error normalization injects exact model ID and preserves Retry-After", async () => {
  const n429 = normalizeRateLimitErrorBody(
    JSON.stringify({ error: { message: "All accounts quota exhausted for this group" } }),
    429,
    "claude-sonnet-5-5",
  );
  const p429 = JSON.parse(n429.body);
  assert.match(p429.error.message, /claude-sonnet-5-5/);
  assert.match(p429.error.message, /RESOURCE_EXHAUSTED/);
  assert.match(p429.error.message, /quota/i);
  assert.equal(p429.error.model, "claude-sonnet-5-5");

  const n503 = normalizeRateLimitErrorBody("capacity busy", 503, "gemini-4-neon");
  const p503 = JSON.parse(n503.body);
  assert.match(p503.error.message, /gemini-4-neon/);
  assert.match(p503.error.message, /overloaded/i);
  assert.equal(p503.error.type, "overloaded_error");

  const mockFetch = createAgtFetch({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-test-key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "Model capacity limit reached" } }), {
        status: 503,
        headers: { "Retry-After": "17", "Content-Type": "application/json" },
      }),
  });

  const res = await mockFetch("http://127.0.0.1:8045/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "17");
  const body = await res.json();
  assert.match(body.error.message, /claude-opus-5-5/);
  assert.match(body.error.message, /overloaded/i);
});

test("8. Plugin metadata, official HTTPS icon, zero 'AGT' in user copy, 30s cooldown, and privacy hygiene", async () => {
  assert.equal(plugin.id, "magpie-agt-plugin");
  assert.equal(typeof plugin.server, "function");
  assert.equal(DEFAULT_BASE_URL, "http://127.0.0.1:8045");
  assert.ok(OFFICIAL_ICON_URL.startsWith("https://"));

  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.magpie.icon, OFFICIAL_ICON_URL);
  assert.equal(pkg.magpie.options.foldEffortVariants, false);
  assert.equal(pkg.magpie.options.refreshCooldownSec, 30);
  assert.equal(pkg.magpie.options.maxAccountDetails, 0);
  assert.equal(/\bAGT\b/.test(pkg.description), false);
  assert.equal(/\bAGT\b/.test(pkg.magpie.summary.en), false);
  assert.equal(/\bAGT\b/.test(pkg.magpie.summary.zh), false);

  const hooks = await plugin.server(
    {
      magpie: {
        options: () => ({ showAccountDetails: true, onlyProxyPool: true, cacheTtlSec: 20 }),
        option: () => true,
      },
    },
    { showAccountDetails: true, onlyProxyPool: true, cacheTtlSec: 20 },
  );

  assert.equal(hooks.auth.provider, "agt");
  assert.equal(hooks.auth.single, true);
  assert.equal(hooks.auth.icon, OFFICIAL_ICON_URL);
  assert.equal(hooks.auth.options.length, 4);
  const foldOpt = hooks.auth.options.find((o) => o.key === "fold_effort_variants");
  assert.ok(foldOpt, "fold_effort_variants option must exist");
  assert.equal(foldOpt.default, false);
  for (const opt of hooks.auth.options) {
    assert.equal(opt.placement, undefined, `option ${opt.key} must not set placement:"top"`);
    assert.equal(/\bAGT\b/.test(opt.label), false);
    assert.equal(/\bAGT\b/.test(opt.description), false);
    assert.equal(/\bAGT\b/.test(opt.labels.zh), false);
    assert.equal(/\bAGT\b/.test(opt.descriptions.zh), false);
  }
  const readme = fs.readFileSync(path.join(PLUGIN_DIR, "README.md"), "utf8");
  assert.equal(/\bAGT\b/.test(readme), false);
  assert.equal(hooks.auth.methods[0].labels.zh, "Antigravity Tools 代理密钥");
  assert.ok(hooks.auth.methods[0].prompts[0].messages.zh.includes("http://127.0.0.1:8045"));
  assert.ok(hooks.auth.methods[0].prompts[1].messages.zh.includes("Antigravity Tools"));

  // provider.models reads live fold_effort_variants option dynamically
  clearModelCache();
  let liveFold = false;
  const liveHooks = await plugin.server({
    magpie: {
      options: () => ({ fold_effort_variants: liveFold }),
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/models")) {
      return new Response(JSON.stringify(makeSampleV1Payload()), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    const authCtx = { auth: { type: "api", key: "sk-test", metadata: { baseUrl: "http://127.0.0.1:18049" } } };
    const defaultList = await liveHooks.provider.models({ id: "agt" }, authCtx);
    assert.ok(defaultList["gemini-4-neon"] && defaultList["gemini-4-neon-xhigh"]);
    liveFold = true;
    const foldedList = await liveHooks.provider.models({ id: "agt" }, authCtx);
    assert.ok(foldedList["gemini-4-neon"]);
    assert.equal(foldedList["gemini-4-neon-xhigh"], undefined);
  } finally {
    globalThis.fetch = origFetch;
  }

  // config() creates clean shell without hardcoded models
  const cfg = { provider: {} };
  await hooks.config(cfg);
  assert.equal(cfg.provider.agt.name, "Antigravity Tools");
  assert.equal(cfg.provider.agt.api, "http://127.0.0.1:8045/v1beta");
  assert.deepEqual(cfg.provider.agt.models, {});

  // Quota error returns { error } without "AGT" abbreviation
  clearQuotaCache();
  const errUsage = await getAgtUsage({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "sk-test",
    fetchImpl: async () => new Response("Internal Error", { status: 500 }),
  });
  assert.ok(typeof errUsage.error === "string" && errUsage.error.includes("Antigravity Tools") && errUsage.error.includes("500"));
  assert.equal(/\bAGT\b/.test(errUsage.error), false);

  // Separate adminToken is used for /api/accounts when provided
  clearQuotaCache();
  let seenAuth = "";
  const okUsage = await getAgtUsage({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-proxy-only",
    adminToken: "Bearer web-admin-secret",
    fetchImpl: async (_url, init) => {
      seenAuth = init.headers.authorization;
      return new Response(JSON.stringify({ accounts: [makeAccount()] }), { status: 200 });
    },
  });
  assert.equal(seenAuth, "Bearer web-admin-secret");
  assert.equal(okUsage.plan, "FREE ×1");

  // Default 30s refresh cooldown behavior
  clearQuotaCache();
  const seq = [];
  await getAgtUsage({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-proxy",
    adminToken: "admin-secret",
    refreshAgtOnUsage: true,
    fetchImpl: async (url, init) => {
      seq.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ accounts: [makeAccount({ tier: "PRO" })] }), { status: 200 });
    },
  });
  assert.deepEqual(seq, ["POST /api/accounts/refresh", "GET /api/accounts"]);

  const seq2 = [];
  await getAgtUsage({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-proxy",
    adminToken: "admin-secret",
    refreshAgtOnUsage: true,
    fetchImpl: async (url, init) => {
      seq2.push(`${init.method} ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ accounts: [makeAccount({ tier: "PRO" })] }), { status: 200 });
    },
  });
  assert.deepEqual(seq2, ["GET /api/accounts"]);

  // If POST /refresh fails, gracefully still returns GET /api/accounts
  clearQuotaCache();
  const fallbackRes = await getAgtUsage({
    baseUrl: "http://127.0.0.1:18045",
    apiKey: "sk-proxy",
    adminToken: "admin-secret",
    refreshAgtOnUsage: true,
    refreshCooldownSec: 0,
    fetchImpl: async (url, init) => {
      if (init.method === "POST") throw new Error("refresh timeout");
      return new Response(JSON.stringify({ accounts: [makeAccount({ tier: "PRO" })] }), { status: 200 });
    },
  });
  assert.equal(fallbackRes.error, undefined);
  assert.equal(fallbackRes.plan, "PRO ×1");
});
