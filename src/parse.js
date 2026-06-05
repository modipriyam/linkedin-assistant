// parse.js — pure helpers for resolving a company from URLs and LinkedIn hrefs,
// and for building LinkedIn people-search deep-links. No DOM, no network: unit-testable.

const STOP_HOST_LABELS = new Set(["www", "jobs", "job", "boards", "careers", "career", "apply", "talent", "join", "work"]);

/** Turn a slug like "hellmann-worldwide-logistics" into "Hellmann Worldwide Logistics". */
export function slugToName(slug) {
  if (!slug) return "";
  return String(slug)
    .replace(/[._]+/g, "-")
    .split("-")
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
    .trim();
}

/** From a LinkedIn job slug, pull the company that follows "-at-" and drops the trailing job id.
 *  e.g. "strategic-sales-director-technology-at-hellmann-worldwide-logistics-4419631666"
 *       -> "hellmann-worldwide-logistics" */
export function parseCompanyFromLinkedInJobSlug(slug) {
  if (!slug) return null;
  let s = String(slug).trim().replace(/\/+$/, "");
  // strip a trailing numeric job id segment
  s = s.replace(/-\d{4,}$/, "");
  const at = s.lastIndexOf("-at-");
  if (at === -1) return null;
  const company = s.slice(at + 4).trim();
  return company || null;
}

/** Extract the company id/slug from a LinkedIn /company/{id}/ href (absolute or relative). */
export function extractCompanyIdFromHref(href) {
  if (!href) return null;
  const m = String(href).match(/\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Best-effort: derive a company slug/name from a job-posting or careers URL.
 *  Returns { slug, name, source } or null. */
export function parseCompanyFromUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    if (/^https?:\/\//i.test(rawUrl)) url = new URL(rawUrl);
    else if (String(rawUrl).startsWith("/")) url = new URL(rawUrl, "https://www.linkedin.com");
    else return null;
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segs = url.pathname.split("/").filter(Boolean);
  const seg0 = segs[0] ? decodeURIComponent(segs[0]) : null;

  // LinkedIn company entity link
  if (host.endsWith("linkedin.com")) {
    if (segs[0] === "company" && segs[1]) {
      const slug = decodeURIComponent(segs[1]);
      return { slug, name: slugToName(slug), source: "linkedin-company" };
    }
    // /jobs/view/{slug-with-at-company-id}
    if (segs[0] === "jobs" && segs[1] === "view" && segs[2]) {
      const slug = parseCompanyFromLinkedInJobSlug(decodeURIComponent(segs[2]));
      if (slug) return { slug, name: slugToName(slug), source: "linkedin-job-slug" };
    }
    return null;
  }

  // Greenhouse: boards.greenhouse.io/{co}, job-boards.greenhouse.io/{co}
  if (host.endsWith("greenhouse.io") && seg0) {
    return { slug: seg0, name: slugToName(seg0), source: "greenhouse" };
  }
  // Lever: jobs.lever.co/{co}
  if (host.endsWith("lever.co") && seg0) {
    return { slug: seg0, name: slugToName(seg0), source: "lever" };
  }
  // Ashby: jobs.ashbyhq.com/{co}
  if (host.endsWith("ashbyhq.com") && seg0) {
    return { slug: seg0, name: slugToName(seg0), source: "ashby" };
  }
  // SmartRecruiters: jobs.smartrecruiters.com/{co}/...
  if (host.endsWith("smartrecruiters.com") && seg0) {
    return { slug: seg0, name: slugToName(seg0), source: "smartrecruiters" };
  }
  // Workday: {co}.{dc}.myworkdayjobs.com
  if (host.endsWith("myworkdayjobs.com")) {
    const label = host.split(".")[0];
    if (label) return { slug: label, name: slugToName(label), source: "workday" };
  }

  // Generic careers host: derive the registrable-ish label.
  // careers.airbnb.com -> airbnb ; jobs.netflix.com -> netflix ; acme.com -> acme
  const labels = host.split(".").filter(Boolean);
  if (labels.length >= 2) {
    // drop TLD; also drop a leading generic label like "careers"/"jobs"
    let core = labels.slice(0, -1);
    if (core.length > 1 && STOP_HOST_LABELS.has(core[0])) core = core.slice(1);
    const label = core[core.length - 1];
    if (label && !STOP_HOST_LABELS.has(label)) {
      return { slug: label, name: slugToName(label), source: "domain" };
    }
  }
  return null;
}

/** Build a LinkedIn people-search deep link.
 *  opts: { companyId, network: "F"|"S"|null, keywords } */
export function buildPeopleSearchUrl({ companyId, network, keywords } = {}) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (companyId) params.set("currentCompany", `["${companyId}"]`);
  if (network) params.set("network", `["${network}"]`);
  params.set("origin", "FACETED_SEARCH");
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

/** Build a company-search deep link (used to resolve a name -> company id when we only have a name). */
export function buildCompanySearchUrl(name) {
  const params = new URLSearchParams();
  params.set("keywords", name || "");
  return `https://www.linkedin.com/search/results/companies/?${params.toString()}`;
}

/** Pick the best company candidate from a set of signals. Signals is an array of
 *  { slug, name, source } in priority order; returns the first non-empty. */
export function pickCompany(signals = []) {
  for (const s of signals) {
    if (s && (s.slug || s.name)) return s;
  }
  return null;
}
