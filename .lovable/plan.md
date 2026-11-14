# Build a private, browser-first document summarizer

## User experience
- Replace `/` with a mobile-first document workbench: add up to five PDFs, text/Markdown files, pasted text, or public article URLs; show extraction progress and per-item errors, with cancel/remove/retry paths.
- Extract PDF text in the browser and report when image-only scans or visual table/chart content cannot be reliably interpreted. Article fetching may be blocked by publisher/browser CORS; explain that and offer paste-text or downloaded-file fallback.
- Compare source topics before summarization and flag outliers for review. Let users review image/table/chart findings and exclude all or selected findings.
- Summarize the included sources into a deduplicated, topic-aligned result targeting roughly 5% of the combined original input word count (including uploaded summaries). Show measured counts, source references, and a notice when output length cannot reasonably meet the target.
- Offer a local text/Markdown download and ask for explicit confirmation before generating a PowerPoint download from the merged result.

## Provider and privacy experience
- Provide settings for Google Gemini API, OpenAI API, and OpenRouter, with live model discovery/validation from each provider rather than stale model IDs; never change provider implicitly. Users can save a key per provider in device-local storage, choose a model, test a connection, or clear saved keys and session data.
- Explain provider setup, billing/quota ownership, direct-browser CORS/API limits, and the risk that keys stored in browser storage are accessible to someone with access to the device/browser. Clearly disclose that selected source text is sent to the selected provider; this is not on-device AI. Do not use Lovable AI, a shared key, sign-in, cloud history, or cloud storage.
- Add a web-app manifest and document the current Safari/PWA experience and future native AAB/IPA packaging considerations, including that a native secure key store would be preferable to browser storage. Packaging and real-device performance remain unverified until tested on actual devices.

## Technical approach
- Keep the work client-side; use provider-specific browser `fetch` adapters and `AbortController`, with clear unauthorized, quota, network/CORS, and unsupported-model recovery states.
- Add client libraries for PDF extraction and PowerPoint generation only after confirming their browser compatibility. Keep extraction, provider requests, summary workflow, and downloads in focused modules with small tests for the 5% combined-input target and topic-warning behavior.
- Use semantic theme tokens and existing shadcn controls; give the page distinct responsive states for empty, loading, ready-to-review, summarizing, complete, and failure/cancelled.
- Give `/` unique route metadata. Maintain a lean root `roadmap.md` while implementing the multi-part request, and record any new structural decision in `AGENTS.md`.

## Validation
- Run relevant unit tests and inspect the app’s build/runtime logs after changes.
- Exercise the complete public browser flow with sample text and a sample file, including topic warning, toggle controls, text export, and the PowerPoint confirmation gate. Verify Safari-sized layout in the browser; provider requests requiring a user key and actual-device/iOS packaging are not claimed as verified without those credentials/devices.
