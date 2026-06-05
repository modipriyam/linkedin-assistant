import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugToName,
  parseCompanyFromLinkedInJobSlug,
  extractCompanyIdFromHref,
  parseCompanyFromUrl,
  buildPeopleSearchUrl,
  pickCompany,
} from "./parse.js";

test("slugToName title-cases and de-hyphenates", () => {
  assert.equal(slugToName("hellmann-worldwide-logistics"), "Hellmann Worldwide Logistics");
  assert.equal(slugToName("acme_inc"), "Acme Inc");
  assert.equal(slugToName(""), "");
});

test("parseCompanyFromLinkedInJobSlug strips role + trailing id, keeps company", () => {
  assert.equal(
    parseCompanyFromLinkedInJobSlug("strategic-sales-director-technology-at-hellmann-worldwide-logistics-4419631666"),
    "hellmann-worldwide-logistics"
  );
  assert.equal(parseCompanyFromLinkedInJobSlug("software-engineer-at-stripe-1234567890"), "stripe");
  assert.equal(parseCompanyFromLinkedInJobSlug("no-company-here"), null);
});

test("extractCompanyIdFromHref reads /company/{id}", () => {
  assert.equal(extractCompanyIdFromHref("https://www.linkedin.com/company/1009/"), "1009");
  assert.equal(extractCompanyIdFromHref("/company/hellmann-worldwide-logistics/posts/"), "hellmann-worldwide-logistics");
  assert.equal(extractCompanyIdFromHref("https://www.linkedin.com/in/someone/"), null);
});

test("parseCompanyFromUrl handles ATS hosts", () => {
  assert.deepEqual(parseCompanyFromUrl("https://boards.greenhouse.io/stripe/jobs/12345"), {
    slug: "stripe",
    name: "Stripe",
    source: "greenhouse",
  });
  assert.equal(parseCompanyFromUrl("https://jobs.lever.co/figma/abc-def").slug, "figma");
  assert.equal(parseCompanyFromUrl("https://jobs.ashbyhq.com/notion/role").slug, "notion");
  assert.equal(parseCompanyFromUrl("https://acme.wd1.myworkdayjobs.com/External/job/123").slug, "acme");
  assert.equal(parseCompanyFromUrl("https://jobs.smartrecruiters.com/Bosch/74000").slug, "Bosch");
});

test("parseCompanyFromUrl handles careers/domain hosts", () => {
  assert.equal(parseCompanyFromUrl("https://careers.airbnb.com/positions/123").slug, "airbnb");
  assert.equal(parseCompanyFromUrl("https://jobs.netflix.com/jobs/123").slug, "netflix");
  assert.equal(parseCompanyFromUrl("https://acme.com/careers/eng").slug, "acme");
});

test("parseCompanyFromUrl handles LinkedIn company + job links", () => {
  assert.equal(parseCompanyFromUrl("https://www.linkedin.com/company/hellmann/").slug, "hellmann");
  assert.equal(
    parseCompanyFromUrl(
      "https://www.linkedin.com/jobs/view/strategic-sales-director-technology-at-hellmann-worldwide-logistics-4419631666"
    ).slug,
    "hellmann-worldwide-logistics"
  );
});

test("parseCompanyFromUrl returns null on junk", () => {
  assert.equal(parseCompanyFromUrl(""), null);
  assert.equal(parseCompanyFromUrl("not a url"), null);
});

test("buildPeopleSearchUrl encodes company + network filters", () => {
  const u = buildPeopleSearchUrl({ companyId: "1009", network: "F", keywords: "recruiter" });
  assert.match(u, /\/search\/results\/people\//);
  assert.match(decodeURIComponent(u), /currentCompany=\["1009"\]/);
  assert.match(decodeURIComponent(u), /network=\["F"\]/);
  assert.match(decodeURIComponent(u), /keywords=recruiter/);
});

test("pickCompany returns first non-empty signal", () => {
  assert.equal(pickCompany([null, { slug: "" }, { slug: "stripe", name: "Stripe" }]).slug, "stripe");
  assert.equal(pickCompany([]), null);
});
