// Landing page content model and view builder.
//
// parseLandingContent(): untrusted JSON (owner form / API) -> safe LandingContent.
// buildLandingView():    LandingContent + site context -> the flat view object every
//                        design template renders. All derived values (numbering,
//                        primary CTA, "has_*" flags, URLs, Markdown HTML) are made
//                        here, once, so templates stay logic-less.

import { renderMarkdown } from "./markdown";
import type { TemplateView } from "./landing-template";

export type LandingContent = {
  hero: { headline: string; subheadline: string; image_key: string | null };
  ctas: Array<{ label: string; href: string }>;
  intro_md: string;
  features: Array<{ title: string; body_md: string; image_key: string | null }>;
  contact: { email: string; phone: string; address: string; hours: string; map_url: string };
  show_latest_posts: boolean;
};

export const LANDING_LIMITS = {
  headline: 120, subheadline: 300, ctas: 2, ctaLabel: 40, intro: 4000,
  features: 6, featureTitle: 80, featureBody: 600, contactField: 300,
  email: 254, phone: 40, href: 500,
} as const;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// https:, http:, mailto:, tel:, or a same-site path ("/x", never "//x"). Else "".
export function safeLandingHref(value: unknown): string {
  const v = str(value, LANDING_LIMITS.href);
  if (!v) return "";
  if (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")) return v;
  try {
    const u = new URL(v);
    return ["https:", "http:", "mailto:", "tel:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

// Media keys only; ownership by the tenant is checked by the caller on save.
function mediaKey(value: unknown): string | null {
  const v = str(value, 200);
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v) && !v.includes("..") ? v : null;
}

export function parseLandingContent(raw: unknown): LandingContent {
  let input: any = raw;
  if (typeof raw === "string") {
    try { input = JSON.parse(raw); } catch { input = {}; }
  }
  if (!input || typeof input !== "object") input = {};
  const hero = input.hero && typeof input.hero === "object" ? input.hero : {};
  const contact = input.contact && typeof input.contact === "object" ? input.contact : {};
  return {
    hero: {
      headline: str(hero.headline, LANDING_LIMITS.headline),
      subheadline: str(hero.subheadline, LANDING_LIMITS.subheadline),
      image_key: mediaKey(hero.image_key),
    },
    ctas: (Array.isArray(input.ctas) ? input.ctas : [])
      .map((c: any) => ({ label: str(c?.label, LANDING_LIMITS.ctaLabel), href: safeLandingHref(c?.href) }))
      .filter((c: { label: string; href: string }) => c.label && c.href)
      .slice(0, LANDING_LIMITS.ctas),
    intro_md: str(input.intro_md, LANDING_LIMITS.intro),
    features: (Array.isArray(input.features) ? input.features : [])
      .map((f: any) => ({
        title: str(f?.title, LANDING_LIMITS.featureTitle),
        body_md: str(f?.body_md, LANDING_LIMITS.featureBody),
        image_key: mediaKey(f?.image_key),
      }))
      .filter((f: { title: string; body_md: string }) => f.title || f.body_md)
      .slice(0, LANDING_LIMITS.features),
    contact: {
      email: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(str(contact.email, LANDING_LIMITS.email)) ? str(contact.email, LANDING_LIMITS.email) : "",
      phone: str(contact.phone, LANDING_LIMITS.phone).replace(/[^\d+()\-\s.]/g, ""),
      address: str(contact.address, LANDING_LIMITS.contactField),
      hours: str(contact.hours, LANDING_LIMITS.contactField),
      map_url: safeLandingHref(contact.map_url),
    },
    show_latest_posts: input.show_latest_posts === true,
  };
}

export type LandingSite = {
  design_id: string;
  title: string;
  footer_name: string;
  blog_url: string;                                  // "/blog" when this page is the homepage, else "/"
  avatar_url: string | null;
  nav: Array<{ label: string; href: string; new_tab?: boolean }>;
  social: Array<{ label: string; url: string }>;
  posts: Array<{ title: string; url: string; date: string }>; // latest published, already formatted
  head_html: string;                                 // meta + theme script + accent + customCssTag(), built by the caller
  body_end_html: string;                             // consent banner + metrics scripts, built by the caller ("" if none)
  media_url: (key: string) => string;                // e.g. key => `/media/${key}`
  year?: number;
};

const NAV_INLINE = 1; // phones: brand + 1 link + Menu

export function buildLandingView(content: LandingContent, site: LandingSite): TemplateView {
  const md = (s: string) => (s ? renderMarkdown(s) : "");
  const img = (key: string | null) => (key ? site.media_url(key) : null);
  const ctas = content.ctas.map((c, i) => ({ ...c, primary: i === 0, secondary: i > 0 }));
  const features = content.features.map((f, i) => ({
    title: f.title,
    body_html: md(f.body_md),
    image_url: img(f.image_key),
    number: String(i + 1).padStart(2, "0"),
  }));
  const c = content.contact;
  const contact = {
    ...c,
    phone_href: c.phone ? "tel:" + c.phone.replace(/[^\d+]/g, "") : "",
    email_href: c.email ? "mailto:" + c.email : "",
    has_any: !!(c.email || c.phone || c.address || c.hours || c.map_url),
    has_quick: !!(c.hours || c.phone),
  };
  const nav = site.nav.map((n) => ({ label: n.label, href: n.href, new_tab: !!n.new_tab }));
  const posts = content.show_latest_posts ? site.posts.slice(0, 3) : [];
  return {
    head_html: site.head_html,
    body_end_html: site.body_end_html,
    body_attrs_html: `data-landing-page data-landing-design="${site.design_id.replace(/[^a-z0-9-]/g, "")}"`,
    site: {
      title: site.title,
      footer_name: site.footer_name || site.title,
      avatar_url: site.avatar_url,
      year: site.year ?? new Date().getUTCFullYear(),
    },
    blog_url: site.blog_url,
    hero: { headline: content.hero.headline, subheadline: content.hero.subheadline, image_url: img(content.hero.image_key) ?? null },
    hero_image_url: img(content.hero.image_key) ?? site.avatar_url,
    ctas,
    cta_primary: ctas[0] ?? null,
    intro_html: md(content.intro_md),
    features,
    contact,
    posts,
    // Desktop shows nav_all; phones show the first NAV_INLINE inline and the rest
    // (nav_more) in a <details class="lp-menu"> so no page becomes unreachable.
    nav_all: nav,
    nav: nav.slice(0, NAV_INLINE),
    nav_more: nav.slice(NAV_INLINE),
    social: site.social,
    // Section wrappers: {{#has_features}}<section>…{{#features}}…{{/features}}</section>{{/has_features}}
    has_hero_text: !!(content.hero.headline || content.hero.subheadline),
    has_ctas: ctas.length > 0,
    has_features: features.length > 0,
    has_posts: posts.length > 0,
    has_social: site.social.length > 0,
    has_nav_more: nav.length > NAV_INLINE,
  };
}
