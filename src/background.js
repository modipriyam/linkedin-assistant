// background.js — MV3 service worker (module). Routes messages, calls the model,
// resolves the hiring company, and (optionally) fetches a job URL.

import {
  parseCompanyFromUrl,
  extractCompanyIdFromHref,
  slugToName,
  buildPeopleSearchUrl,
  buildCompanySearchUrl,
  pickCompany,
} from "./parse.js";
import {
  buildMessagePrompt,
  buildVariantsPrompt,
  buildShortenPrompt,
  buildResumePrompt,
  buildCompanyExtractPrompt,
} from "./prompts.js";

const DEFAULTS = {
  provider: "anthropic",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "claude-haiku-4-5-20251001",
  aboutMe: "",
  goal: "",
  tone: "warm, professional, specific",
  charLimit: 200,
  extra: "",
  fetchEnabled: false,
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}
async function getResume() {
  const { resumeText } = await chrome.storage.local.get("resumeText");
  return resumeText || "";
}

class FriendlyError extends Error {}

/** Call the configured model and return plain text. */
async function callModel({ system, user, maxTokens = 700 }) {
  const s = await getSettings();
  if (!s.apiKey) throw new FriendlyError("No API key set. Open the extension popup and add your key.");

  let res;
  try {
    if (s.provider === "openai") {
      const base = (s.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({
          model: s.model,
          max_tokens: maxTokens,
          temperature: 0.7,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } else {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": s.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: s.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
    }
  } catch (e) {
    throw new FriendlyError("Network error — check your connection and try again.");
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    if (res.status === 401 || res.status === 403)
      throw new FriendlyError("Authentication failed (401/403). Check your API key and model name.");
    if (res.status === 429)
      throw new FriendlyError("Rate limited or out of credits (429). Wait a moment or check your billing.");
    if (res.status === 404)
      throw new FriendlyError(`Model or endpoint not found (404). Check the model name${s.provider === "openai" ? " and base URL." : "."}`);
    throw new FriendlyError(`Model error (${res.status}). ${detail}`);
  }

  const data = await res.json();
  const text =
    s.provider === "openai"
      ? data?.choices?.[0]?.message?.content
      : (data?.content || []).map((b) => b.text || "").join("");
  if (!text) throw new FriendlyError("The model returned an empty response. Try again.");
  return text.trim();
}

/** Strip HTML to readable-ish text (no DOMParser in a service worker). */
function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  s = s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: s.slice(0, 8000) };
}

async function fetchUrl(url) {
  // LinkedIn pages require the logged-in session and are JS-rendered — fetching returns junk.
  // We read LinkedIn from the page DOM instead, so refuse to fetch and guide the user.
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {}
  if (/(^|\.)linkedin\.com$/.test(host))
    throw new FriendlyError("LinkedIn links can't be fetched — clear this box, open that post/job/profile in a tab, and click Generate/Analyze (it reads the open page).");

  // Allow if we already have permission for this origin or the broad opt-in.
  let originPattern = "https://*/*";
  try {
    originPattern = new URL(url).origin + "/*";
  } catch {}
  const hasBroad = await chrome.permissions.contains({ origins: ["https://*/*"] });
  const hasOrigin = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasBroad && !hasOrigin)
    throw new FriendlyError("Turn on “Allow fetching linked job pages” in Settings (⚙), or paste the job text instead.");
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch {
    throw new FriendlyError("Couldn't reach that URL. Paste the job text instead.");
  }
  if (!res.ok) throw new FriendlyError(`That page returned ${res.status}. Paste the job text instead.`);
  const { title, text } = htmlToText(await res.text());
  if (!text || text.length < 40)
    throw new FriendlyError("That page had no readable text (login-gated or JS-rendered). Paste the job text instead.");
  return { title, text };
}

/** Resolve the hiring company from the post's signals (+ optional model assist). */
async function resolveCompany(post) {
  const candidates = [];

  // 1. tagged company entity links in the post / actor area
  let numericId = null;
  for (const href of post.companyLinks || []) {
    const id = extractCompanyIdFromHref(href);
    if (!id) continue;
    if (/^\d+$/.test(id) && !numericId) numericId = id;
    candidates.push({ slug: id, name: slugToName(id), source: "linkedin-company-link" });
  }
  // 2. job/careers URLs in the post
  for (const href of post.links || []) {
    const c = parseCompanyFromUrl(href);
    if (c) candidates.push(c);
  }

  // 3. model assist (only if a key exists) to read "my team at X is hiring"
  let role = post.role || null;
  try {
    const settings = await getSettings();
    if (settings.apiKey) {
      const urlGuess = candidates.find((c) => c.source !== "linkedin-company-link");
      const { system, user } = buildCompanyExtractPrompt({
        ...post,
        urlCompanyGuess: urlGuess ? urlGuess.name : null,
      });
      const raw = await callModel({ system, user, maxTokens: 120 });
      const json = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());
      if (json.company) candidates.unshift({ slug: null, name: json.company, source: "model", confidence: json.confidence });
      if (json.role && !role) role = json.role;
    }
  } catch {
    // model assist is best-effort; ignore failures
  }

  const best = pickCompany(candidates);
  const companyName = best ? best.name : null;
  const keywords = [companyName, role].filter(Boolean).join(" ");

  const searchUrls = {
    // 1st-degree at company (needs numeric id; else keyword search)
    firstDegree: numericId
      ? buildPeopleSearchUrl({ companyId: numericId, network: "F" })
      : buildPeopleSearchUrl({ network: "F", keywords: companyName || "" }),
    secondDegree: numericId
      ? buildPeopleSearchUrl({ companyId: numericId, network: "S" })
      : buildPeopleSearchUrl({ network: "S", keywords: companyName || "" }),
    // relevant people in the role (any network)
    role: numericId
      ? buildPeopleSearchUrl({ companyId: numericId, keywords: role || "" })
      : buildPeopleSearchUrl({ keywords: keywords }),
    // recruiters / hiring managers at the company
    recruiter: numericId
      ? buildPeopleSearchUrl({ companyId: numericId, keywords: "recruiter OR talent OR hiring" })
      : buildPeopleSearchUrl({ keywords: `${companyName || ""} recruiter` }),
    companyLookup: companyName ? buildCompanySearchUrl(companyName) : null,
  };

  return { company: { name: companyName, id: numericId }, role, candidates, searchUrls, haveId: !!numericId };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "draft": {
          const settings = await getSettings();
          const resume = await getResume();
          const { system, user } = buildMessagePrompt({ post: msg.post, settings: { ...settings, aboutMe: settings.aboutMe || "", resume }, style: msg.style });
          const text = await callModel({ system, user, maxTokens: 500 });
          sendResponse({ ok: true, text });
          break;
        }
        case "draftVariants": {
          const settings = await getSettings();
          const resume = await getResume();
          const { system, user } = buildVariantsPrompt({ post: msg.post, settings: { ...settings, aboutMe: settings.aboutMe || "", resume }, style: msg.style });
          const text = await callModel({ system, user, maxTokens: 900 });
          sendResponse({ ok: true, text });
          break;
        }
        case "shorten": {
          const settings = await getSettings();
          const { system, user } = buildShortenPrompt({ draft: msg.draft, charLimit: settings.charLimit });
          const text = await callModel({ system, user, maxTokens: 300 });
          sendResponse({ ok: true, text });
          break;
        }
        case "resume": {
          const resume = await getResume();
          if (!resume) throw new FriendlyError("No resume saved. Open the popup and upload/paste your resume first.");
          const { system, user } = buildResumePrompt({ resumeText: resume, jobText: msg.jobText, post: msg.post });
          const text = await callModel({ system, user, maxTokens: 700 });
          sendResponse({ ok: true, text });
          break;
        }
        case "resolveCompany": {
          const result = await resolveCompany(msg.post || {});
          sendResponse({ ok: true, ...result });
          break;
        }
        case "fetchUrl": {
          const result = await fetchUrl(msg.url);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "openOptions": {
          if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
          else await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown request." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});
