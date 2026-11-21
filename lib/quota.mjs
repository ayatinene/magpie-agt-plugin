import { foldModelId, getDiscoveredModels, normalizeBaseUrl, titleCaseModelId } from "./models.mjs";

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

const quotaCache = new Map();
const inFlightFetches = new Map();
const lastAgtRefreshAt = new Map();

export function clearQuotaCache() {
  quotaCache.clear();
  inFlightFetches.clear();
  lastAgtRefreshAt.clear();
}

export function isValidationBlockActive(account, nowSec = Math.floor(Date.now() / 1000)) {
  if (!account?.validation_blocked) return false;
  const until = Number(account.validation_blocked_until);
  if (!Number.isFinite(until) || until <= 0) return true;
  return until > nowSec;
}

export function isAccountAbnormal(account, nowSec = Math.floor(Date.now() / 1000)) {
  if (!account || typeof account !== "object") return true;
  const reason = String(account.proxy_disabled_reason || account.disabled_reason || "");
  return Boolean(
    account.banned ||
      isValidationBlockActive(account, nowSec) ||
      account.quota?.is_forbidden ||
      (account.proxy_disabled &&
        (/^(forbidden \(403\)|banned:)/i.test(reason) || /403 forbidden/i.test(reason))),
  );
}

export function getTierInfo(account) {
  const raw = String(
    account?.quota?.subscription_tier || account?.subscription_tier || account?.tier || "",
  )
    .trim()
    .toLowerCase();
  if (raw.includes("ultra") || raw.includes("helium")) {
    return { tier: "ULTRA", weight: 2.0 };
  }
  if (raw.includes("pro") || raw.includes("premium") || raw.includes("advanced")) {
    return { tier: "PRO", weight: 1.5 };
  }
  return { tier: "FREE", weight: 1.0 };
}

function parsePct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPct(value);
}

function extractBucketRemaining(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  if (typeof bucket.remaining_fraction === "number" && Number.isFinite(bucket.remaining_fraction)) {
    const val = bucket.remaining_fraction <= 1 ? bucket.remaining_fraction * 100 : bucket.remaining_fraction;
    return clampPct(val);
  }
  if (typeof bucket.remaining_percentage === "number" && Number.isFinite(bucket.remaining_percentage)) {
    return clampPct(bucket.remaining_percentage);
  }
  if (typeof bucket.percentage === "number" && Number.isFinite(bucket.percentage)) {
    return clampPct(bucket.percentage);
  }
  if (typeof bucket.remaining === "number" && Number.isFinite(bucket.remaining)) {
    const val = bucket.remaining <= 1 ? bucket.remaining * 100 : bucket.remaining;
    return clampPct(val);
  }
  if (typeof bucket.used_percentage === "number" && Number.isFinite(bucket.used_percentage)) {
    return clampPct(100 - bucket.used_percentage);
  }
  if (typeof bucket.used === "number" && Number.isFinite(bucket.used)) {
    return clampPct(100 - bucket.used);
  }
  return null;
}

function parseResetMs(raw, nowMs) {
  if (raw === undefined || raw === null || raw === "") return null;
  let ms;
  if (typeof raw === "number") {
    ms = raw < 1e11 ? raw * 1000 : raw;
  } else {
    ms = Date.parse(String(raw));
  }
  if (!Number.isFinite(ms) || ms <= nowMs) return null;
  return ms;
}

function normalizeResetSecond(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  let ms;
  if (typeof raw === "number") {
    ms = raw < 1e11 ? raw * 1000 : raw;
  } else {
    ms = Date.parse(String(raw));
  }
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 1000);
}

export function normalizePoolName(groupOrName) {
  const raw =
    typeof groupOrName === "string"
      ? groupOrName
      : String(
          groupOrName?.display_name ??
            groupOrName?.name ??
            groupOrName?.group_name ??
            groupOrName?.bucket_id ??
            groupOrName?.id ??
            "",
        );
  const trimmed = raw.trim();
  if (!trimmed) return "Default";
  if (/^gemini\s+models?$/i.test(trimmed)) return "Gemini";
  if (/claude.*gpt/i.test(trimmed) || /^(3p|third[- ]party)/i.test(trimmed)) return "Claude & GPT";
  if (/^gemini\s+4\s+argon$/i.test(trimmed) || /^argon(\s+models?)?$/i.test(trimmed)) {
    return "Gemini 4 Argon";
  }
  return trimmed;
}

export function shortPoolLabel(poolName) {
  const key = String(poolName || "").trim().toLowerCase();
  if (key === "gemini") return "Gemini";
  if (key === "claude & gpt") return "Claude";
  if (key === "gemini 4 argon") return "Argon";
  return String(poolName || "").trim() || "Pool";
}

function poolOrderRank(poolKey) {
  if (poolKey === "gemini") return 0;
  if (poolKey === "claude & gpt") return 1;
  if (poolKey === "gemini 4 argon") return 2;
  return 10;
}

function inferModelFamily(baseId) {
  const lower = String(baseId || "").toLowerCase();
  if (lower.startsWith("claude")) return "Claude";
  if (lower.startsWith("gemini") || lower.startsWith("imagen")) return "Gemini";
  if (lower.startsWith("gpt")) return "GPT";
  return titleCaseModelId(lower.split("-")[0] || "Model");
}

function discoverPools(accounts) {
  const map = new Map();
  let seq = 0;

  for (const acc of accounts) {
    const groups = Array.isArray(acc?.quota?.quota_groups) ? acc.quota.quota_groups : [];
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const name = normalizePoolName(g);
      const key = name.toLowerCase();
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          name,
          shortLabel: shortPoolLabel(name),
          order: seq++,
          descriptions: new Set(),
          rawModels: new Set(),
        };
        map.set(key, entry);
      }
      if (typeof g.description === "string" && g.description.trim()) {
        entry.descriptions.add(g.description.trim().toLowerCase());
      }
      for (const m of g.models ?? []) {
        const id = typeof m === "string" ? m : m?.id ?? m?.name ?? m?.model_id;
        if (typeof id === "string" && id.trim()) {
          const cleanId = id.trim().replace(/^models\//, "");
          entry.rawModels.add(cleanId.toLowerCase());
          entry.rawModels.add(foldModelId(cleanId).baseId.toLowerCase());
        }
      }
    }
  }

  // Fallback when accounts only carry quota.models without quota_groups
  if (map.size === 0) {
    const foundFamilies = new Set();
    for (const acc of accounts) {
      for (const m of acc?.quota?.models ?? []) {
        const raw = String(m?.name || m?.id || "").toLowerCase();
        if (!raw || m?.disabled || raw.includes("-disabled") || raw.endsWith("_disabled")) continue;
        if (raw.includes("argon")) foundFamilies.add("Gemini 4 Argon");
        else if (raw.startsWith("claude") || raw.startsWith("gpt")) foundFamilies.add("Claude & GPT");
        else if (raw.startsWith("gemini") || raw.startsWith("imagen")) foundFamilies.add("Gemini");
      }
    }
    for (const name of foundFamilies) {
      const key = name.toLowerCase();
      map.set(key, {
        key,
        name,
        shortLabel: shortPoolLabel(name),
        order: seq++,
        descriptions: new Set(),
        rawModels: new Set(),
      });
    }
  }

  return [...map.values()].sort((a, b) => {
    const ra = poolOrderRank(a.key);
    const rb = poolOrderRank(b.key);
    if (ra !== rb) return ra - rb;
    return a.order - b.order;
  });
}

function extractBucketsFromGroup(group, nowMs, poolKey) {
  let h5 = null;
  let weekly = null;
  let reset5hMs = null;
  let reset7dMs = null;

  const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
  for (const b of buckets) {
    if (!b || typeof b !== "object") continue;
    const tag = `${b.window || ""} ${b.bucket_id || ""} ${b.display_name || ""}`.toLowerCase();
    const rem = extractBucketRemaining(b);
    const resetMs = parseResetMs(b.reset_time ?? b.resets_at ?? b.reset_at ?? b.resetsAt, nowMs);
    if (/week|7d/.test(tag)) {
      if (rem !== null && (weekly === null || rem < weekly)) weekly = rem;
      if (resetMs !== null && (reset7dMs === null || resetMs < reset7dMs)) reset7dMs = resetMs;
    } else if (/5h|hour/.test(tag)) {
      if (rem !== null && (h5 === null || rem < h5)) h5 = rem;
      if (resetMs !== null && (reset5hMs === null || resetMs < reset5hMs)) reset5hMs = resetMs;
    } else if (rem !== null) {
      if (resetMs !== null && resetMs - nowMs > 12 * 3600 * 1000) {
        if (weekly === null || rem < weekly) weekly = rem;
        if (reset7dMs === null || resetMs < reset7dMs) reset7dMs = resetMs;
      } else {
        if (h5 === null || rem < h5) h5 = rem;
        if (resetMs !== null && (reset5hMs === null || resetMs < reset5hMs)) reset5hMs = resetMs;
      }
    }
  }

  // Fallback for simplified group shapes without buckets[]
  if (buckets.length === 0 && group && typeof group === "object") {
    const direct5h = extractBucketRemaining(group.five_hour ?? group.h5);
    const direct7d = extractBucketRemaining(group.weekly ?? group.d7);
    if (direct5h !== null) h5 = direct5h;
    if (direct7d !== null) weekly = direct7d;
    const r5 = parseResetMs(group.five_hour?.reset_time ?? group.five_hour?.resets_at ?? group.reset_time_5h, nowMs);
    const r7 = parseResetMs(group.weekly?.reset_time ?? group.weekly?.resets_at ?? group.reset_time_weekly, nowMs);
    if (r5 !== null) reset5hMs = r5;
    if (r7 !== null) reset7dMs = r7;
    if (h5 === null && weekly === null) {
      const rem = extractBucketRemaining(group);
      const r = parseResetMs(group.reset_time ?? group.resets_at ?? group.reset_at, nowMs);
      if (rem !== null) {
        if (poolKey === "gemini 4 argon" || (r !== null && r - nowMs > 12 * 3600 * 1000)) {
          weekly = rem;
          reset7dMs = r;
        } else {
          h5 = rem;
          reset5hMs = r;
        }
      }
    }
  }

  return { h5, weekly, reset5hMs, reset7dMs };
}

function accountSupportsClaude(account) {
  const groups = Array.isArray(account?.quota?.quota_groups) ? account.quota.quota_groups : [];
  const hasClaudeGroup = groups.some((g) => normalizePoolName(g).toLowerCase() === "claude & gpt");
  const models = Array.isArray(account?.quota?.models) ? account.quota.models : [];
  if (models.length === 0) return hasClaudeGroup;
  return models.some((m) => {
    const name = String(m?.name || m?.id || "").toLowerCase();
    if (!name || m?.disabled || name.includes("-disabled") || name.endsWith("_disabled")) return false;
    return name.startsWith("claude") || name.startsWith("gpt");
  });
}

function extractModelFallback(account, poolKey, nowMs) {
  const models = Array.isArray(account?.quota?.models) ? account.quota.models : [];
  const matching = models.filter((m) => {
    const name = String(m?.name || m?.id || "").toLowerCase();
    if (!name || m?.disabled || name.includes("-disabled") || name.endsWith("_disabled")) return false;
    if (poolKey === "gemini 4 argon") return name.includes("argon");
    if (poolKey === "claude & gpt") return name.startsWith("claude") || name.startsWith("gpt");
    if (poolKey === "gemini") return (name.startsWith("gemini") || name.startsWith("imagen")) && !name.includes("argon");
    return false;
  });
  if (matching.length === 0) return { h5: null, weekly: null, reset5hMs: null, reset7dMs: null };

  let h5 = null;
  let weekly = null;
  let reset5hMs = null;
  let reset7dMs = null;

  for (const m of matching) {
    const pct = parsePct(
      m.percentage ?? (typeof m.remaining_fraction === "number" ? m.remaining_fraction * 100 : undefined),
    );
    if (pct === null) continue;
    const resetMs = parseResetMs(m.reset_time ?? m.resets_at, nowMs);
    if (poolKey === "gemini 4 argon") {
      if (weekly === null || pct < weekly) weekly = pct;
      if (resetMs !== null && (reset7dMs === null || resetMs < reset7dMs)) reset7dMs = resetMs;
    } else if (resetMs !== null && resetMs - nowMs > 6 * 3600 * 1000) {
      if (weekly === null || pct < weekly) weekly = pct;
      if (reset7dMs === null || resetMs < reset7dMs) reset7dMs = resetMs;
    } else {
      if (h5 === null || pct < h5) h5 = pct;
      if (resetMs !== null && (reset5hMs === null || resetMs < reset5hMs)) reset5hMs = resetMs;
    }
  }
  return { h5, weekly, reset5hMs, reset7dMs };
}

export function extractAccountPoolQuotas(account, nowMs = Date.now(), discoveredPools = null) {
  const pools = Array.isArray(discoveredPools) ? discoveredPools : discoverPools([account]);
  const groups = Array.isArray(account?.quota?.quota_groups) ? account.quota.quota_groups : [];
  const { tier } = getTierInfo(account);
  const supportsClaude = accountSupportsClaude(account);

  const result = {};

  for (const pool of pools) {
    if (pool.key === "claude & gpt" && !supportsClaude) {
      result[pool.key] = { h5: null, weekly: null, reset5hMs: null, reset7dMs: null };
      continue;
    }

    let h5 = null;
    let weekly = null;
    let reset5hMs = null;
    let reset7dMs = null;

    for (const g of groups) {
      if (normalizePoolName(g).toLowerCase() !== pool.key) continue;
      const b = extractBucketsFromGroup(g, nowMs, pool.key);
      if (b.h5 !== null && (h5 === null || b.h5 < h5)) h5 = b.h5;
      if (b.weekly !== null && (weekly === null || b.weekly < weekly)) weekly = b.weekly;
      if (b.reset5hMs !== null && (reset5hMs === null || b.reset5hMs < reset5hMs)) reset5hMs = b.reset5hMs;
      if (b.reset7dMs !== null && (reset7dMs === null || b.reset7dMs < reset7dMs)) reset7dMs = b.reset7dMs;
    }

    if (h5 === null && weekly === null && groups.length === 0) {
      const fb = extractModelFallback(account, pool.key, nowMs);
      h5 = fb.h5;
      weekly = fb.weekly;
      reset5hMs = fb.reset5hMs;
      reset7dMs = fb.reset7dMs;
    }

    result[pool.key] = { h5, weekly, reset5hMs, reset7dMs };
  }

  // ULTRA plan fallback: Argon shares the larger Gemini quota bucket when no separate Argon group exists
  const argon = result["gemini 4 argon"];
  const gemini = result["gemini"];
  if (
    tier === "ULTRA" &&
    gemini &&
    (gemini.weekly !== null || gemini.h5 !== null) &&
    (!argon || (argon.h5 === null && argon.weekly === null))
  ) {
    result["gemini 4 argon"] = {
      h5: null,
      weekly: gemini.weekly ?? gemini.h5,
      reset5hMs: null,
      reset7dMs: gemini.reset7dMs ?? gemini.reset5hMs,
    };
  }

  return result;
}

function computePoolAggregate(accounts, poolKey, nowMs, discoveredPools) {
  let sumEffectiveWeighted = 0;
  let sumWeightEffective = 0;
  let sum5hWeighted = 0;
  let sumWeight5h = 0;
  let sum7dWeighted = 0;
  let sumWeight7d = 0;

  let minResetEffectiveMs = null;
  let minReset5hMs = null;
  let minReset7dMs = null;
  let count = 0;

  for (const a of accounts) {
    const q = extractAccountPoolQuotas(a, nowMs, discoveredPools)[poolKey];
    if (!q) continue;
    const h5 = poolKey === "gemini 4 argon" ? null : q.h5;
    const weekly = q.weekly !== null ? q.weekly : poolKey === "gemini 4 argon" ? q.h5 : null;
    if (h5 === null && weekly === null) continue;

    const { weight } = getTierInfo(a);
    count++;

    if (h5 !== null) {
      const effective5h = weekly !== null && weekly <= 0 ? 0 : h5;
      sum5hWeighted += effective5h * weight;
      sumWeight5h += weight;
      if (q.reset5hMs !== null && (minReset5hMs === null || q.reset5hMs < minReset5hMs)) {
        minReset5hMs = q.reset5hMs;
      }
    }
    if (weekly !== null) {
      sum7dWeighted += weekly * weight;
      sumWeight7d += weight;
      if (q.reset7dMs !== null && (minReset7dMs === null || q.reset7dMs < minReset7dMs)) {
        minReset7dMs = q.reset7dMs;
      }
    }

    const effectiveRem =
      weekly !== null && weekly <= 0
        ? 0
        : weekly !== null && h5 !== null
          ? Math.min(h5, weekly)
          : (h5 ?? weekly);

    sumEffectiveWeighted += effectiveRem * weight;
    sumWeightEffective += weight;

    const candidateReset =
      weekly !== null && weekly <= 0
        ? (q.reset7dMs ?? q.reset5hMs)
        : (q.reset5hMs ?? q.reset7dMs);
    if (candidateReset !== null && (minResetEffectiveMs === null || candidateReset < minResetEffectiveMs)) {
      minResetEffectiveMs = candidateReset;
    }
  }

  const effectiveRemPct = sumWeightEffective > 0 ? clampPct(sumEffectiveWeighted / sumWeightEffective) : null;
  const h5RemPct = sumWeight5h > 0 ? clampPct(sum5hWeighted / sumWeight5h) : null;
  const weeklyRemPct = sumWeight7d > 0 ? clampPct(sum7dWeighted / sumWeight7d) : null;

  return {
    count,
    usedEffective: effectiveRemPct !== null ? clampPct(100 - effectiveRemPct) : null,
    used5h: h5RemPct !== null ? clampPct(100 - h5RemPct) : null,
    used7d: weeklyRemPct !== null ? clampPct(100 - weeklyRemPct) : null,
    resetsAtEffective: minResetEffectiveMs !== null ? new Date(minResetEffectiveMs).toISOString() : undefined,
    resetsAt5h: minReset5hMs !== null ? new Date(minReset5hMs).toISOString() : undefined,
    resetsAt7d: minReset7dMs !== null ? new Date(minReset7dMs).toISOString() : undefined,
    span: sumWeight5h > 0 ? 18000 : 604800,
  };
}

function collectModelInfos(accounts, discoveredModels, foldEffortVariants = false) {
  const infos = new Map();
  let hasDiscovered = false;

  if (discoveredModels && typeof discoveredModels === "object") {
    const entries = Array.isArray(discoveredModels)
      ? discoveredModels.map((m) => [m?.id, m])
      : Object.entries(discoveredModels);
    for (const [id, m] of entries) {
      if (!id || !m || typeof m !== "object") continue;
      const cleanId = String(id).trim().replace(/^models\//, "");
      if (!cleanId) continue;
      const targetId = foldEffortVariants ? foldModelId(cleanId).baseId : cleanId;
      if (!targetId) continue;
      hasDiscovered = true;
      if (!infos.has(targetId)) {
        infos.set(targetId, {
          id: targetId,
          name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : titleCaseModelId(targetId),
          family: typeof m.family === "string" && m.family.trim() ? m.family.trim() : inferModelFamily(targetId),
        });
      }
    }
  }

  for (const acc of accounts) {
    for (const m of acc?.quota?.models ?? []) {
      const raw = String(m?.name || m?.id || "").trim().replace(/^models\//, "");
      const lower = raw.toLowerCase();
      if (!raw || m?.disabled || lower.includes("-disabled") || lower.endsWith("_disabled")) continue;
      const { baseId } = foldModelId(raw);
      if (baseId && !infos.has(baseId)) {
        infos.set(baseId, {
          id: baseId,
          name: titleCaseModelId(baseId),
          family: inferModelFamily(baseId),
        });
      }
      if (!foldEffortVariants && !hasDiscovered && raw !== baseId && !infos.has(raw)) {
        infos.set(raw, {
          id: raw,
          name: titleCaseModelId(raw),
          family: inferModelFamily(baseId || raw),
        });
      }
    }
  }

  return [...infos.values()];
}

function mapModelsToPools(accounts, discoveredPools, modelInfos) {
  const poolByKey = new Map(discoveredPools.map((p) => [p.key, p]));
  // 1. Score exact reset_time matches per (model exact/baseId, poolKey) across accounts
  const exactScores = new Map(); // rawId -> Map(poolKey -> score)
  const baseScores = new Map(); // baseId -> Map(poolKey -> score)

  for (const acc of accounts) {
    const groups = Array.isArray(acc?.quota?.quota_groups) ? acc.quota.quota_groups : [];
    const poolResetSets = new Map();

    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const pKey = normalizePoolName(g).toLowerCase();
      let set = poolResetSets.get(pKey);
      if (!set) {
        set = new Set();
        poolResetSets.set(pKey, set);
      }
      for (const b of g.buckets ?? []) {
        const sec = normalizeResetSecond(b?.reset_time ?? b?.resets_at ?? b?.reset_at ?? b?.resetsAt);
        if (sec !== null) set.add(sec);
      }
      const gSec = normalizeResetSecond(g.reset_time ?? g.resets_at ?? g.reset_at);
      if (gSec !== null) set.add(gSec);
    }

    for (const m of acc?.quota?.models ?? []) {
      const raw = String(m?.name || m?.id || "").trim().replace(/^models\//, "");
      const lower = raw.toLowerCase();
      if (!raw || m?.disabled || lower.includes("-disabled") || lower.endsWith("_disabled")) continue;
      const { baseId } = foldModelId(raw);
      const mSec = normalizeResetSecond(m?.reset_time ?? m?.resets_at ?? m?.reset_at);
      if (!baseId || mSec === null) continue;

      const matchedPools = [];
      for (const [pKey, set] of poolResetSets.entries()) {
        if (set.has(mSec)) matchedPools.push(pKey);
      }
      if (matchedPools.length === 0) continue;

      const delta = matchedPools.length === 1 ? 2 : 1;
      const addScores = (targetMap, key) => {
        let mScores = targetMap.get(key);
        if (!mScores) {
          mScores = new Map();
          targetMap.set(key, mScores);
        }
        for (const pKey of matchedPools) {
          mScores.set(pKey, (mScores.get(pKey) || 0) + delta);
        }
      };

      addScores(exactScores, raw);
      addScores(baseScores, baseId);
    }
  }

  const mapped = new Map();

  for (const info of modelInfos) {
    const { baseId } = foldModelId(info.id);
    const mScores = exactScores.get(info.id) ?? baseScores.get(baseId);
    if (mScores && mScores.size > 0) {
      let bestKey = null;
      let bestScore = -1;
      let tie = false;
      for (const [pKey, s] of mScores.entries()) {
        if (s > bestScore) {
          bestScore = s;
          bestKey = pKey;
          tie = false;
        } else if (s === bestScore) {
          tie = true;
        }
      }
      if (bestKey && !tie && poolByKey.has(bestKey)) {
        mapped.set(info.id, poolByKey.get(bestKey));
        continue;
      }
    }

    // 2. Fallback: explicit rawModels or description mention
    const lowerId = info.id.toLowerCase();
    const lowerBaseId = baseId.toLowerCase();
    const lowerName = info.name.toLowerCase();
    const cleanBaseName = lowerName
      .replace(/\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i, "")
      .trim();
    let matchedPool = null;
    for (const p of discoveredPools) {
      if (p.rawModels.has(lowerId) || p.rawModels.has(lowerBaseId)) {
        matchedPool = p;
        break;
      }
      for (const desc of p.descriptions) {
        if (
          (lowerName.length >= 5 && desc.includes(lowerName)) ||
          (cleanBaseName.length >= 5 && desc.includes(cleanBaseName)) ||
          (lowerId.length >= 5 && desc.includes(lowerId)) ||
          (lowerBaseId.length >= 5 && desc.includes(lowerBaseId))
        ) {
          matchedPool = p;
          break;
        }
      }
      if (matchedPool) break;
    }
    if (matchedPool) {
      mapped.set(info.id, matchedPool);
      continue;
    }

    // 3. Fallback: model family heuristics
    if (/argon|orchestrator-g1/.test(lowerBaseId)) {
      matchedPool = poolByKey.get("gemini 4 argon") ?? poolByKey.get("gemini") ?? null;
    } else if (/^(claude|gpt|o1|o3|o4)/.test(lowerBaseId)) {
      matchedPool = poolByKey.get("claude & gpt") ?? null;
    } else if (/^(gemini|imagen|gemma)/.test(lowerBaseId)) {
      matchedPool = poolByKey.get("gemini") ?? null;
    } else {
      matchedPool =
        discoveredPools.find((p) => p.key.includes(lowerBaseId) || lowerBaseId.includes(p.key)) ??
        discoveredPools[0] ??
        null;
    }

    if (matchedPool) {
      mapped.set(info.id, matchedPool);
    }
  }

  return mapped;
}

function accountDisplayName(account) {
  const custom = typeof account?.custom_label === "string" ? account.custom_label.trim() : "";
  if (custom) return custom;
  const name = typeof account?.name === "string" ? account.name.trim() : "";
  if (name) return name;
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (email) return email.split("@")[0] || "account";
  return String(account?.id || "account");
}

function accountStatusText(account, nowSec) {
  if (account?.banned) return "已封禁";
  if (isValidationBlockActive(account, nowSec) || account?.quota?.is_forbidden) return "403 验证中";
  if (isAccountAbnormal(account, nowSec)) return "异常";
  if (account?.disabled) return "已禁用";
  if (account?.proxy_disabled) return "已停用代理";
  return "在线";
}

function formatPlanSummary(activePool, totalCount) {
  if (!Array.isArray(activePool) || activePool.length === 0) {
    return `0/${totalCount} 在线`;
  }
  const counts = new Map();
  for (const a of activePool) {
    const { tier } = getTierInfo(a);
    counts.set(tier, (counts.get(tier) || 0) + 1);
  }
  const order = ["ULTRA", "PRO", "FREE"];
  const parts = [];
  for (const t of order) {
    const n = counts.get(t);
    if (n) parts.push(`${t} ×${n}`);
  }
  return parts.length > 0 ? parts.join(" + ") : `${activePool.length}/${totalCount} 在线`;
}

function fmtPct(v) {
  return v === null || v === undefined ? "-" : `${v}%`;
}

export function computeAgtUsage(accounts, options = {}) {
  const {
    onlyProxyPool = true,
    showAccountDetails = true,
    maxAccountDetails = 0,
    foldEffortVariants = false,
    discoveredModels = null,
    nowMs = Date.now(),
  } = options;
  const nowSec = Math.floor(nowMs / 1000);
  const list = Array.isArray(accounts) ? accounts : [];

  const available = list.filter((a) => !isAccountAbnormal(a, nowSec) && !a.disabled);
  const proxyOnline = available.filter((a) => !a.proxy_disabled);
  const activePool = onlyProxyPool ? (proxyOnline.length > 0 ? proxyOnline : available) : available;

  const discoveredPools = discoverPools(activePool.length > 0 ? activePool : list);
  // Ensure "gemini 4 argon" virtual pool exists if any ULTRA account in activePool has gemini quota and no explicit argon group
  const hasUltraInActive = activePool.some((a) => getTierInfo(a).tier === "ULTRA");
  if (
    hasUltraInActive &&
    discoveredPools.some((p) => p.key === "gemini") &&
    !discoveredPools.some((p) => p.key === "gemini 4 argon")
  ) {
    discoveredPools.push({
      key: "gemini 4 argon",
      name: "Gemini 4 Argon",
      shortLabel: "Argon",
      order: 99,
      descriptions: new Set(),
      rawModels: new Set(),
    });
    discoveredPools.sort((a, b) => {
      const ra = poolOrderRank(a.key);
      const rb = poolOrderRank(b.key);
      if (ra !== rb) return ra - rb;
      return a.order - b.order;
    });
  }

  const poolAggregates = new Map();
  for (const pool of discoveredPools) {
    poolAggregates.set(pool.key, computePoolAggregate(activePool, pool.key, nowMs, discoveredPools));
  }

  const modelInfos = collectModelInfos(
    activePool.length > 0 ? activePool : list,
    discoveredModels,
    foldEffortVariants,
  );
  const modelToPool = mapModelsToPools(
    activePool.length > 0 ? activePool : list,
    discoveredPools,
    modelInfos,
  );

  const windows = [];

  // 1. Non-aside per-model scoped windows (NO whole-account window)
  for (const info of modelInfos) {
    const pool = modelToPool.get(info.id);
    if (!pool) continue;
    const agg = poolAggregates.get(pool.key);
    if (!agg || agg.usedEffective === null) continue;
    windows.push({
      name: info.name,
      model: info.id,
      models: [info.id],
      family: info.family,
      pool: pool.name,
      used: agg.usedEffective,
      ...(agg.resetsAtEffective ? { resetsAt: agg.resetsAtEffective } : {}),
      span: agg.span,
    });
  }

  // 2. Aside pool summary windows (with pool, NO family)
  let poolSummaryCount = 0;
  const addPoolSummary = (name, poolName, used, resetsAt, span) => {
    if (used === null) return;
    poolSummaryCount++;
    windows.push({
      name,
      pool: poolName,
      used,
      ...(resetsAt ? { resetsAt } : {}),
      span,
      aside: true,
    });
  };

  for (const pool of discoveredPools) {
    const agg = poolAggregates.get(pool.key);
    if (!agg) continue;
    addPoolSummary("5 hours", pool.name, agg.used5h, agg.resetsAt5h, 18000);
    addPoolSummary("7 days", pool.name, agg.used7d, agg.resetsAt7d, 604800);
  }

  // 3. Optional per-account detail windows (aligned cleanly on 2-column grid, max 1 " · " per display)
  if (showAccountDetails && list.length > 0) {
    if (poolSummaryCount % 2 === 1) {
      windows.push({
        name: "账号池",
        display: `${activePool.length}/${list.length} 在线`,
        aside: true,
      });
    }
    const maxLimit =
      Number.isFinite(Number(maxAccountDetails)) && Number(maxAccountDetails) > 0
        ? Math.floor(Number(maxAccountDetails))
        : 0;
    const visibleAccounts = maxLimit > 0 && list.length > maxLimit ? list.slice(0, maxLimit) : list;

    for (const a of visibleAccounts) {
      const { tier } = getTierInfo(a);
      const label = accountDisplayName(a);
      const status = accountStatusText(a, nowSec);
      let display;
      if (status === "在线") {
        const qMap = extractAccountPoolQuotas(a, nowMs, discoveredPools);
        const segments = [];
        for (const pool of discoveredPools) {
          const q = qMap[pool.key];
          if (!q || (q.h5 === null && q.weekly === null)) continue;
          if (q.h5 !== null && q.weekly !== null) {
            segments.push(`${pool.shortLabel} ${fmtPct(q.h5)}/${fmtPct(q.weekly)}`);
          } else if (q.weekly !== null) {
            segments.push(`${pool.shortLabel} ${fmtPct(q.weekly)}`);
          } else {
            segments.push(`${pool.shortLabel} ${fmtPct(q.h5)}`);
          }
        }
        if (segments.length === 0) {
          display = "在线";
        } else if (segments.length === 1) {
          display = segments[0];
        } else {
          display = `${segments[0]} · ${segments.slice(1).join("  ")}`;
        }
      } else {
        display = status;
      }
      windows.push({
        name: `${label} · ${tier}`,
        display,
        aside: true,
      });
    }

    if (maxLimit > 0 && list.length > maxLimit) {
      windows.push({
        name: "其他账号",
        display: `另有 ${list.length - maxLimit} 个账号`,
        aside: true,
      });
    }
  }

  return {
    plan: formatPlanSummary(activePool, list.length),
    windows,
  };
}

function parseAccountsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return null;
}

export async function fetchAccountsCached(baseUrl, apiKey, opts = {}) {
  const {
    cacheTtlSec = 0,
    refreshAgtOnUsage = false,
    refreshCooldownSec = 30,
    fetchImpl = globalThis.fetch,
    signal,
    nowMs = Date.now(),
    adminToken = "",
  } = opts;
  const root = normalizeBaseUrl(baseUrl);
  const cleanAdmin = typeof adminToken === "string" ? adminToken.trim().replace(/^Bearer\s+/i, "") : "";
  const quotaToken = cleanAdmin || apiKey;
  const ttlMs = Math.max(0, Number(cacheTtlSec) || 0) * 1000;
  const refreshCooldownMs = Math.max(0, Number(refreshCooldownSec) || 0) * 1000;
  const cacheKey = `${root}\0${quotaToken}`;

  if (ttlMs > 0) {
    const cached = quotaCache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < ttlMs) {
      return cached.accounts;
    }
  }

  if (inFlightFetches.has(cacheKey)) {
    return inFlightFetches.get(cacheKey);
  }

  const run = (async () => {
    const headers = {
      authorization: `Bearer ${quotaToken}`,
      "x-api-key": quotaToken,
      accept: "application/json",
    };

    if (refreshAgtOnUsage) {
      const lastAt = lastAgtRefreshAt.get(cacheKey) ?? -Infinity;
      if (nowMs - lastAt >= refreshCooldownMs) {
        lastAgtRefreshAt.set(cacheKey, nowMs);
        const rCtl = new AbortController();
        const rTimer = setTimeout(() => rCtl.abort(), 12000);
        const rSignal = signal ? AbortSignal.any([signal, rCtl.signal]) : rCtl.signal;
        try {
          await fetchImpl(`${root}/api/accounts/refresh`, {
            method: "POST",
            headers,
            signal: rSignal,
          });
        } catch {
          // Graceful fallback: still read cached Antigravity Tools accounts even if refresh fails/times out
        } finally {
          clearTimeout(rTimer);
        }
      }
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const combined = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
    try {
      const res = await fetchImpl(`${root}/api/accounts`, {
        method: "GET",
        headers,
        signal: combined,
      });
      if (!res.ok) {
        throw new Error(`Antigravity Tools /api/accounts returned HTTP ${res.status}`);
      }
      const data = await res.json();
      const accounts = parseAccountsPayload(data);
      if (!accounts) {
        throw new Error("Antigravity Tools /api/accounts returned unexpected payload shape");
      }
      if (ttlMs > 0) {
        quotaCache.set(cacheKey, { fetchedAt: Date.now(), accounts });
      }
      return accounts;
    } finally {
      clearTimeout(timer);
      inFlightFetches.delete(cacheKey);
    }
  })();

  inFlightFetches.set(cacheKey, run);
  return run;
}

export async function getAgtUsage(params = {}) {
  const {
    baseUrl,
    apiKey,
    adminToken = "",
    onlyProxyPool = true,
    showAccountDetails = true,
    maxAccountDetails = 0,
    foldEffortVariants = false,
    refreshAgtOnUsage = false,
    cacheTtlSec = 0,
    refreshCooldownSec = 30,
    discoveredModels,
    fetchImpl = globalThis.fetch,
    signal,
  } = params;

  const cleanAdmin = typeof adminToken === "string" ? adminToken.trim().replace(/^Bearer\s+/i, "") : "";
  if (!cleanAdmin && !apiKey) {
    return { error: "Antigravity Tools API key is missing" };
  }

  try {
    const accounts = await fetchAccountsCached(baseUrl, apiKey, {
      adminToken: cleanAdmin,
      refreshAgtOnUsage,
      cacheTtlSec,
      refreshCooldownSec,
      fetchImpl,
      signal,
    });
    const resolvedModels =
      discoveredModels !== undefined
        ? discoveredModels
        : getDiscoveredModels(baseUrl, { foldEffortVariants });
    return computeAgtUsage(accounts, {
      onlyProxyPool,
      showAccountDetails,
      maxAccountDetails,
      foldEffortVariants,
      discoveredModels: resolvedModels,
    });
  } catch (err) {
    return { error: err?.message ? String(err.message) : String(err) };
  }
}
