import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ZUCK_MODEL = "muse-spark-1.2-contributor";
export const ZUCK_ENDPOINT = "https://api.meta.ai/v1/responses";
const MAX_FILE_CHARS = 12_000;
const MAX_INPUT_CHARS = 36_000;

const EXCLUDED_NAME = /(^|[\\/])(?:\.env(?:\..*)?|\.dev\.vars|\.wrangler|\.npmrc|\.yarnrc|\.pypirc|secrets?|credentials?|.*(?:secret|credential|password|token|api[_-]?key).*)(?:[\\/]|$)|(?:^|[\\/])(?:dist|build|out|coverage|node_modules)(?:[\\/]|$)|\.(?:pem|key|p12|pfx|secret)$/i;
const SECRET_LINE = /(?:api[_-]?key|secret|password|token|authorization|private(?:[_ -]?key))\s*["']?\s*[:=]/i;
const SECRET_VALUE = /\b(?:sk(?:-proj)?|rk|ghp|github_pat|bnk|cfp|xoxb|xoxp)[A-Za-z0-9._-]+\b|\bAKIA[0-9A-Z]{16}\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi;
const DATABASE_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'`]+/gi;
const LONG_BASE64 = /(?<![A-Za-z0-9])[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9])/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function isExcludedPath(pathName) {
  return EXCLUDED_NAME.test(pathName.replaceAll("\\", "/"));
}

export function redact(text) {
  return String(text)
    .split("\n")
    .map((line) => SECRET_LINE.test(line) ? "[REDACTED SECRET LINE]" : line)
    .join("\n")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(DATABASE_URL, "[REDACTED DATABASE URL]")
    .replace(URL_CREDENTIALS, "$1[REDACTED CREDENTIALS]@")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SECRET_VALUE, "[REDACTED TOKEN]")
    .replace(LONG_BASE64, "[REDACTED LONG SECRET]");
}

function redactWithKey(text, apiKey) {
  const key = String(apiKey ?? "").trim();
  return redact(text).replaceAll(key, "[REDACTED API KEY]");
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
    const rootReal = await realpath(repoRoot);
    let cursor = rootReal;
    for (const segment of relative(rootReal, absolute).split(/[\\/]/)) {
      if (!segment) continue;
      cursor = resolve(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) return null;
    }
    const fileReal = await realpath(absolute);
    const realRel = relative(rootReal, fileReal);
    if (!realRel || realRel.startsWith(`..${sep}`) || isAbsolute(realRel) || isExcludedPath(realRel)) return null;
    const fileInfo = await stat(fileReal);
    if (!fileInfo.isFile()) return null;
    return { path: rel.replaceAll("\\", "/"), content: truncate(await readFile(fileReal, "utf8")) };
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

function sanitize(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return truncate(value, 4_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [truncate(key, 200), sanitize(item, depth + 1)]));
  return value;
}

function reportShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status === "PASS" ? "PASS" : value.status === "NEEDS CHANGES" ? "NEEDS CHANGES" : null;
  if (!status) return null;
  const findings = {};
  for (const severity of ["critical", "high", "medium", "low"]) {
    if (value.findings?.[severity] !== undefined && !Array.isArray(value.findings[severity])) return null;
    const entries = value.findings?.[severity] ?? [];
    if (entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.message !== "string")) return null;
    findings[severity] = sanitize(entries);
  }
  const stringArray = (input) => Array.isArray(input) && input.every((item) => typeof item === "string");
  if (value.affected_files !== undefined && !stringArray(value.affected_files)) return null;
  if (value.recommended_fixes !== undefined && !stringArray(value.recommended_fixes)) return null;
  if (value.missing_tests !== undefined && !stringArray(value.missing_tests)) return null;
  return {
    status,
    findings,
    affected_files: sanitize(value.affected_files ?? []),
    recommended_fixes: sanitize(value.recommended_fixes ?? []),
    missing_tests: sanitize(value.missing_tests ?? []),
  };
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? []).flatMap((item) => item?.content ?? [])
    .map((item) => item?.text ?? item?.value ?? "").filter(Boolean).join("\n");
}

export async function askZuck({ prompt, files = [], diff = "", tests = "", repoRoot = process.cwd(), apiKey = process.env.MODEL_API_KEY, fetchImpl = fetch } = {}) {
  const safeApiKey = String(apiKey ?? "").trim();
  if (!safeApiKey) throw new Error("MODEL_API_KEY is required to ask Zuck.");
  if (/[\r\n\x00-\x1f\x7f]/.test(safeApiKey)) throw new Error("MODEL_API_KEY contains invalid control characters.");
  if (!prompt?.trim()) throw new Error("A review prompt is required.");
  const context = await buildContext({ repoRoot, files, diff, tests });
  const instruction = `You are Zuck, a read-only QA reviewer for Blognice. Review the request and context. Return ONLY valid JSON with this shape: {"status":"PASS"|"NEEDS CHANGES","findings":{"critical":[],"high":[],"medium":[],"low":[]},"affected_files":[],"recommended_fixes":[],"missing_tests":[]}. Each finding should include severity, message, and affected file/line when known. Do not propose or perform edits.\n\nREVIEW PROMPT:\n${redactWithKey(prompt, safeApiKey)}\n\nCONTEXT:\n${redactWithKey(context || "(none supplied)", safeApiKey)}`;
  const response = await fetchImpl(ZUCK_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${safeApiKey}` },
    body: JSON.stringify({ model: ZUCK_MODEL, input: instruction }),
  });
  if (!response.ok) throw new Error(`Zuck request failed with HTTP ${response.status}.`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Zuck returned malformed JSON."); }
  const text = redactWithKey(responseText(payload).slice(0, 100_000), safeApiKey).trim();
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
