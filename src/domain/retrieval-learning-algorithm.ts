import { createHash } from "node:crypto";
import { skillRoutingCasefold } from "./skill-routing-casefold.js";

export const RETRIEVAL_LEARNING_POLICY = Object.freeze({
  minimumJudgedCalls: 8,
  baseSlope: 4,
  baseBias: -2,
  minimumGap: 0.15,
  retainProbability: 0.65,
  discardProbability: 0.35,
  thresholdEwma: 0.1,
  retentionCalls: 512,
  features: 512,
  maxCandidates: 256,
  maxQueryBytes: 8192,
  maxLabelBytes: 262144,
  maxLabels: 10000,
  modelWeightBound: 4,
});
const pythonWhitespace = /[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

export interface LearningCandidate {
  id: string;
  x: number;
  baseX: number;
  basePosition: number;
}

export interface LearningFeedbackCall {
  callId: number;
  queryKey: string;
  candidates: LearningCandidate[];
  queryFeatures: string[];
  relevant: string[];
  judged: string[] | null;
  provenance: "user" | "model";
}

export interface LearningReplay {
  slope: number;
  bias: number;
  threshold: number;
  weights: number[];
  samples: number;
  safeStreak: number;
  modelLabels: number;
  userLabels: number;
  prequential: { evaluatedCalls: number; brier: number | null; logLoss: number | null };
  callMetrics: Map<number, { brier: number | null; logLoss: number | null }>;
}

export function learningIdentity(salt: string, value: string): string {
  return createHash("sha256").update(salt + value, "utf8").digest("hex");
}

export function learningQueryFeatures(salt: string, query: string): string[] {
  const tokens = skillRoutingCasefold(query).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
  return [...new Set(tokens.map(token => learningIdentity(salt, token)))].sort();
}

export function learningQueryKey(salt: string, query: string): string {
  const normalized = skillRoutingCasefold(query).split(pythonWhitespace).filter(Boolean).join(" ");
  return learningIdentity(salt, `query:${normalized}`);
}

export function learningFeatures(id: string, queryFeatures: readonly string[], salt: string): Map<number, number> {
  const keys = [`source:${id}`, `source-secondary:${id}`];
  if (queryFeatures.length) {
    keys.push(`query-source:${id}:${queryFeatures.join(":")}`);
    keys.push(...queryFeatures.slice(0, 8).map(token => `token-source:${id}${token}`));
  }
  const values = new Map<number, number>();
  for (const key of keys) {
    const digest = learningIdentity(salt, key);
    const index = Number.parseInt(digest.slice(0, 8), 16) % RETRIEVAL_LEARNING_POLICY.features;
    const sign = Number.parseInt(digest[8], 16) % 2 ? 1 : -1;
    values.set(index, (values.get(index) ?? 0) + sign / Math.sqrt(keys.length));
  }
  return values;
}

export function learningRank(candidates: readonly LearningCandidate[], queryFeatures: readonly string[],
  weights: readonly number[], salt: string): Array<LearningCandidate & { x: number; position: number; features: Map<number, number> }> {
  if (candidates.length > RETRIEVAL_LEARNING_POLICY.maxCandidates
    || weights.length !== RETRIEVAL_LEARNING_POLICY.features
    || weights.some(weight => !Number.isFinite(weight) || Math.abs(weight) > RETRIEVAL_LEARNING_POLICY.modelWeightBound)) {
    throw new Error("Retrieval learning ranker input exceeds its bounded model contract.");
  }
  return candidates.map((item, position) => {
    const features = learningFeatures(item.id, queryFeatures, salt);
    let delta = 0;
    for (const [feature, value] of features) delta += weights[feature] * value;
    const x = Math.max(0, Math.min(1, item.baseX + 0.75 * Math.tanh(delta)));
    return { ...item, x, position, features };
  }).sort((left, right) => right.x - left.x || left.basePosition - right.basePosition);
}

export function learningProbability(x: number, slope: number, bias: number): number {
  const z = Math.max(-40, Math.min(40, slope * x + bias));
  return 1 / (1 + Math.exp(-z));
}

export function learningGap(candidates: readonly { x: number }[]): { index: number; gap: number } {
  if (candidates.length < 2) return { index: 0, gap: 0 };
  let bestIndex = 0, bestGap = candidates[0].x - candidates[1].x;
  for (let index = 1; index < candidates.length - 1; index++) {
    const gap = candidates[index].x - candidates[index + 1].x;
    if (gap > bestGap) { bestGap = gap; bestIndex = index; }
  }
  return { index: bestIndex + 1, gap: bestGap };
}

export function replayLearning(calls: readonly LearningFeedbackCall[], salt: string,
  userAuthorities: ReadonlyMap<string, LearningFeedbackCall> = new Map()): LearningReplay {
  const policy = RETRIEVAL_LEARNING_POLICY;
  const effective = [
    ...calls.filter(call => !userAuthorities.has(call.queryKey)),
    ...userAuthorities.values(),
  ].sort((a, b) => a.callId - b.callId);
  const weights = Array<number>(policy.features).fill(0);
  let slope: number = policy.baseSlope, bias: number = policy.baseBias, threshold: number = policy.minimumGap;
  let samples = 0, safeStreak = 0, modelLabels = 0, userLabels = 0;
  let totalBrier = 0, totalLoss = 0, evaluatedCalls = 0;
  const callMetrics = new Map<number, { brier: number | null; logLoss: number | null }>();

  for (const call of effective) {
    const relevant = new Set(call.relevant);
    const judged = call.judged === null ? null : new Set(call.judged);
    const candidates = call.candidates.filter(item => judged === null || judged.has(item.id));
    const ranked = learningRank(candidates, call.queryFeatures, weights, salt);
    const gradients: Array<{ error: number; x: number }> = [];
    let brier = 0, loss = 0;
    for (const item of ranked) {
      const target = relevant.has(item.id) ? 1 : 0;
      const probability = learningProbability(item.x, slope, bias);
      brier += (target - probability) ** 2;
      loss -= target * Math.log(Math.max(1e-12, probability))
        + (1 - target) * Math.log(Math.max(1e-12, 1 - probability));
      gradients.push({ error: target - probability, x: item.x });
    }

    const count = ranked.length;
    if (count) {
      brier /= count;
      loss /= count;
      totalBrier += brier;
      totalLoss += loss;
      evaluatedCalls++;
      slope = Math.max(0.1, Math.min(16, slope + 0.25 * gradients.reduce((sum, item) => sum + item.error * item.x, 0) / count));
      bias = Math.max(-12, Math.min(12, bias + 0.25 * gradients.reduce((sum, item) => sum + item.error, 0) / count));
      const updates = new Map<number, number>();
      for (const item of ranked) {
        const error = (relevant.has(item.id) ? 1 : 0) - learningProbability(item.x, policy.baseSlope, policy.baseBias);
        for (const [feature, value] of item.features) updates.set(feature, (updates.get(feature) ?? 0) + error * value);
      }
      for (const [feature, update] of updates) {
        weights[feature] = Math.max(-policy.modelWeightBound,
          Math.min(policy.modelWeightBound, weights[feature] + 0.5 * update / Math.max(1, count / 8)));
      }
    }
    callMetrics.set(call.callId, { brier: count ? brier : null, logLoss: count ? loss : null });

    const { index: k, gap } = learningGap(ranked);
    const topIds = new Set(ranked.slice(0, k).map(item => item.id));
    const safe = judged === null && relevant.size > 0 && k > 0 && gap >= policy.minimumGap
      && [...relevant].every(id => topIds.has(id));
    if (judged === null) {
      const target = safe ? Math.max(policy.minimumGap, gap * 0.75)
        : Math.min(0.95, Math.max(policy.minimumGap, gap + 0.1));
      threshold = Math.max(policy.minimumGap, Math.min(0.95,
        (1 - policy.thresholdEwma) * threshold + policy.thresholdEwma * target));
    }
    samples++;
    safeStreak = safe ? safeStreak + 1 : 0;
    modelLabels += call.provenance === "model" ? 1 : 0;
    userLabels += call.provenance === "user" ? 1 : 0;
  }

  return {
    slope, bias, threshold, weights, samples, safeStreak, modelLabels, userLabels,
    prequential: {
      evaluatedCalls,
      brier: evaluatedCalls ? totalBrier / evaluatedCalls : null,
      logLoss: evaluatedCalls ? totalLoss / evaluatedCalls : null,
    },
    callMetrics,
  };
}

export function learningCalibrationReady(enabled: boolean, samples: number, safeStreak: number): boolean {
  return enabled && samples >= RETRIEVAL_LEARNING_POLICY.minimumJudgedCalls
    && safeStreak >= RETRIEVAL_LEARNING_POLICY.minimumJudgedCalls;
}
