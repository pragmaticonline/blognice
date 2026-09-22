// Rerank codebase candidates with Jev before opening files.
//
// Fast search (grep / muse.search) shortlists plausible files; this script
// scores each candidate's snippet against the query with one batched
// TypeSafe request so only the winners get opened.
//
// Usage:
//   TYPESAFE_API_KEY=... node scripts/rerank.mjs '<query>' candidates.json [topN]
// candidates.json: [{id, path, snippet, why?}]. `why` is the evidence that
// shortlisted the file (the grep hit, the import edge) — send evidence, not
// summaries. Prints topN ranked JSON to stdout, latency + token usage to
// stderr. Never prints the API key.

export const API_URL = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-1.13.0";
export const TRUST_FLOOR = 0.5;

export function buildQuestions(query, candidates) {
  const questions = {};
  candidates.forEach((c, i) => {
    questions[`rel_${i}`] = {
      type: "noul",
      instructions: {
        query,
        candidate: {
          path: c.path,
          excerpt: c.snippet,
          ...(c.why ? { shortlisted_by: c.why } : {}),
        },
        question:
          "Is `candidate` relevant to answering `query`? A file that only mentions a keyword in passing (changelog, unrelated feature, test fixture) is NOT relevant.",
      },
      criteria: {
        true: "The file likely contains code that answers the query",
        false: "The file is unrelated or only a passing mention",
      },
    };
  });
  return questions;
}

function answerValue(a) {
  if (a == null) return null;
  return a.noul ?? a.value ?? a.score ?? null;
}

export function rankCandidates(candidates, answers) {
  return candidates
    .map((c, i) => ({ ...c, p: answerValue(answers?.[`rel_${i}`]) }))
    .sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
}

// Confidence is not permission: below the floor the ranking is a suggestion
// to ignore — fall back to grep instead of opening the "winner".
export function assessRanking(ranked) {
  const top = ranked.length > 0 ? ranked[0].p ?? null : null;
  if (top != null && top >= TRUST_FLOOR) return { trustworthy: true, top };
  return { trustworthy: false, top, reason: `top probability ${top} below ${TRUST_FLOOR} — fall back to grep` };
}

export async function scoreCandidates(query, candidates, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY missing");
  const t0 = Date.now();
  const res = await fetchImpl(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: "Rerank each candidate file against the query.",
      model: MODEL,
      questions: buildQuestions(query, candidates),
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { ranked: rankCandidates(candidates, data.answers), usage: data.usage ?? null, ms, model: MODEL };
}

const isMain = process.argv[1]?.endsWith("scripts/rerank.mjs");
if (isMain) {
  const [query, candidatesPath, topArg] = process.argv.slice(2);
  if (!query || !candidatesPath) {
    console.error("usage: TYPESAFE_API_KEY=... node scripts/rerank.mjs '<query>' candidates.json [topN]");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const candidates = JSON.parse(readFileSync(candidatesPath, "utf8"));
  const topN = Number(topArg || 5);
  const { ranked, usage, ms, model } = await scoreCandidates(query, candidates, {
    apiKey: process.env.TYPESAFE_API_KEY,
  });
  console.error(`model ${model} scored ${candidates.length} candidates in ${ms}ms, usage: ${JSON.stringify(usage)}`);
  const verdict = assessRanking(ranked);
  if (!verdict.trustworthy) console.error(`untrusted ranking (${verdict.reason})`);
  console.log(JSON.stringify(ranked.slice(0, topN), null, 1));
}
