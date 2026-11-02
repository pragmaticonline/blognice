export const AI_BRIEF_MODEL = "@cf/ibm-granite/granite-4.0-h-micro" as const;
// Long-form autopilot article generation. Scout writes cleaner prose with far
// fewer degenerate repetition loops than the micro model above; kept separate
// so the micro model stays on short structured tasks (topic/source picks).
export const AI_AUTOPILOT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" as const;
export const AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b" as const;
export const AI_IMAGE_PROMPT_MAX = 2048;
export const AI_SOURCE_MAX = 12_000;

export type ImageContextMode = "prompt" | "post" | "blog";
export type ImageStyle = "editorial-photo" | "editorial-illustration" | "cinematic" | "child-crayon" | "arcade-action" | "risograph" | "paper-collage" | "watercolor" | "minimal" | "auto";
export type ImageContextPost = { title: string; body_md: string };

function plainText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  return value.slice(0, Math.max(0, length - 1)).trimEnd() + "…";
}

export function buildSourceContext(input: {
  prompt?: string;
  mode: ImageContextMode;
  blogTitle: string;
  blogDescription?: string;
  postTitle?: string;
  postBody?: string;
  metaDescription?: string;
  blogPosts?: ImageContextPost[];
}): string {
  const direction = plainText(input.prompt || "");
  const parts = direction && input.mode === "prompt"
    ? [`AUTHOR DIRECTION — USE THIS AS THE PRIMARY SUBJECT: ${clip(direction, 1200)}`]
    : [];

  if (input.mode === "post") {
    const title = plainText(input.postTitle || "");
    const meta = plainText(input.metaDescription || "");
    const bodyLead = clip(plainText(input.postBody || ""), 1500);
    if (title) parts.push(`POST TITLE — PRIMARY SUBJECT: ${clip(title, 500)}`);
    if (meta) parts.push(`Summary: ${clip(meta, 155)}`);
    if (bodyLead) parts.push(`Opening — supporting context only: ${bodyLead}`);
  } else if (input.mode === "blog") {
    parts.push(`Blog: ${plainText(input.blogTitle)} — ${plainText(input.blogDescription || "")}`);
    const posts = (input.blogPosts || []).map((post) => {
      const title = plainText(post.title);
      const body = clip(plainText(post.body_md), 240);
      return [title, body].filter(Boolean).join(": ");
    }).filter(Boolean).join("\n");
    if (posts) parts.push(`Recent posts and themes:\n${posts}`);
  }

  if (!parts.length) parts.push("Create a compelling editorial image for a blog post.");
  // Prepass: scrub real-world figures before the brief model ever sees the
  // source, so it cannot re-introduce a name the image model will reject.
  return clip(rewriteRealWorldFigures(parts.join("\n\n")), AI_SOURCE_MAX);
}

export function buildFallbackBrief(source: string): string {
  return clip(
    rewriteRealWorldFigures(
      `Create a polished editorial image whose primary subject is the post title or main idea below. Depict that subject concretely and accurately; use supporting details only to enrich it. Avoid generic natural scenery unless it is genuinely relevant. ${plainText(source)}`
    ),
    1500
  );
}

const STYLE_LABELS: Record<ImageStyle, string> = {
  "editorial-photo": "a natural-light editorial photograph, authentic materials, believable textures, and restrained color grading",
  "editorial-illustration": "a sophisticated magazine editorial illustration, confident ink lines, considered shapes, and a limited complementary palette",
  cinematic: "a cinematic film still, motivated lighting, dimensional shadows, atmospheric depth, and a deliberate camera composition",
  "child-crayon": "a joyful childlike drawing made with wax crayons on off-white paper, bold uneven strokes, simple shapes, and expressive color",
  "arcade-action": "1990s top-down arcade action pixel art, chunky low-resolution sprites, dramatic perspective, saturated colors, and crisp pixel edges",
  risograph: "a modern risograph print, visible ink grain, slight color misregistration, two or three spot colors, and bold graphic shapes",
  "paper-collage": "a tactile editorial paper collage, torn paper edges, layered cut shapes, subtle shadows, and a handmade print texture",
  watercolor: "a contemporary watercolor editorial illustration, transparent washes, textured paper, controlled detail, and a strong focal subject",
  minimal: "a minimal graphic composition, one dominant subject, generous negative space, a restrained palette, and precise geometric balance",
  auto: "the visual style best suited to the subject, chosen as an intentional editorial art direction",
};

// --- Real-world figures prepass -------------------------------------------
// FLUX rejects prompts that name (or clearly depict) real people, so any
// real-world figure in a title, author direction, or generated brief is
// rewritten to a generic, fictional person who fills the same role in the
// scene ("Donald Trump at a podium" -> "a senior American politician in a
// dark suit and a long red tie at a podium"). This runs as a prepass on the
// source context, again on the fallback brief, and as the final gate in
// buildImagePrompt, so a name can reach the image model through no path —
// including a brief model that re-infers a name from a scrubbed source.
//
// The known-figure table gives the best visual substitute, but it is only
// the first layer: titled or honorific names not in the table ("President
// Jane Doe", "Dr. Smith") and "portrait of <Name>" constructions fail
// closed to a generic role/person rather than passing an unlisted name
// through. Ordinary scenes, places, and lowercase common words ("a trump
// card") are untouched.
type RealFigure = { names: string[]; descriptor: string; bare?: string[] };

const REAL_WORLD_FIGURES: RealFigure[] = [
  { names: ["First Lady Melania Trump", "Melania Trump"], descriptor: "a political spouse in an elegant coat", bare: [] },
  { names: ["President Donald J. Trump", "President Donald Trump", "Donald J. Trump", "Donald Trump", "President Trump"], descriptor: "a senior American politician in a dark suit", bare: ["Trump"] },
  { names: ["President Joe Biden", "Joe Biden", "President Biden"], descriptor: "an elderly American politician in a navy suit", bare: ["Biden"] },
  { names: ["Jill Biden"], descriptor: "an American educator and political spouse in a tailored dress", bare: [] },
  { names: ["Vice President Kamala Harris", "Kamala Harris", "Vice President Harris"], descriptor: "a senior American politician in a tailored pantsuit", bare: ["Harris"] },
  { names: ["President Barack Obama", "Barack Obama", "President Obama"], descriptor: "a former American president in a dark suit", bare: ["Obama", "Barack"] },
  { names: ["Michelle Obama"], descriptor: "an American author and former first lady in an elegant dress", bare: [] },
  { names: ["Hillary Clinton", "Secretary Clinton"], descriptor: "a senior American politician in a bright pantsuit", bare: ["Hillary"] },
  { names: ["Bill Clinton", "President Clinton"], descriptor: "a former American president in a dark suit", bare: ["Clinton"] },
  { names: ["George W. Bush", "George Bush"], descriptor: "a former American president in a dark suit", bare: [] },
  { names: ["Vice President JD Vance", "Vice President J.D. Vance", "JD Vance", "J.D. Vance", "Vice President Vance"], descriptor: "a senior American politician in a dark suit", bare: ["Vance"] },
  { names: ["Mike Pence"], descriptor: "a senior American politician in a dark suit", bare: ["Pence"] },
  { names: ["Nancy Pelosi"], descriptor: "a senior American lawmaker in a tailored suit", bare: ["Pelosi"] },
  { names: ["Ron DeSantis"], descriptor: "an American state governor in a dark suit", bare: ["DeSantis"] },
  { names: ["Gavin Newsom"], descriptor: "an American state governor in a dark suit", bare: ["Newsom"] },
  { names: ["Tim Walz"], descriptor: "an American state governor in a casual jacket", bare: [] },
  { names: ["Pete Buttigieg"], descriptor: "an American cabinet official in a dark suit", bare: [] },
  { names: ["President Vladimir Putin", "Vladimir Putin", "President Putin"], descriptor: "a Russian head of state in a dark suit", bare: ["Putin"] },
  { names: ["President Volodymyr Zelenskyy", "President Volodymyr Zelensky", "Volodymyr Zelenskyy", "Volodymyr Zelensky", "President Zelenskyy", "President Zelensky"], descriptor: "a Ukrainian head of state in a plain sweater", bare: ["Zelenskyy", "Zelensky"] },
  { names: ["Xi Jinping", "President Xi"], descriptor: "a Chinese head of state in a dark suit and red tie", bare: ["Jinping"] },
  { names: ["Kim Jong Un", "Kim Jong-un"], descriptor: "a North Korean head of state in a dark formal suit", bare: [] },
  { names: ["President Emmanuel Macron", "Emmanuel Macron", "President Macron"], descriptor: "a French head of state in a navy suit", bare: ["Macron"] },
  { names: ["Keir Starmer"], descriptor: "a British prime minister in a dark suit", bare: ["Starmer"] },
  { names: ["Rishi Sunak"], descriptor: "a British politician in a dark suit", bare: ["Sunak"] },
  { names: ["Narendra Modi", "Prime Minister Modi"], descriptor: "an Indian prime minister in a traditional vest and kurta", bare: ["Modi"] },
  { names: ["Justin Trudeau"], descriptor: "a Canadian prime minister in a dark suit", bare: ["Trudeau"] },
  { names: ["Mark Carney"], descriptor: "a Canadian prime minister in a dark suit", bare: [] },
  { names: ["Benjamin Netanyahu", "Prime Minister Netanyahu"], descriptor: "an Israeli prime minister in a dark suit", bare: ["Netanyahu"] },
  { names: ["Olaf Scholz"], descriptor: "a German chancellor in a dark suit", bare: ["Scholz"] },
  { names: ["Giorgia Meloni"], descriptor: "an Italian prime minister in a tailored suit", bare: ["Meloni"] },
  { names: ["Recep Tayyip Erdogan", "Recep Tayyip Erdoğan", "President Erdogan", "President Erdoğan"], descriptor: "a Turkish head of state in a dark suit", bare: ["Erdogan", "Erdoğan"] },
  { names: ["Mohammed bin Salman"], descriptor: "a Saudi royal in traditional white robes", bare: [] },
  { names: ["Pope Francis", "Pope Leo XIV", "Pope Leo"], descriptor: "a pope in white vestments", bare: [] },
  { names: ["King Charles III", "King Charles"], descriptor: "a British monarch in formal attire", bare: [] },
  { names: ["Queen Elizabeth II", "Queen Elizabeth"], descriptor: "a British monarch in a bright coat and hat", bare: [] },
  { names: ["Prince William"], descriptor: "a British royal in formal attire", bare: [] },
  { names: ["Prince Harry"], descriptor: "a British royal in a dark suit", bare: [] },
  { names: ["Meghan Markle", "Meghan, Duchess of Sussex"], descriptor: "a duchess in an elegant dress", bare: [] },
  { names: ["Elon Musk"], descriptor: "a technology executive in a dark blazer and t-shirt", bare: ["Musk", "Elon"] },
  { names: ["Jeff Bezos"], descriptor: "a technology executive in a casual shirt", bare: ["Bezos"] },
  { names: ["Mark Zuckerberg"], descriptor: "a technology executive in a casual t-shirt", bare: ["Zuckerberg"] },
  { names: ["Bill Gates"], descriptor: "a technology philanthropist in a sweater and glasses", bare: [] },
  { names: ["Tim Cook"], descriptor: "a technology executive in a dark shirt", bare: [] },
  { names: ["Warren Buffett"], descriptor: "an elderly investor in a suit and glasses", bare: ["Buffett"] },
  { names: ["Sam Altman"], descriptor: "a technology executive in a casual blazer", bare: ["Altman"] },
  { names: ["Sundar Pichai"], descriptor: "a technology executive in a dark blazer", bare: [] },
  { names: ["Satya Nadella"], descriptor: "a technology executive in a dark sweater", bare: [] },
  { names: ["Jensen Huang"], descriptor: "a technology executive in a black jacket", bare: [] },
  { names: ["Taylor Swift"], descriptor: "a pop singer performing on stage with a guitar", bare: [] },
  { names: ["Beyoncé", "Beyonce"], descriptor: "a pop singer performing on stage", bare: [] },
  { names: ["Kim Kardashian"], descriptor: "a reality-television personality in a glamorous gown", bare: ["Kardashian"] },
  { names: ["Kanye West"], descriptor: "a hip-hop artist in dark casual clothing", bare: [] },
  { names: ["Oprah Winfrey"], descriptor: "a television host in an elegant dress", bare: ["Oprah"] },
  { names: ["Tom Cruise"], descriptor: "a film actor in a dark jacket", bare: [] },
  { names: ["Brad Pitt"], descriptor: "a film actor in a casual suit", bare: [] },
  { names: ["Angelina Jolie"], descriptor: "a film actor in an elegant gown", bare: [] },
  { names: ["Cristiano Ronaldo"], descriptor: "a professional footballer in a team kit", bare: ["Ronaldo"] },
  { names: ["Lionel Messi"], descriptor: "a professional footballer in a team kit", bare: ["Messi"] },
  { names: ["LeBron James"], descriptor: "a professional basketball player in a team jersey", bare: [] },
  { names: ["Donald Trump Jr.", "Donald Trump Jr"], descriptor: "a political commentator in a dark suit", bare: [] },
  { names: ["Boris Johnson"], descriptor: "a British politician in a dark suit", bare: [] },
  { names: ["Steve Jobs"], descriptor: "a technology executive in a black turtleneck", bare: [] },
  { names: ["Winston Churchill"], descriptor: "a 20th-century British prime minister in a dark suit and bow tie", bare: ["Churchill"] },
  { names: ["Adolf Hitler"], descriptor: "a 20th-century European political leader in a dark suit", bare: ["Hitler"] },
  { names: ["Travis Kelce"], descriptor: "a professional American football player in a team jersey", bare: [] },
  { names: ["Melinda Gates", "Melinda French Gates"], descriptor: "a philanthropist in a tailored dress", bare: [] },
  { names: ["Queen Latifah"], descriptor: "a hip-hop artist and film actor in stylish clothing", bare: [] },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type FigureRule = { pattern: string; descriptor: string; caseInsensitive: boolean };

const FIGURE_RULES: FigureRule[] = REAL_WORLD_FIGURES
  .flatMap((figure): FigureRule[] => [
    ...figure.names.map((name) => ({ pattern: name, descriptor: figure.descriptor, caseInsensitive: true })),
    // Bare surnames match only as written (capitalized), so ordinary words
    // like "musk" (scent) or "a trump card" survive.
    ...(figure.bare || []).flatMap((name) => [
      { pattern: name, descriptor: figure.descriptor, caseInsensitive: false },
      // Headlines are often ALL-CAPS, where a bare surname is still the figure.
      { pattern: name.toUpperCase(), descriptor: figure.descriptor, caseInsensitive: false },
    ]),
  ])
  .sort((a, b) => b.pattern.length - a.pattern.length);

const ROLE_TITLES =
  "vice president|prime minister|secretary of state|foreign minister|first lady|first gentleman|president|chancellor|senator|congressman|congresswoman|representative|governor|mayor|king|queen|prince|princess|pope|ambassador|justice|judge";
const NON_PERSON_PHRASES = new Set([
  "white house", "new york", "united states", "supreme court", "wall street",
  "silicon valley", "capitol hill", "buckingham palace", "downing street",
]);

export function rewriteRealWorldFigures(value: string): string {
  let out = value;
  for (const rule of FIGURE_RULES) {
    const re = new RegExp(
      `\\b(?:a\\s+|an\\s+|the\\s+)?(${escapeRegExp(rule.pattern)})(?:\\s+(?:Jr\\.|Sr\\.|Jr|Sr|III|II|IV))?(['’]s)?`,
      rule.caseInsensitive ? "gi" : "g"
    );
    out = out.replace(re, (_m, _name, possessive) => rule.descriptor + (possessive ? "'s" : ""));
  }
  // Unlisted titled figures: keep the role, drop the name. Titles match in
  // either case; the name after them must be capitalized (case-sensitive),
  // so ordinary prose like "the president speaking" is untouched.
  const titleAlternation = ROLE_TITLES.split("|")
    .flatMap((title) => [title, title.replace(/\b\w/g, (c) => c.toUpperCase())])
    .join("|");
  out = out.replace(
    new RegExp(`\\b(?:the\\s+)?(${titleAlternation})\\s+(?:[A-Z][\\w'’-]*\\s+){0,2}[A-Z][\\w'’-]*`, "g"),
    (match, role: string) =>
      match.toLowerCase().replace(/^the\s+/, "") === "king kong" ? match : `a ${role.toLowerCase()}`
  );
  // Name-first appositives ("Anthony Albanese, the prime minister, …") for
  // unlisted figures: the name goes, the following title stays.
  out = out.replace(
    new RegExp(`\\b[A-Z][\\w'’-]+ [A-Z][\\w'’-]+(?=,\\s+(?:the\\s+)?(?:${titleAlternation})\\b)`, "g"),
    (match) => (NON_PERSON_PHRASES.has(match.toLowerCase()) ? match : "a person")
  );
  // A known figure already replaced leaves a dangling honorific ("Mr. Musk"
  // -> "Mr. a technology executive…"); drop it.
  out = out.replace(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+(?=a\s|an\s)/g, "");
  // Honorific + name ("Dr. Smith", "Mr. Jones") likewise fails closed.
  out = out.replace(/\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Sir|Dame)\s+[A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+)?/g, "a person");
  // "portrait of <Name>" for names no rule above claimed.
  out = out.replace(
    /\b(portrait|photograph|photo|picture|image|headshot|likeness|caricature) of (?:a\s+|an\s+|the\s+)?([A-Z][\w'’-]+ [A-Z][\w'’-]+)/g,
    (match, kind: string, name: string) =>
      NON_PERSON_PHRASES.has(name.toLowerCase()) ? match : `${kind} of a generic person`
  );
  return out;
}

// Physical objects that can carry writing, versus abstract copy nouns. The
// abstract ones only count as a text request with an explicit quoted string,
// so prose like "a quiet message of hope" or "the text reads smoothly"
// passes through untouched.
const TEXT_OBJECT_NOUNS = "sign|poster|banner|placard|billboard|marquee|screen|book|newspaper|magazine|label|packaging|package|shirt|t-shirt|mug|cup|board|tattoo|sticker|stamp|graffiti";
const TEXT_ABSTRACT_NOUNS = "headline|caption|title|words?|lettering|text|message|quote|slogan";
const TEXT_REQUEST_VERBS = "reading|saying|says?|reads?|that says?";

// Rewrite any request for visible copy ("signs reading X", "with the words
// "Y"", "headline: Z") into a blank-surface equivalent, so requested wording
// can never reach the image model — not even via fallback briefs that embed
// raw post titles or manual author directions.
export function sanitizeTextRequests(value: string): string {
  let out = ` ${value} `;
  const physical = new RegExp(`\\b((?:${TEXT_OBJECT_NOUNS})s?)\\b\\s+(?:${TEXT_REQUEST_VERBS})\\s+("[^"]+"|'[^']+'|\\S+)`, "gi");
  out = out.replace(physical, (_m, noun) => ` ${noun} rendered completely blank `);
  const quoted = new RegExp(
    `\\b((?:${TEXT_OBJECT_NOUNS}|${TEXT_ABSTRACT_NOUNS})s?)\\b\\s+(?:displaying|showing|with)\\s+("[^"]+"|'[^']+')` +
      `|\\b((?:${TEXT_ABSTRACT_NOUNS})s?)\\b\\s+(?:${TEXT_REQUEST_VERBS})\\s+("[^"]+"|'[^']+')` +
      `|\\b((?:${TEXT_OBJECT_NOUNS}|${TEXT_ABSTRACT_NOUNS})s?)\\b\\s*:\\s*("[^"]+"|'[^']+')` +
      `|\\b((?:${TEXT_ABSTRACT_NOUNS})s?)\\b\\s+("[^"]+"|'[^']+')` +
      `|\\bwith the (?:words?|text|message|caption|title)\\b\\s*("[^"]+"|'[^']+')`,
    "gi"
  );
  out = out.replace(quoted, " $1$3$5$7 rendered blank with no text ");
  return out.replace(/\s+/g, " ").trim();
}

export function buildImagePrompt(brief: string, style: ImageStyle): string {
  // Final gate: rewrite any real-world figure the brief still names (the
  // brief model can re-infer one from a scrubbed source) to a generic person.
  const safeBrief = rewriteRealWorldFigures(sanitizeTextRequests(plainText(brief)));
  return clip([
    "TEXT BAN — ABSOLUTE: no text of any kind anywhere in the image. No words, letters, numbers, glyphs, captions, labels, signs, or watermark-like marks. Anything that would normally carry writing (signs, screens, books, packaging, clothing prints, labels, boards) must be rendered completely blank.",
    "REAL-PEOPLE RULE: depict only generic, fictional people. No real person, public figure, celebrity, politician, or recognizable likeness of any kind.",
    "Image rules: treat every word in the brief as a visual idea, never as visible copy. Create an image-only composition with no text-bearing objects.",
    `Subject and action: ${safeBrief}`,
    `Style: ${STYLE_LABELS[style]}`,
    "Composition: a 16:9 horizontal editorial thumbnail with one clearly identifiable focal subject, a legible silhouette at small size, and intentional visual hierarchy.",
    "Context: subject-specific setting and atmosphere. Prefer a physical scene, object, person, or visual metaphor; do not depict a browser window, website, article page, screen, document, book, sign, poster, chart, interface, logo, watermark, lettering, or readable words.",
    "Final check before rendering: the image must contain zero readable or pseudo-readable marks.",
  ].join("\n"), AI_IMAGE_PROMPT_MAX);
}
