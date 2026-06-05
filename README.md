# LinkedIn Assistant (Chrome extension)

A privacy-respecting Chrome extension that helps you act on LinkedIn posts for roles you're after —
from the post you're already viewing. No server, no background scraping, no auto-sending. You review
and send everything yourself.

## What it does

On any LinkedIn post you get four buttons:

- **✦ Draft message** — a tailored connection note (or a DM if you're already 1st-degree),
  grounded in your résumé/profile and your stated goal. Editable, with a live character counter,
  **Regenerate** and **Shorten**.
- **✦ Resume keywords** — compares your résumé to the role and reports a **match score**, the
  **keywords you're missing**, what's **already covered**, and where to add them (advice only — it
  never edits your résumé).
- **✦ Who do I know here** — resolves the hiring company from the post and gives you LinkedIn
  deep-links to: ① your **1st-degree** connections there, ② **friends-of-friends** (2nd-degree),
  ③ **relevant people** in the role, ④ **recruiters / hiring managers**.
- **Copy post** — copies the post text (works with no API key).

A **manual mode** in the popup lets you paste any post/job text to draft or analyze without a page.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. Click the extension icon to open the popup and add:
   - **Provider + API key** — Anthropic (default, cheap **Claude Haiku 4.5**) or any
     OpenAI-compatible endpoint (set the base URL + model).
   - **About you** and **What I'm looking for**.
   - **Résumé** (PDF or `.txt`, parsed in your browser; review/edit the extracted text), then **Save**.
3. Go to LinkedIn — the buttons appear on posts (feed, post permalinks, and search results).

Get an Anthropic key at https://console.anthropic.com → API Keys.

## Optional: fetch linked job pages

If a post links to a job posting, enable **"Allow fetching linked job pages"** in the popup (it asks
for a one-time permission). Then paste the job URL into the panel's URL field to use the full job
text. This is best-effort — login-gated or JS-heavy pages may not load, so a **"paste the job text
instead"** fallback is always available.

## Privacy & safety

- Your API key and résumé are stored **locally** in your browser (`chrome.storage.local`).
- Post/résumé text is sent to **your chosen model provider** only when you trigger a draft/analysis.
  With the default cheap model, cost is ~a fraction of a cent per draft.
- The extension only reads the post you click — **no background scraping, no auto-send**.
- Reaching out to people happens **manually, one at a time**, as connection requests.
- LinkedIn limits: free accounts get ~5 personalized invites/month and throttle heavy searching.
- Reading search results / fetching pages is best-effort and a bit ToS-sensitive; deep-link-only and
  manual paste are the safe fallbacks.
