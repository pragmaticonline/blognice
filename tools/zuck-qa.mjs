import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ZUCK_MODEL = "muse-spark-1.2";
export const ZUCK_ENDPOINT = "https://api.meta.ai/v1/responses";
const MAX_FILE_CHARS = 12_000;
const MAX_INPUT_CHARS = 36_000;

const EXCLUDED_NAME = /(^|[\\/])(?:\.env(?:\..*)?|\.dev\.vars|\.wrangler|secrets?|credentials?)(?:[\\/]|$)|(?:^|[\\/])(?:dist|build|out|coverage|node_modules)(?:[\\/]|$)|\.(?:pem|key|p12|pfx|secret)$/i;
const SECRET_LINE = /(?:api[_-]?key|secret|password|token|authorization|private[_-]?key)\s*["']?\s*[:=]/i;
const SECRET_VALUE = /\b(?:sk|rk|ghp|github_pat|bnk|cfp|xoxb|xoxp)_[A-Za-z0-9._-]+\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function isExcludedPath(pathName) {
  return EXCLUDED_NAME.test(pathName.replaceAll("\\", "/"));
}

export function redact(text) {
  return String(text)
    .split("\n")
    .map((line) => SECRET_LINE.test(line) ? "[REDACTED SECRET LINE]" : line)
    .join("\n")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SECRET_VALUE, "[REDACTED TOKEN]");
}

function truncate(text, limit = MAX_FILE_CHARS) {
  const value = redact(text);
  return value.length > limit ? `${value.slice(0, limit)}\n[TRUNCATED]` : value;
}

async function readContextFile(repoRoot, requestedPath) {
  const absolute = resolve(repoRoot, requestedPath);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || isExcludedPath(rel)) return null;
  try {
    const fileInfo = await stat(absolute);
    if (!fileInfo.isFile()) return null;
    return { path: rel.replaceAll("\\", "/"), content: truncate(await readFile(absolute, "utf8")) };
  } catch {
    return null;
  }
}

export async function buildContext({ repoRoot = process.cwd(), files = [], diff = "", tests = "" } = {}) {
  const parts = [];
  for (const pathName of [...new Set(files)]) {
    const item = await readContextFile(repoRoot, pathName);
    if (item) parts.push(`FILE: ${item.path}\n${item.content}`);
  }
  if (diff) parts.push(`GIT DIFF:\n${truncate(diff, 16_000)}`);
  if (tests) parts.push(`TEST / TYPECHECK OUTPUT:\n${truncate(tests, 8_000)}`);
  return truncate(parts.join("\n\n"), MAX_INPUT_CHARS);
}

function reportShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status === "PASS" ? "PASS" : value.status === "NEEDS CHANGES" ? "NEEDS CHANGES" : null;
  if (!status) return null;
  return {
    status,
    findings: value.findings && typeof value.findings === "object" ? value.findings : {},
    affected_files: Array.isArray(value.affected_files) ? value.affected_files : [],
    recommended_fixes: Array.isArray(value.recommended_fixes) ? value.recommended_fixes : [],
    missing_tests: Array.isArray(value.missing_tests) ? value.missing_tests : [],
  };
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? []).flatMap((item) => item?.content ?? [])
    .map((item) => item?.text ?? item?.value ?? "").filter(Boolean).join("\n");
}

export async function askZuck({ prompt, files = [], diff = "", tests = "", repoRoot = process.cwd(), apiKey = process.env.MODEL_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("MODEL_API_KEY is required to ask Zuck.");
  if (!prompt?.trim()) throw new Error("A review prompt is required.");
  const context = await buildContext({ repoRoot, files, diff, tests });
  const instruction = `You are Zuck, a read-only QA reviewer for Blognice. Review the request and context. Return ONLY valid JSON with this shape: {"status":"PASS"|"NEEDS CHANGES","findings":{"critical":[],"high":[],"medium":[],"low":[]},"affected_files":[],"recommended_fixes":[],"missing_tests":[]}. Each finding should include severity, message, and affected file/line when known. Do not propose or perform edits.\n\nREVIEW PROMPT:\n${redact(prompt)}\n\nCONTEXT:\n${context || "(none supplied)"}`;
  const response = await fetchImpl(ZUCK_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: ZUCK_MODEL, input: instruction }),
  });
  if (!response.ok) throw new Error(`Zuck request failed with HTTP ${response.status}.`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Zuck returned malformed JSON."); }
  const text = responseText(payload).trim();
  let parsed;
  try { parsed = reportShape(JSON.parse(text)); } catch { parsed = null; }
  if (!parsed) throw new Error("Zuck returned an unusable QA report.");
  return parsed;
}

function valuesAfter(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) values.push(args[++i]);
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const prompt = valuesAfter(args, "--prompt")[0];
  askZuck({ prompt, files: valuesAfter(args, "--file"), diff: valuesAfter(args, "--diff")[0] ?? "", tests: valuesAfter(args, "--tests")[0] ?? "" })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
