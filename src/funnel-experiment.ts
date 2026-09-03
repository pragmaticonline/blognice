export type FunnelExperimentVariant = "control" | "focused";

export type RunningFunnelExperiment = {
  experimentKey: string;
  treatmentAllocationBasisPoints: number;
};

export async function loadRunningAffiliateOfferExperimentInDb(
  db: D1Database,
  configuredKey: string | undefined,
): Promise<RunningFunnelExperiment | null> {
  const experimentKey = String(configuredKey || "").trim();
  if (!experimentKey || experimentKey === "off" || !/^[a-z0-9_-]{3,80}$/i.test(experimentKey)) return null;
  const row = await db.prepare(
    `SELECT experiment_key, treatment_allocation_basis_points
       FROM funnel_experiments
      WHERE experiment_key = ? AND route = 'affiliate_offer' AND status = 'running'`,
  ).bind(experimentKey).first<{ experiment_key: string; treatment_allocation_basis_points: number }>();
  if (!row) return null;
  return {
    experimentKey: row.experiment_key,
    treatmentAllocationBasisPoints: Number(row.treatment_allocation_basis_points),
  };
}

export type FunnelExperimentAssignment = {
  journeyId: string;
  experimentKey: string;
  variant: FunnelExperimentVariant;
  affiliateId: number;
  policyVersion: string;
  assignedAt: number;
  exposedAt: number;
};

type AssignmentRow = {
  journey_id: string;
  experiment_key: string;
  variant: FunnelExperimentVariant;
  affiliate_id: number;
  policy_version: string;
  assigned_at: number;
  exposed_at: number;
};

function assignmentFromRow(row: AssignmentRow): FunnelExperimentAssignment {
  return {
    journeyId: row.journey_id,
    experimentKey: row.experiment_key,
    variant: row.variant,
    affiliateId: Number(row.affiliate_id),
    policyVersion: row.policy_version,
    assignedAt: Number(row.assigned_at),
    exposedAt: Number(row.exposed_at),
  };
}

export async function assignAndExposeFunnelExperimentInDb(
  db: D1Database,
  input: FunnelExperimentAssignment,
): Promise<{ assignment: FunnelExperimentAssignment; created: boolean }> {
  if (!/^[a-z0-9_-]{20,96}$/i.test(input.journeyId)) throw new Error("invalid experiment journey ID");
  if (!/^[a-z0-9_-]{3,80}$/i.test(input.experimentKey)) throw new Error("invalid experiment key");
  if (!Number.isSafeInteger(input.affiliateId) || input.affiliateId <= 0) throw new Error("invalid Affiliate ID");
  if (!Number.isSafeInteger(input.assignedAt) || !Number.isSafeInteger(input.exposedAt) || input.exposedAt < input.assignedAt) {
    throw new Error("invalid experiment timestamps");
  }

  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO funnel_experiment_assignments
         (journey_id, experiment_key, variant, affiliate_id, policy_version, assigned_at, exposed_at)
       SELECT ?, experiment.experiment_key, ?, profile.account_id, ?, ?, ?
         FROM funnel_experiments AS experiment
         JOIN affiliate_profiles AS profile ON profile.account_id = ?
        WHERE experiment.experiment_key = ?
          AND experiment.status = 'running'
          AND profile.status = 'active'
          AND ? IN (experiment.control_variant, experiment.treatment_variant)`,
    ).bind(
      input.journeyId,
      input.variant,
      input.policyVersion.slice(0, 80),
      input.assignedAt,
      input.exposedAt,
      input.affiliateId,
      input.experimentKey,
      input.variant,
    ),
    db.prepare(
      `UPDATE funnel_experiment_assignments
          SET exposed_at = CASE WHEN exposed_at IS NULL OR ? < exposed_at THEN ? ELSE exposed_at END
        WHERE journey_id = ?`,
    ).bind(input.exposedAt, input.exposedAt, input.journeyId),
  ]);

  const row = await db.prepare(
    `SELECT journey_id, experiment_key, variant, affiliate_id, policy_version, assigned_at, exposed_at
       FROM funnel_experiment_assignments WHERE journey_id = ?`,
  ).bind(input.journeyId).first<AssignmentRow>();
  if (!row) throw new Error("experiment assignment is unavailable");
  return { assignment: assignmentFromRow(row), created: results[0].meta.changes === 1 };
}

export async function recordFunnelExperimentCtaInDb(db: D1Database, journeyId: string, clickedAt: number): Promise<void> {
  await db.prepare(
    `UPDATE funnel_experiment_assignments
        SET cta_clicked_at = CASE WHEN cta_clicked_at IS NULL OR ? < cta_clicked_at THEN ? ELSE cta_clicked_at END
      WHERE journey_id = ? AND exposed_at IS NOT NULL AND excluded_at IS NULL`,
  ).bind(clickedAt, clickedAt, journeyId).run();
}

export async function associateFunnelExperimentSignupInDb(
  db: D1Database,
  journeyId: string,
  accountId: number,
  signupAt: number,
): Promise<{ associated: boolean }> {
  await db.prepare(
    `UPDATE funnel_experiment_assignments
        SET account_id = ?, signup_at = COALESCE(signup_at, ?)
      WHERE journey_id = ? AND account_id IS NULL AND excluded_at IS NULL
        AND EXISTS (
          SELECT 1 FROM affiliate_attributions AS attribution
           WHERE attribution.referred_account_id = ?
             AND attribution.affiliate_id = funnel_experiment_assignments.affiliate_id
             AND attribution.policy_version = funnel_experiment_assignments.policy_version
        )`,
  ).bind(accountId, signupAt, journeyId, accountId).run();
  const row = await db.prepare(
    "SELECT account_id FROM funnel_experiment_assignments WHERE journey_id = ?",
  ).bind(journeyId).first<{ account_id: number | null }>();
  return { associated: Number(row?.account_id) === accountId };
}

export async function recordFunnelExperimentCheckoutInDb(db: D1Database, accountId: number, startedAt: number): Promise<void> {
  await db.prepare(
    `UPDATE funnel_experiment_assignments
        SET checkout_started_at = CASE
          WHEN checkout_started_at IS NULL OR ? < checkout_started_at THEN ? ELSE checkout_started_at END
      WHERE account_id = ? AND signup_at IS NOT NULL AND excluded_at IS NULL`,
  ).bind(startedAt, startedAt, accountId).run();
}

export function renderAffiliateOfferPage(
  homepage: string,
  rootDomain: string,
  variant: FunnelExperimentVariant,
): string {
  const canonical = `https://www.${rootDomain}/affiliate-offer`;
  const control = homepage
    .replace("<title>blognice — A nicer way to blog</title>", "<title>10% off Blognice for 12 months</title>")
    .replace(
      '<meta name="description" content="Create beautiful, fast blogs without hosting, plugins, updates, or technical maintenance.">',
      '<meta name="description" content="Start a beautiful Blognice blog and save 10% on your first 12 paid months.">\n<meta name="robots" content="noindex,follow">',
    )
    .replace('<link rel="canonical" href="https://www.blognice.com/">', `<link rel="canonical" href="${canonical}">`)
    .replace('<meta property="og:title" content="blognice — A nicer way to blog">', '<meta property="og:title" content="Save 10% on Blognice for 12 months">')
    .replace('<meta property="og:description" content="Create beautiful, fast blogs without hosting, plugins, updates, or technical maintenance.">', '<meta property="og:description" content="Start writing on Blognice and receive 10% off your first 12 paid months.">')
    .replace('<meta property="og:url" content="https://www.blognice.com/">', `<meta property="og:url" content="${canonical}">`)
    .replace('<meta name="twitter:title" content="blognice — A nicer way to blog">', '<meta name="twitter:title" content="Save 10% on Blognice for 12 months">')
    .replace('<meta name="twitter:description" content="Create beautiful, fast blogs without hosting, plugins, updates, or technical maintenance.">', '<meta name="twitter:description" content="Start writing on Blognice and receive 10% off your first 12 paid months.">')
    .replaceAll("https://www.blognice.com/signup", "/signup")
    .replaceAll("https://www.blognice.com/admin/login", "/admin/login")
    .replace("<h1>A nicer way to blog.</h1>", "<h1>Save 10% for your first 12 paid months.</h1>")
    .replace(
      '<p class="hero-sub">Create beautiful, fast blogs without hosting, plugins, updates, or technical maintenance. Just choose an address and start writing.</p>',
      '<p class="hero-sub">Your referral offer is ready. Create a beautiful, fast blog now; when you upgrade, your discount is applied automatically to the first 12 paid service months.</p>',
    )
    .replace('<a href="#pricing" class="btn btn-green">See pricing</a>', '<a href="/signup" class="btn btn-green">Claim 10% off</a>')
    .replace('<p class="hero-trial-note">Your first blog is free to try.</p>', '<p class="hero-trial-note">Free to start · no payment details required · referral offer saved for 60 days</p>');
  if (variant === "control") return control;
  return control
    .replace("<h1>Save 10% for your first 12 paid months.</h1>", "<h1>Save 10% and lock in $36/year.</h1>")
    .replace(
      '<p class="hero-sub">Your referral offer is ready. Create a beautiful, fast blog now; when you upgrade, your discount is applied automatically to the first 12 paid service months.</p>',
      '<p class="hero-sub">Get 10% off your first 12 paid months and secure founding member pricing before the planned first 1,000-member limit is reached.</p>',
    )
    .replace(
      '<div class="nav-links">\n      <a href="#writing">Writing</a>\n      <a href="#features">Features</a>\n      <a href="#compare">Compare</a>\n      <a href="#pricing">Pricing</a>\n      <a href="#faq">FAQ</a>\n    </div>',
      '<div class="nav-links"><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></div>',
    )
    .replace(
      '<a href="/signup" class="btn btn-green">Claim 10% off</a>\n        <a href="#examples" class="link-underline">See an example blog</a>',
      '<a href="/experiment/affiliate-offer/cta" class="btn btn-green">Claim 10% and lock in $36/year</a>',
    )
    .replace(/<section class="manifesto">[\s\S]*?<section id="pricing">/, '<section id="pricing">');
}
