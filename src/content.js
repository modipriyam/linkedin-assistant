// content.js — injects action buttons on LinkedIn posts and renders the result panel.
// Classic content script (no ES modules).

(() => {
  "use strict";
  const NS = "lca";
  const POST_SELECTOR = [
    "div.feed-shared-update-v2",
    "div.fie-impression-container",
    'div[data-urn^="urn:li:activity"]',
  ].join(",");

  // ---- small DOM helpers ---------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const firstText = (root, selectors) => {
    for (const s of selectors) {
      const n = root.querySelector(s);
      const t = n && (n.innerText || n.textContent || "").trim();
      if (t) return t;
    }
    return "";
  };
  const abs = (href) => {
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  };

  function peopleSearch({ companyId, network, keywords } = {}) {
    const p = new URLSearchParams();
    if (keywords) p.set("keywords", keywords);
    if (companyId) p.set("currentCompany", `["${companyId}"]`);
    if (network) p.set("network", `["${network}"]`);
    p.set("origin", "FACETED_SEARCH");
    return "https://www.linkedin.com/search/results/people/?" + p.toString();
  }

  // ---- post extraction -----------------------------------------------------
  function extractPost(container) {
    const actor = container.querySelector(".update-components-actor") || container;
    const authorName = firstText(actor, [
      '.update-components-actor__title span[aria-hidden="true"]',
      ".update-components-actor__title",
      ".update-components-actor__name",
    ]);
    const headline = firstText(actor, [".update-components-actor__description"]);

    let degree = "";
    const actorText = (actor.innerText || "").replace(/ /g, " ");
    const dm = actorText.match(/(?:^|[•·\s])(1st|2nd|3rd)\b/i);
    if (dm) degree = dm[1].toLowerCase();

    const profileLink =
      actor.querySelector('a[href*="/in/"]') || container.querySelector('a[href*="/in/"]');
    const authorProfileUrl = profileLink ? abs(profileLink.getAttribute("href")).split("?")[0] : "";

    const postText = firstText(container, [
      ".update-components-text",
      ".feed-shared-update-v2__description",
      ".feed-shared-inline-show-more-text",
    ]);

    const previewCard = firstText(container, [
      ".update-components-article",
      ".feed-shared-article",
      ".update-components-entity",
      ".feed-shared-external-video__meta",
    ]);

    // links + company links
    const links = [];
    const companyLinks = [];
    container.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;
      const full = abs(href);
      let host = "";
      try {
        host = new URL(full).hostname;
      } catch {}
      if (/\/company\//.test(full)) {
        if (!companyLinks.includes(full)) companyLinks.push(full);
      }
      const isLinkedIn = /(^|\.)linkedin\.com$/.test(host);
      const keep =
        /^https?:/.test(full) &&
        ((!isLinkedIn && !/\.licdn\.com$/.test(host)) || /\/jobs\/view\//.test(full));
      if (keep && !links.includes(full) && links.length < 8) links.push(full);
    });

    let postUrl = location.href;
    const urnEl = container.matches("[data-urn]") ? container : container.querySelector("[data-urn]");
    const urn = urnEl && urnEl.getAttribute("data-urn");
    if (urn && /urn:li:activity/.test(urn)) postUrl = `https://www.linkedin.com/feed/update/${urn}/`;

    return { authorName, headline, degree, authorProfileUrl, postText, previewCard, links, companyLinks, postUrl };
  }

  // ---- background messaging ------------------------------------------------
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(resp || { ok: false, error: "No response." });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });

  // ---- panel ---------------------------------------------------------------
  let panel, refs;
  function buildPanel() {
    if (panel) return;
    panel = el("div", `${NS}-panel`);
    panel.innerHTML = `
      <div class="${NS}-head">
        <span class="${NS}-brand"><span class="${NS}-dot"></span><span class="${NS}-title">LinkedIn Assistant</span></span>
        <span class="${NS}-headbtns">
          <button class="${NS}-icon ${NS}-settings" title="Settings" aria-label="Settings">⚙</button>
          <button class="${NS}-icon ${NS}-close" title="Close" aria-label="Close">✕</button>
        </span>
      </div>
      <div class="${NS}-tabs">
        <button class="${NS}-tab" data-tab="draft">Draft message</button>
        <button class="${NS}-tab" data-tab="resume">Resume keywords</button>
        <button class="${NS}-tab" data-tab="who">Who do I know</button>
      </div>
      <div class="${NS}-body">
        <div class="${NS}-company ${NS}-hidden"></div>
        <textarea class="${NS}-text" spellcheck="true"></textarea>
        <div class="${NS}-meta"></div>
        <div class="${NS}-urlrow">
          <input class="${NS}-url" type="url" placeholder="Optional: paste a job posting URL…" />
          <button class="${NS}-btn ${NS}-ghost ${NS}-usefetch">Use URL</button>
        </div>
      </div>
      <div class="${NS}-foot">
        <div class="${NS}-status"></div>
        <div class="${NS}-actions"></div>
      </div>`;
    document.body.appendChild(panel);
    refs = {
      title: panel.querySelector(`.${NS}-title`),
      company: panel.querySelector(`.${NS}-company`),
      text: panel.querySelector(`.${NS}-text`),
      meta: panel.querySelector(`.${NS}-meta`),
      urlrow: panel.querySelector(`.${NS}-urlrow`),
      url: panel.querySelector(`.${NS}-url`),
      usefetch: panel.querySelector(`.${NS}-usefetch`),
      status: panel.querySelector(`.${NS}-status`),
      actions: panel.querySelector(`.${NS}-actions`),
    };
    panel.querySelector(`.${NS}-close`).addEventListener("click", hidePanel);
    panel.querySelector(`.${NS}-settings`).addEventListener("click", () => send({ type: "openOptions" }));
    panel.querySelectorAll(`.${NS}-tab`).forEach((t) =>
      t.addEventListener("click", () => selectTab(t.getAttribute("data-tab")))
    );
    refs.usefetch.addEventListener("click", () => maybeFetchJob());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel && !panel.classList.contains(`${NS}-hidden`)) hidePanel();
    });
  }
  const showPanel = () => {
    buildPanel();
    panel.classList.remove(`${NS}-hidden`);
  };
  const hidePanel = () => panel && panel.classList.add(`${NS}-hidden`);

  function setStatus(msg, kind = "") {
    refs.status.textContent = msg || "";
    refs.status.className = `${NS}-status${kind ? " " + NS + "-" + kind : ""}`;
  }
  function setActions(buttons) {
    refs.actions.innerHTML = "";
    buttons.forEach((b) => {
      const btn = el("button", `${NS}-btn ${b.variant || ""}`, b.label);
      if (b.disabled) btn.disabled = true;
      btn.addEventListener("click", b.onClick);
      refs.actions.appendChild(btn);
    });
  }
  function updateCharMeta(limit) {
    const n = refs.text.value.length;
    const over = n > limit;
    refs.meta.innerHTML = `<span class="${NS}-count${over ? " " + NS + "-over" : ""}">${n} / ${limit} chars</span>`;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied to clipboard ✓", "good");
    } catch {
      setStatus("Couldn't copy — select the text and copy manually.", "bad");
    }
  }

  // ---- actions -------------------------------------------------------------
  let CHAR_LIMIT = 200;
  chrome.storage?.local?.get?.("settings", (r) => {
    if (r && r.settings && r.settings.charLimit) CHAR_LIMIT = Number(r.settings.charLimit) || 200;
  });

  async function maybeFetchJob(post) {
    const url = refs.url.value.trim();
    if (!url) return null;
    setStatus("Fetching job page…");
    const resp = await send({ type: "fetchUrl", url });
    if (!resp.ok) {
      setStatus(resp.error, "bad");
      return null;
    }
    setStatus(`Loaded: ${resp.title || url}`, "good");
    return resp.text;
  }

  // Keep a draft within the character limit: ask to shorten (up to twice), then hard-trim.
  async function fitLimit(text) {
    let out = (text || "").trim();
    let tries = 0;
    while (out.length > CHAR_LIMIT && tries < 2) {
      setStatus("Trimming to fit…");
      const s = await send({ type: "shorten", draft: out });
      if (!s.ok) break;
      out = (s.text || "").trim();
      tries++;
    }
    if (out.length > CHAR_LIMIT) {
      const cut = out.slice(0, CHAR_LIMIT);
      const p = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      const sp = cut.lastIndexOf(" ");
      out = (p > CHAR_LIMIT * 0.5 ? cut.slice(0, p + 1) : sp > 0 ? cut.slice(0, sp) : cut).trim();
    }
    return out;
  }

  // current post + per-tab result cache (cleared when the panel opens for a new post)
  let currentPost = null;
  let activeTab = "draft";
  let cache = { draft: null, resume: null, who: null };

  function openPanelFor(post, tab) {
    showPanel();
    currentPost = post;
    cache = { draft: null, resume: null, who: null };
    selectTab(tab);
  }

  function selectTab(tab) {
    if (!currentPost) return;
    activeTab = tab;
    buildPanel();
    panel.querySelectorAll(`.${NS}-tab`).forEach((t) =>
      t.classList.toggle(`${NS}-tabactive`, t.getAttribute("data-tab") === tab)
    );
    refs.meta.textContent = "";
    setActions([]);
    setStatus("");
    if (tab === "draft") renderDraft();
    else if (tab === "resume") renderResume();
    else renderWho();
  }

  async function renderDraft() {
    const post = currentPost;
    refs.company.classList.add(`${NS}-hidden`);
    refs.text.classList.remove(`${NS}-hidden`);
    refs.urlrow.classList.remove(`${NS}-hidden`);
    refs.text.readOnly = false;
    refs.title.textContent = (post.degree || "").startsWith("1") ? "Direct message" : "Connection note";
    refs.text.oninput = () => {
      updateCharMeta(CHAR_LIMIT);
      if (cache.draft) cache.draft.text = refs.text.value;
    };

    const generate = async () => {
      refs.text.value = "";
      setStatus("Drafting…");
      const jobText = await maybeFetchJob(post);
      const resp = await send({ type: "draft", post: { ...post, postText: jobText || post.postText } });
      if (activeTab !== "draft") return;
      if (!resp.ok) return setStatus(resp.error, "bad");
      const fitted = await fitLimit(resp.text);
      refs.text.value = fitted;
      cache.draft = { text: fitted };
      updateCharMeta(CHAR_LIMIT);
      setStatus("Draft ready — review, edit, then copy.", "good");
    };
    setActions([
      { label: "Copy", variant: `${NS}-primary`, onClick: () => copyText(refs.text.value) },
      { label: "Regenerate", onClick: generate },
      {
        label: "Shorten",
        onClick: async () => {
          setStatus("Shortening…");
          const resp = await send({ type: "shorten", draft: refs.text.value });
          if (!resp.ok) return setStatus(resp.error, "bad");
          refs.text.value = resp.text;
          cache.draft = { text: resp.text };
          updateCharMeta(CHAR_LIMIT);
          setStatus("Shortened ✓", "good");
        },
      },
    ]);
    if (cache.draft) {
      refs.text.value = cache.draft.text;
      updateCharMeta(CHAR_LIMIT);
      setStatus("Draft ready — review, edit, then copy.", "good");
    } else {
      await generate();
    }
  }

  async function renderResume() {
    const post = currentPost;
    refs.company.classList.add(`${NS}-hidden`);
    refs.text.classList.remove(`${NS}-hidden`);
    refs.urlrow.classList.remove(`${NS}-hidden`);
    refs.text.readOnly = true;
    refs.text.oninput = null;
    refs.title.textContent = "Resume keyword gap";

    const generate = async () => {
      refs.text.value = "";
      setStatus("Analyzing…");
      const jobText = await maybeFetchJob(post);
      const resp = await send({ type: "resume", post, jobText });
      if (activeTab !== "resume") return;
      if (!resp.ok) return setStatus(resp.error, "bad");
      refs.text.value = resp.text;
      cache.resume = { text: resp.text };
      setStatus("Analysis ready.", "good");
    };
    setActions([
      { label: "Copy", variant: `${NS}-primary`, onClick: () => copyText(refs.text.value) },
      { label: "Re-analyze", onClick: generate },
    ]);
    if (cache.resume) {
      refs.text.value = cache.resume.text;
      setStatus("Analysis ready.", "good");
    } else {
      await generate();
    }
  }

  function renderCompanyUI(data) {
    const { name = "", id = null, role = "" } = data;
    refs.company.innerHTML = `
      <label class="${NS}-label">Company (confirm or edit)</label>
      <input class="${NS}-url ${NS}-companyinput" value="${name.replace(/"/g, "&quot;")}" />
      <div class="${NS}-muted">${id ? "Matched company ID — precise search." : "Using a keyword search (no exact company ID found)."}</div>
      <div class="${NS}-links"></div>
      <div class="${NS}-note">These open LinkedIn's own search. Send connection requests <b>manually, one at a time</b>.</div>`;
    const links = refs.company.querySelector(`.${NS}-links`);
    const companyInput = refs.company.querySelector(`.${NS}-companyinput`);

    const renderLinks = () => {
      const co = companyInput.value.trim();
      data.name = co;
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
      const add = (label, href, hint) => {
        const a = el("a", `${NS}-pill`, label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        if (hint) a.title = hint;
        links.appendChild(a);
      };
      add("① My connections (1st)", u.f, "1st-degree connections at this company");
      add("② Friends-of-friends (2nd)", u.s, "2nd-degree people at this company");
      add("③ People in this role", u.role, "Relevant people at the company");
      add("④ Recruiters / hiring", u.rec, "Recruiters & hiring managers");
    };
    companyInput.addEventListener("input", renderLinks);
    renderLinks();
    setStatus(name ? `Detected: ${name}` : "Enter the company to search.", name ? "good" : "");
  }

  async function renderWho() {
    refs.urlrow.classList.add(`${NS}-hidden`);
    refs.text.classList.add(`${NS}-hidden`);
    refs.title.textContent = "Who do I know here?";
    refs.company.classList.remove(`${NS}-hidden`);
    if (cache.who) return renderCompanyUI(cache.who);
    refs.company.innerHTML = `<div class="${NS}-muted">Resolving company…</div>`;
    const resp = await send({ type: "resolveCompany", post: currentPost });
    if (activeTab !== "who") return;
    if (!resp.ok) {
      refs.company.innerHTML = `<div class="${NS}-muted">Couldn't resolve a company.</div>`;
      return setStatus(resp.error, "bad");
    }
    cache.who = { name: (resp.company && resp.company.name) || "", id: resp.company && resp.company.id, role: resp.role || "" };
    renderCompanyUI(cache.who);
  }

  // ---- button injection ----------------------------------------------------
  function makeBtn(label, title, onClick) {
    const b = el("button", `${NS}-action`, label);
    b.title = title;
    b.type = "button";
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function injectInto(container) {
    if (container.getAttribute("data-lca-injected")) return;
    container.setAttribute("data-lca-injected", "1");
    const bar = el("div", `${NS}-bar`);
    const getPost = () => extractPost(container);
    bar.appendChild(makeBtn("✦ Draft message", "Draft a tailored connection message", () => openPanelFor(getPost(), "draft")));
    bar.appendChild(makeBtn("✦ Resume keywords", "Resume keyword-gap vs this role", () => openPanelFor(getPost(), "resume")));
    bar.appendChild(makeBtn("✦ Who do I know here", "Find your path into this company", () => openPanelFor(getPost(), "who")));
    bar.appendChild(
      makeBtn("Copy post", "Copy the post text", async () => {
        const p = getPost();
        const out = [p.authorName, p.headline, "", p.postText, "", p.postUrl].filter(Boolean).join("\n");
        try {
          await navigator.clipboard.writeText(out);
          flash(bar, "Copied ✓");
        } catch {
          flash(bar, "Copy failed");
        }
      })
    );
    // insert at the top of the post
    container.insertBefore(bar, container.firstChild);
  }

  function flash(bar, msg) {
    const f = el("span", `${NS}-flash`, msg);
    bar.appendChild(f);
    setTimeout(() => f.remove(), 1500);
  }

  function scan() {
    document.querySelectorAll(POST_SELECTOR).forEach(injectInto);
  }

  // Pick the post nearest the center of the viewport (for the popup's "current post").
  function pickVisiblePost() {
    const posts = [...document.querySelectorAll(POST_SELECTOR)];
    if (!posts.length) return null;
    const cy = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const p of posts) {
      const r = p.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    best = best || posts[0];
    try {
      return extractPost(best);
    } catch {
      return null;
    }
  }

  // Extract a LinkedIn job-detail page (/jobs/view/...) straight from the DOM.
  function extractJob() {
    const onJob =
      /\/jobs\//.test(location.pathname) ||
      document.querySelector(
        "#job-details, .jobs-description, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title"
      );
    if (!onJob) return null;
    const title = firstText(document, [
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".t-24",
      "h1",
    ]);
    const company = firstText(document, [
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
    ]);
    const loc = firstText(document, [
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".jobs-unified-top-card__primary-description",
      ".jobs-unified-top-card__bullet",
    ]);
    const desc = firstText(document, [
      "#job-details",
      ".jobs-description__content",
      ".jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description",
    ]);
    if (!title && !desc) return null;
    const companyLinks = [];
    document.querySelectorAll('a[href*="/company/"]').forEach((a) => {
      const h = abs(a.getAttribute("href"));
      if (/\/company\//.test(h) && !companyLinks.includes(h)) companyLinks.push(h);
    });
    const postText = [title, company, loc, "", desc].filter((x) => x != null && x !== "").join("\n");
    return {
      authorName: company || title || "this job",
      headline: title,
      degree: "",
      authorProfileUrl: "",
      postText,
      role: title,
      previewCard: "",
      links: [location.href],
      companyLinks,
      postUrl: location.href.split("?")[0],
      isJob: true,
    };
  }

  // Read the text of a profile section identified by its anchor (#about, #experience).
  function sectionText(anchorId, cap = 2200) {
    const a = document.getElementById(anchorId);
    const sec = a && a.closest("section");
    if (!sec) return "";
    return (sec.innerText || "")
      .replace(/\bsee more\b|\bSee more\b|…see more/gi, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, cap);
  }

  // Extract a LinkedIn member profile (/in/...) so messages can be tailored to their experience.
  function extractProfile() {
    if (!/\/in\//.test(location.pathname)) return null;
    const name = firstText(document, [".text-heading-xlarge", "main h1", "h1.inline.t-24"]);
    const headline = firstText(document, [
      ".text-body-medium.break-words",
      ".pv-text-details__left-panel .text-body-medium",
    ]);
    const loc = firstText(document, [
      ".pv-text-details__left-panel .text-body-small.inline",
      ".text-body-small.inline.t-black--light.break-words",
    ]);
    if (!name) return null;
    let degree = "";
    const dm = (firstText(document, [".dist-value", ".distance-badge"]) || "").match(/(1st|2nd|3rd)/i);
    if (dm) degree = dm[1].toLowerCase();

    const about = sectionText("about");
    const experience = sectionText("experience");
    const companyLinks = [];
    document.querySelectorAll('main a[href*="/company/"]').forEach((a) => {
      const h = abs(a.getAttribute("href"));
      if (/\/company\//.test(h) && !companyLinks.includes(h)) companyLinks.push(h);
    });

    const postText = [
      name && `Name: ${name}`,
      headline && `Headline: ${headline}`,
      loc && `Location: ${loc}`,
      about && `\nAbout:\n${about}`,
      experience && `\nExperience:\n${experience}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      authorName: name,
      headline,
      degree,
      authorProfileUrl: location.href.split("?")[0],
      postText,
      role: headline,
      previewCard: "",
      links: [],
      companyLinks,
      isProfile: true,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "getCurrentPost") {
      // Prefer a job page, then a profile page, otherwise the most-visible feed post.
      sendResponse({ ok: true, post: extractJob() || extractProfile() || pickVisiblePost() });
    }
    return false;
  });

  // observe dynamic content + SPA navigation
  const observer = new MutationObserver(() => scheduleScan());
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  }
  observer.observe(document.documentElement, { childList: true, subtree: true });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleScan();
    }
  }, 800);

  scan();
})();
