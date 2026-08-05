export const AI_BRIEF_MODEL = "@cf/ibm-granite/granite-4.0-h-micro" as const;
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
  blogPosts?: ImageContextPost[];
}): string {
  const direction = plainText(input.prompt || "");
  const parts = direction && input.mode === "prompt"
    ? [`AUTHOR DIRECTION — USE THIS AS THE PRIMARY SUBJECT: ${clip(direction, 1200)}`]
    : [];

  if (input.mode === "post") {
    const title = plainText(input.postTitle || "");
    const body = plainText(input.postBody || "");
    if (title) parts.push(`POST TITLE — PRIMARY SUBJECT: ${clip(title, 500)}`);
    if (body) parts.push(`Post body — supporting context only: ${clip(body, 9000)}`);
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
  return clip(parts.join("\n\n"), AI_SOURCE_MAX);
}

export function buildFallbackBrief(source: string): string {
  return clip(
    `Create a polished editorial image whose primary subject is the post title or main idea below. Depict that subject concretely and accurately; use supporting details only to enrich it. Avoid generic natural scenery unless it is genuinely relevant. ${plainText(source)}`,
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

export function buildImagePrompt(brief: string, style: ImageStyle): string {
  const safeBrief = plainText(brief);
  return clip([
    "Image rules: treat every word in the brief as a visual idea, never as visible copy. Create an image-only composition with no text-bearing objects.",
    `Subject and action: ${safeBrief}`,
    `Style: ${STYLE_LABELS[style]}`,
    "Composition: a 16:9 horizontal editorial thumbnail with one clearly identifiable focal subject, a legible silhouette at small size, and intentional visual hierarchy.",
    "Context: subject-specific setting and atmosphere. Prefer a physical scene, object, person, or visual metaphor; do not depict a browser window, website, article page, screen, document, book, sign, poster, chart, interface, logo, watermark, lettering, or readable words.",
  ].join("\n"), AI_IMAGE_PROMPT_MAX);
}
