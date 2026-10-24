// Registry of landing page designs.
//
// To add a design: create src/landing-designs/<id>/ with design.html,
// design.json and sample.json, then add ONE line to DESIGN_SOURCES below.
// `npm run landing:preview` renders it; `npm test` checks it against every
// platform rule. See docs/landing-designs/README.md.

import type { DesignManifest } from "../landing-template";

import heroHtml from "./hero/design.html";
import heroManifest from "./hero/design.json";
import businessHtml from "./business/design.html";
import businessManifest from "./business/design.json";
import shopHtml from "./shop/design.html";
import shopManifest from "./shop/design.json";
import minimalHtml from "./minimal/design.html";
import minimalManifest from "./minimal/design.json";

export type LandingDesign = DesignManifest & { template: string };

// Order here is the order shown in the design picker. The first is the default.
const DESIGN_SOURCES: Array<[string, DesignManifest]> = [
  [heroHtml, heroManifest as DesignManifest],
  [businessHtml, businessManifest as DesignManifest],
  [shopHtml, shopManifest as DesignManifest],
  [minimalHtml, minimalManifest as DesignManifest],
];

export const LANDING_DESIGNS: ReadonlyArray<LandingDesign> = DESIGN_SOURCES.map(([template, manifest]) => ({
  ...manifest,
  template,
}));

export const DEFAULT_LANDING_DESIGN = LANDING_DESIGNS[0].id;

export function getLandingDesign(id: unknown): LandingDesign {
  return LANDING_DESIGNS.find((d) => d.id === id) ?? LANDING_DESIGNS[0];
}
