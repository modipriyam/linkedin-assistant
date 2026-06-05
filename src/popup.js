// popup.js — 3 action tabs (Draft / Resume / Who do I know) + Settings (gear).
// Actions operate on the post in the active LinkedIn tab, with paste fallback.

const $ = (id) => document.getElementById(id);
const ANTHROPIC_DEFAULT = "claude-haiku-4-5-20251001";
const OPENAI_DEFAULT = "gpt-4o-mini";

try {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
} catch {}

// ---------------------------------------------------------------- messaging
const sendBg = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(resp || { ok: false, error: "No response." });
    });
  });

// Disable buttons while an async action runs, then re-enable (even on early return/error).
function setBusy(ids, busy) {
  ids.forEach((id) => {
    const e = $(id);
    if (e) e.disabled = busy;
  });
}
async function withBusy(ids, fn) {
  setBusy(ids, true);
  try {
    return await fn();
  } finally {
    setBusy(ids, false);
  }
}

// Self-contained reader injected into the active LinkedIn tab on demand. Must not
// reference any outer scope — it is serialized and executed in the page.
function pageExtract() {
  const firstText = (root, sels) => {
    for (const s of sels) {
      const n = root.querySelector(s);
      const t = n && (n.innerText || n.textContent || "").trim();
      if (t) return t;
    }
    return "";
  };
  const abs = (h) => {
    try {
      return new URL(h, location.href).href;
    } catch {
      return h;
    }
  };

  // Job page
  const onJob =
    /\/jobs\//.test(location.pathname) ||
    document.querySelector("#job-details, .jobs-description, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title");
  if (onJob) {
    const title = firstText(document, [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", ".t-24", "h1"]);
    const company = firstText(document, [".job-details-jobs-unified-top-card__company-name a", ".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name a", ".jobs-unified-top-card__company-name"]);
    const loc = firstText(document, [".job-details-jobs-unified-top-card__primary-description-container", ".jobs-unified-top-card__primary-description", ".jobs-unified-top-card__bullet"]);
    const desc = firstText(document, ["#job-details", ".jobs-description__content", ".jobs-box__html-content", ".jobs-description-content__text", ".jobs-description"]);
    if (title || desc) {
      const companyLinks = [];
      document.querySelectorAll('a[href*="/company/"]').forEach((a) => {
        const h = abs(a.getAttribute("href"));
        if (/\/company\//.test(h) && !companyLinks.includes(h)) companyLinks.push(h);
      });
      return { authorName: company || title || "this job", headline: title, degree: "", authorProfileUrl: "", postText: [title, company, loc, "", desc].filter(Boolean).join("\n"), role: title, previewCard: "", links: [location.href], companyLinks, postUrl: location.href.split("?")[0], isJob: true };
    }
  }

  // Profile page
  if (/\/in\//.test(location.pathname)) {
    const name = firstText(document, [".text-heading-xlarge", "main h1", "h1.inline.t-24"]);
    if (name) {
      const headline = firstText(document, [".text-body-medium.break-words", ".pv-text-details__left-panel .text-body-medium"]);
      const sectionText = (id) => {
        const a = document.getElementById(id);
        const sec = a && a.closest("section");
        return sec ? (sec.innerText || "").replace(/\s+\n/g, "\n").trim().slice(0, 2200) : "";
      };
      const about = sectionText("about");
      const experience = sectionText("experience");
      const companyLinks = [];
      document.querySelectorAll('main a[href*="/company/"]').forEach((a) => {
        const h = abs(a.getAttribute("href"));
        if (/\/company\//.test(h) && !companyLinks.includes(h)) companyLinks.push(h);
      });
      const postText = [name && `Name: ${name}`, headline && `Headline: ${headline}`, about && `\nAbout:\n${about}`, experience && `\nExperience:\n${experience}`].filter(Boolean).join("\n");
      let degree = "";
      const dm = (firstText(document, [".dist-value", ".distance-badge"]) || "").match(/(1st|2nd|3rd)/i);
      if (dm) degree = dm[1].toLowerCase();
      return { authorName: name, headline, degree, authorProfileUrl: location.href.split("?")[0], postText, role: headline, previewCard: "", links: [], companyLinks, isProfile: true, postUrl: location.href.split("?")[0] };
    }
  }

  // Most-visible feed/search post
  const sel = ["div.feed-shared-update-v2", "div.fie-impression-container", '[data-urn*="urn:li:activity"]', '[data-id*="urn:li:activity"]'].join(",");
  const posts = [...document.querySelectorAll(sel)];
  if (posts.length) {
    const cy = window.innerHeight / 2;
    let best = null, bd = Infinity;
    for (const p of posts) {
      const r = p.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bd) { bd = d; best = p; }
    }
    best = best || posts[0];
    const actor = best.querySelector(".update-components-actor") || best;
    const authorName = firstText(actor, ['.update-components-actor__title span[aria-hidden="true"]', ".update-components-actor__title", ".update-components-actor__name"]);
    const headline = firstText(actor, [".update-components-actor__description"]);
    let degree = "";
    const dm = (actor.innerText || "").match(/(?:^|[•·\s])(1st|2nd|3rd)\b/i);
    if (dm) degree = dm[1].toLowerCase();
    const pl = actor.querySelector('a[href*="/in/"]') || best.querySelector('a[href*="/in/"]');
    const authorProfileUrl = pl ? abs(pl.getAttribute("href")).split("?")[0] : "";
    const postText = firstText(best, [".update-components-text", ".feed-shared-update-v2__description", ".feed-shared-inline-show-more-text"]);
    const previewCard = firstText(best, [".update-components-article", ".feed-shared-article", ".update-components-entity"]);
    const links = [], companyLinks = [];
    best.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;
      const full = abs(href);
      let host = "";
      try { host = new URL(full).hostname; } catch {}
      if (/\/company\//.test(full) && !companyLinks.includes(full)) companyLinks.push(full);
      const isLi = /(^|\.)linkedin\.com$/.test(host);
      const keep = /^https?:/.test(full) && ((!isLi && !/\.licdn\.com$/.test(host)) || /\/jobs\/view\//.test(full));
      if (keep && !links.includes(full) && links.length < 8) links.push(full);
    });
    let postUrl = location.href;
    const urnEl = best.matches("[data-urn]") ? best : best.querySelector("[data-urn]");
    const urn = urnEl && urnEl.getAttribute("data-urn");
    if (urn && /urn:li:activity/.test(urn)) postUrl = `https://www.linkedin.com/feed/update/${urn}/`;
    if (postText || authorName) return { authorName, headline, degree, authorProfileUrl, postText, previewCard, links, companyLinks, postUrl };
  }

  // Selection fallback
  const s = (window.getSelection && window.getSelection().toString().trim()) || "";
  if (s.length > 30) return { authorName: "", headline: "", degree: "", authorProfileUrl: "", postText: s, role: "", previewCard: "", links: [], companyLinks: [], postUrl: location.href };
  return null;
}

// Returns { post, reason }. Injects pageExtract on demand so it works on any
// LinkedIn tab regardless of when it was opened (no reliance on a pre-injected script).
async function getCurrentPost() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  if (!tab || !/^https:\/\/([a-z-]+\.)?linkedin\.com\//.test(tab.url || "")) return { post: null, reason: "not_linkedin" };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtract });
    const post = res && res.result;
    return post ? { post, reason: null } : { post: null, reason: "no_post" };
  } catch (e) {
    return { post: null, reason: "cant_inject" };
  }
}

function peopleSearch({ companyId, network, keywords } = {}) {
  const p = new URLSearchParams();
  if (keywords) p.set("keywords", keywords);
  if (companyId) p.set("currentCompany", `["${companyId}"]`);
  if (network) p.set("network", `["${network}"]`);
  p.set("origin", "FACETED_SEARCH");
  return "https://www.linkedin.com/search/results/people/?" + p.toString();
}

// ---------------------------------------------------------------- state
let currentPost = null;
let charLimit = 200;
let currentTab = "draft";
let whoState = { active: false, name: "", id: null, role: "" };
let lastSrcKey = ""; // identifies the post the source text was filled from
let reportText = ""; // keyword-gap report (rendered into a div, not a textarea)

const REPORT_PLACEHOLDER = "Match score, missing keywords, and suggestions appear here.";
function renderReport(text) {
  reportText = text || "";
  const el = $("r_out");
  if (reportText) {
    el.textContent = reportText;
    el.removeAttribute("data-empty");
  } else {
    el.textContent = REPORT_PLACEHOLDER;
    el.setAttribute("data-empty", "1");
  }
}

// Persist the working UI across popup open/close (session = cleared on browser restart).
const STATE_KEY = "uiState";
let saveTimer = null;
function snapshot() {
  return {
    activeTab: currentTab,
    jobUrl: $("job_url").value,
    dPost: $("d_post").value,
    dOut: $("d_out").value,
    rPost: $("r_post").value,
    rOut: reportText,
    who: whoState,
    srcKey: lastSrcKey,
    dStyle: $("d_style").value,
  };
}
function saveState() {
  try {
    chrome.storage.session.set({ [STATE_KEY]: snapshot() });
  } catch {}
}
function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 300);
}
async function restoreState() {
  let st;
  try {
    st = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
  } catch {}
  if (!st) return false;
  $("job_url").value = st.jobUrl || "";
  $("d_post").value = st.dPost || "";
  $("d_out").value = st.dOut || "";
  $("r_post").value = st.rPost || "";
  renderReport(st.rOut || "");
  if (st.dStyle) $("d_style").value = st.dStyle;
  lastSrcKey = st.srcKey || "";
  updateMeta();
  if (st.activeTab) showTab(st.activeTab);
  if (st.who && st.who.active) renderWho({ name: st.who.name, id: st.who.id, role: st.who.role });
  return true;
}
// any user edit to a field updates saved state
document.addEventListener("input", saveStateDebounced);

function setStatus(id, msg, kind = "") {
  const e = $(id);
  e.textContent = msg || "";
  e.className = "status" + (kind ? " " + kind : "");
}

function postKey(p) {
  if (!p) return "";
  return p.postUrl || (p.authorName || "") + "|" + (p.postText || "").slice(0, 80);
}
async function refreshSource(force = false) {
  $("srcinfo").textContent = "Loading current post…";
  const { post, reason } = await getCurrentPost();
  currentPost = post;
  if (!post) {
    const msgs = {
      not_linkedin: "Open a LinkedIn tab (feed, a post, a job, or a profile), then click ↻ — or paste text below.",
      no_content_script: "Can't reach the page. Reload the extension at chrome://extensions, then open a NEW LinkedIn tab.",
      no_post: "On LinkedIn but no post found here. Open the post/job/profile's own page, or highlight its text, then ↻.",
    };
    $("srcinfo").textContent = msgs[reason] || "No LinkedIn post detected — paste text below.";
    return;
  }
  const who = currentPost.authorName || "a post";
  $("srcinfo").innerHTML = `Using <b>${escapeHtml(who)}</b>${currentPost.headline ? " — " + escapeHtml(currentPost.headline.slice(0, 48)) : ""}`;

  const key = postKey(currentPost);
  // Refresh the source text only when the post actually changed (or user forced it),
  // so reopening on the same post keeps edits, but a new post replaces stale content.
  if (force || key !== lastSrcKey) {
    $("d_post").value = currentPost.postText || "";
    $("r_post").value = currentPost.postText || "";
    $("d_out").value = "";
    renderReport("");
    updateMeta();
    whoState = { active: false, name: "", id: null, role: "" };
    $("w_body").innerHTML = `<div class="muted">Click “Find people” to resolve the company.</div>`;
    lastSrcKey = key;
    saveState();
  }
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function companySearchUrl(name) {
  const p = new URLSearchParams();
  p.set("keywords", name || "");
  return "https://www.linkedin.com/search/results/companies/?" + p.toString();
}

// shared job-URL fetch (one field used by all tabs, cached per URL)
let fetchCache = { url: "", text: "" };
async function getJobText(statusId) {
  const url = $("job_url").value.trim();
  if (!url) return null;
  if (fetchCache.url === url && fetchCache.text) return fetchCache.text;
  setStatus(statusId, "Fetching job page…");
  const resp = await sendBg({ type: "fetchUrl", url });
  if (!resp.ok) {
    setStatus(statusId, resp.error, "bad");
    return null;
  }
  fetchCache = { url, text: resp.text };
  setStatus(statusId, `Loaded: ${resp.title || url}`, "good");
  return resp.text;
}
function activeStatusId() {
  if (!$("pane-draft").classList.contains("hidden")) return "d_status";
  if (!$("pane-resume").classList.contains("hidden")) return "r_status";
  return "w_status";
}

// Build a post object for the model: current page post + shared URL (as a company signal) + typed text.
function buildPost(textareaId) {
  const typed = textareaId ? $(textareaId).value.trim() : "";
  const base = currentPost || {};
  const url = $("job_url").value.trim();
  const links = [...(base.links || [])];
  if (url && !links.includes(url)) links.unshift(url);
  const postText = typed || base.postText || $("d_post").value.trim() || $("r_post").value.trim();
  return { ...base, links, postText };
}

// ---------------------------------------------------------------- tabs
const TABS = ["draft", "resume", "who", "settings"];
function showTab(tab) {
  currentTab = tab;
  TABS.forEach((t) => $("pane-" + t).classList.toggle("hidden", t !== tab));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("tab-active", b.dataset.tab === tab));
  // source banner + shared URL only relevant to the action tabs
  $("srcbar").classList.toggle("hidden", tab === "settings");
  $("urlbar").classList.toggle("hidden", tab === "settings");
  $("tabs").classList.toggle("settingsmode", tab === "settings");
  saveStateDebounced();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("gear").addEventListener("click", () => showTab($("pane-settings").classList.contains("hidden") ? "settings" : "draft"));
$("srcReload").addEventListener("click", () => refreshSource(true));

// ---------------------------------------------------------------- DRAFT
$("d_post").oninput = null;
$("d_out").addEventListener("input", () => updateMeta());
function updateMeta() {
  const n = $("d_out").value.length;
  $("d_meta").innerHTML = `<span class="count${n > charLimit ? " over" : ""}">${n} / ${charLimit} chars</span>`;
}
// Graceful hard trim to the limit at a sentence/word boundary.
function fitToLimit(text, limit) {
  text = (text || "").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const punct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (punct > limit * 0.5) return cut.slice(0, punct + 1).trim();
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).trim();
}
// Ensure a draft is within the limit: ask the model to shorten (up to twice), then hard-trim.
async function enforceLimit(text, statusId) {
  let out = (text || "").trim();
  let tries = 0;
  while (out.length > charLimit && tries < 2) {
    setStatus(statusId, "Trimming to fit…");
    const s = await sendBg({ type: "shorten", draft: out });
    if (!s.ok) break;
    out = (s.text || "").trim();
    tries++;
  }
  return out.length > charLimit ? fitToLimit(out, charLimit) : out;
}
const DRAFT_BTNS = ["d_gen", "d_variants", "d_shorten"];
$("d_gen").addEventListener("click", () =>
  withBusy(DRAFT_BTNS, async () => {
    setStatus("d_status", "Drafting…");
    const url = $("job_url").value.trim();
    const jobText = await getJobText("d_status");
    if (url && !jobText && !$("d_post").value.trim() && !(currentPost && currentPost.postText)) return; // keep fetch error visible
    const post = buildPost("d_post");
    if (jobText) post.postText = jobText;
    if (!post.postText) return setStatus("d_status", "No post text — paste something or open a LinkedIn post.", "bad");
    const resp = await sendBg({ type: "draft", post, style: $("d_style").value });
    if (!resp.ok) return setStatus("d_status", resp.error, "bad");
    $("d_out").value = await enforceLimit(resp.text, "d_status");
    updateMeta();
    setStatus("d_status", "Draft ready — edit, then copy.", "good");
    saveState();
  })
);
$("d_variants").addEventListener("click", () =>
  withBusy(DRAFT_BTNS, async () => {
    setStatus("d_status", "Generating 3 variants…");
    const url = $("job_url").value.trim();
    const jobText = await getJobText("d_status");
    if (url && !jobText && !$("d_post").value.trim() && !(currentPost && currentPost.postText)) return;
    const post = buildPost("d_post");
    if (jobText) post.postText = jobText;
    if (!post.postText) return setStatus("d_status", "No post text — paste something or open a LinkedIn post.", "bad");
    const resp = await sendBg({ type: "draftVariants", post, style: $("d_style").value });
    if (!resp.ok) return setStatus("d_status", resp.error, "bad");
    $("d_out").value = resp.text;
    $("d_meta").innerHTML = `<span class="count">3 angles — pick one, trim to ${charLimit} chars, then copy.</span>`;
    setStatus("d_status", "3 variants ready — edit the one you like.", "good");
    saveState();
  })
);
$("d_shorten").addEventListener("click", () =>
  withBusy(DRAFT_BTNS, async () => {
    if (!$("d_out").value.trim()) return;
    setStatus("d_status", "Shortening…");
    const resp = await sendBg({ type: "shorten", draft: $("d_out").value });
    if (!resp.ok) return setStatus("d_status", resp.error, "bad");
    $("d_out").value = fitToLimit(resp.text, charLimit);
    updateMeta();
    setStatus("d_status", "Shortened ✓", "good");
    saveState();
  })
);
$("d_copy").addEventListener("click", () => copy($("d_out").value, "d_status"));
$("job_fetch").addEventListener("click", () => withBusy(["job_fetch"], () => getJobText(activeStatusId())));

// ---------------------------------------------------------------- RESUME
$("r_gen").addEventListener("click", () =>
  withBusy(["r_gen"], async () => {
  setStatus("r_status", "Analyzing…");
  const url = $("job_url").value.trim();
  const fetched = await getJobText("r_status");
  if (url && !fetched && !$("r_post").value.trim() && !(currentPost && currentPost.postText)) return; // keep fetch error visible
  const jobText = fetched || $("r_post").value.trim() || (currentPost && currentPost.postText);
  if (!jobText) return setStatus("r_status", "No job text — open a job/post or paste a description.", "bad");
  const resp = await sendBg({ type: "resume", post: buildPost("r_post"), jobText });
  if (!resp.ok) return setStatus("r_status", resp.error, "bad");
  renderReport(resp.text);
  setStatus("r_status", "Analysis ready.", "good");
  saveState();
  })
);
$("r_copy").addEventListener("click", () => copy(reportText, "r_status"));

// ---------------------------------------------------------------- WHO DO I KNOW
$("w_gen").addEventListener("click", () =>
  withBusy(["w_gen"], () => runWho().catch((e) => setStatus("w_status", "Error: " + (e && e.message ? e.message : e), "bad")))
);
async function runWho() {
  const post = buildPost(null);
  // If a job URL is provided, fetch it so we can resolve the company even when
  // it isn't visible in the post text (best-effort; ignored if blocked).
  if ($("job_url").value.trim()) {
    const jt = await getJobText("w_status");
    if (jt) post.postText = (post.postText ? post.postText + "\n\n" : "") + jt;
  }
  $("w_body").innerHTML = `<div class="muted">Resolving company…</div>`;
  setStatus("w_status", "Resolving…");
  const resp = await sendBg({ type: "resolveCompany", post });
  if (!resp.ok) {
    // Still let the user search manually for the company.
    renderWho({ name: "", id: null, role: "" });
    return setStatus("w_status", resp.error, "bad");
  }
  renderWho({ name: (resp.company && resp.company.name) || "", id: resp.company && resp.company.id, role: resp.role || "" });
}
function renderWho(data) {
  const { name = "", id = null, role = "" } = data;
  whoState = { active: true, name, id, role };
  saveState();
  $("w_body").innerHTML = `
    <label class="lbl">Company ${name ? "(confirm or edit)" : "— not detected, type or search it"}</label>
    <input id="w_company" type="text" value="${escapeHtml(name)}" placeholder="Type a company name…" />
    <p class="hint">${id ? "Matched a company ID — precise search." : "Keyword search (no exact company ID found). Use “Find / verify company” to locate the exact company page."}</p>
    <div id="w_links" class="links"></div>
    <p class="hint">Opens LinkedIn's own search. Send connection requests <b>manually, one at a time</b>.</p>`;
  const links = $("w_links");
  const input = $("w_company");
  if (!name) input.focus();
  const render = () => {
    const co = input.value.trim();
    whoState.name = co;
    saveStateDebounced();
    const u = id
      ? {
          f: peopleSearch({ companyId: id, network: "F" }),
          s: peopleSearch({ companyId: id, network: "S" }),
          role: peopleSearch({ companyId: id, keywords: role }),
          rec: peopleSearch({ companyId: id, keywords: "recruiter OR talent OR hiring" }),
        }
      : {
          f: peopleSearch({ network: "F", keywords: co }),
          s: peopleSearch({ network: "S", keywords: co }),
          role: peopleSearch({ keywords: [co, role].filter(Boolean).join(" ") }),
          rec: peopleSearch({ keywords: `${co} recruiter` }),
        };
    links.innerHTML = "";
    const add = (label, href) => {
      const a = document.createElement("a");
      a.className = "pill";
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      links.appendChild(a);
    };
    add("① My connections (1st)", u.f);
    add("② Friends-of-friends (2nd)", u.s);
    add("③ People in this role", u.role);
    add("④ Recruiters / hiring", u.rec);
    if (co) add("🔍 Find / verify company on LinkedIn", companySearchUrl(co));
  };
  input.addEventListener("input", render);
  render();
  setStatus("w_status", name ? `Detected: ${name}` : "Enter the company.", name ? "good" : "");
}

// ---------------------------------------------------------------- clipboard
async function copy(value, statusId) {
  try {
    await navigator.clipboard.writeText(value || "");
    setStatus(statusId, "Copied ✓", "good");
  } catch {
    setStatus(statusId, "Couldn't copy — select and copy manually.", "bad");
  }
}

// ---------------------------------------------------------------- settings
function modelHint() {
  $("modelHint").textContent =
    $("provider").value === "anthropic"
      ? "Default: claude-haiku-4-5-20251001 (cheap). Upgrade: claude-sonnet-4-6."
      : "e.g. gpt-4o-mini, or any OpenAI-compatible model at your base URL.";
}
function syncProviderUI() {
  $("baseUrlRow").classList.toggle("hidden", $("provider").value !== "openai");
  modelHint();
}
async function loadSettings() {
  const { settings, resumeText } = await chrome.storage.local.get(["settings", "resumeText"]);
  const s = settings || {};
  $("provider").value = s.provider || "anthropic";
  $("apiKey").value = s.apiKey || "";
  $("baseUrl").value = s.baseUrl || "https://api.openai.com/v1";
  $("model").value = s.model || ($("provider").value === "openai" ? OPENAI_DEFAULT : ANTHROPIC_DEFAULT);
  $("aboutMe").value = s.aboutMe || "";
  $("goal").value = s.goal || "";
  $("tone").value = s.tone || "warm, professional, specific";
  $("charLimit").value = s.charLimit || 200;
  $("extra").value = s.extra || "";
  $("fetchEnabled").checked = !!s.fetchEnabled;
  $("resumeText").value = resumeText || "";
  charLimit = Number(s.charLimit) || 200;
  syncProviderUI();
  if (resumeText) $("resumeStatus").textContent = `${resumeText.length.toLocaleString()} characters stored.`;
  $("r_resumehint").textContent = resumeText ? "Using your saved resume." : "No resume saved — add one in Settings (⚙).";
  if (!s.apiKey) showTab("settings");
}
async function saveSettings() {
  const settings = {
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim() || "https://api.openai.com/v1",
    model: $("model").value.trim() || ($("provider").value === "openai" ? OPENAI_DEFAULT : ANTHROPIC_DEFAULT),
    aboutMe: $("aboutMe").value.trim(),
    goal: $("goal").value.trim(),
    tone: $("tone").value.trim() || "warm, professional, specific",
    charLimit: Math.min(300, Math.max(100, Number($("charLimit").value) || 200)),
    extra: $("extra").value.trim(),
    fetchEnabled: $("fetchEnabled").checked,
  };
  await chrome.storage.local.set({ settings, resumeText: $("resumeText").value.trim() });
  charLimit = settings.charLimit;
  setStatus("status", "Saved ✓", "good");
  setTimeout(() => setStatus("status", ""), 1600);
}
$("save").addEventListener("click", saveSettings);
$("provider").addEventListener("change", () => {
  const cur = $("model").value.trim();
  if (!cur || cur === ANTHROPIC_DEFAULT || cur === OPENAI_DEFAULT)
    $("model").value = $("provider").value === "openai" ? OPENAI_DEFAULT : ANTHROPIC_DEFAULT;
  syncProviderUI();
});
$("fromResume").addEventListener("click", () => {
  const r = $("resumeText").value.trim();
  if (r) $("aboutMe").value = r.slice(0, 600);
});
$("fetchEnabled").addEventListener("change", async (e) => {
  if (e.target.checked) {
    const granted = await chrome.permissions.request({ origins: ["https://*/*"] });
    if (!granted) {
      e.target.checked = false;
      setStatus("status", "Permission denied.", "bad");
      setTimeout(() => setStatus("status", ""), 1600);
    }
  }
});

// resume parsing
async function parsePdf(file) {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/lib/pdf.worker.min.js");
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map((it) => it.str).join(" ") + "\n";
  }
  return out.replace(/\s+\n/g, "\n").trim();
}
$("resumeFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("resumeStatus").textContent = "Parsing…";
  try {
    const text = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? await parsePdf(file) : await file.text();
    $("resumeText").value = text;
    $("resumeStatus").textContent = `Parsed ${text.length.toLocaleString()} characters. Review/edit, then Save.`;
    if (!$("aboutMe").value.trim()) $("aboutMe").value = text.slice(0, 600);
  } catch {
    $("resumeStatus").textContent = "Couldn't parse that file — try a .txt or paste the text.";
  }
});

// ---------------------------------------------------------------- init
(async () => {
  await loadSettings();
  await restoreState(); // bring back the last session's drafts/inputs/tab
  await refreshSource(); // updates the "current post" banner; won't overwrite restored text
})();
