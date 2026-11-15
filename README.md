# SourceSage Summarizer

I want to make a web app (GitHub) which can be converted to aab, ipa later.

It should open multiple sources, such as PDFs, text, documents, and summarized files, and summarize them to about 5% of the original length. It should merge more than one such file into one summary targeting about 5% of the combined original length, synchronizing similar topics, eliminating duplicate or similar sentences and retaining the core theme. Before summarizing, it should check whether the opened files are on similar topics and warn if one is on a different topic than the majority. PowerPoint should be generated from the merged file, after the user agrees.

The MVP should accept up to 5 items, including PDF, text, Markdown, pasted text, and normal public article pages; no cloud storage. Users should be able to review image, table, and chart findings and toggle all or individual items off when needed.

I will not provide an API key to users. Users will create and use their own API key. Users can save their API key on their downloaded app on their device for later use, keep keys for different AI providers, and switch AI and enter that AI's generated keys for later use.

I will test it in Safari browser on iPhone, use GitHub, and do not want sign-in or Supabase. Results should be available for download. Do not use Lovable AI credits for summarization.

## Locked
- “It should merge more than one such summarised files in to one with 5% of total length of the all summarised files inputted” — the target is about 5% of the combined original length of uploaded inputs, including uploaded summaries.
- “Before summaries it should check that all files opened are for similar topics or not and warns if anything on different topics than majority one.”
- “The summarised file can be converted to power point presentation” from the merged result, after user affirmation.
- The batch is limited to five source items; support PDF, plain text, Markdown, pasted text, and normal public article pages. Do not add cloud-storage integrations.
- Users review image/table/chart findings and can toggle all or selected findings off.
- No sign-in, no Supabase, no shared API key. Each user supplies their own provider key(s), may save them on their device for later use, and can switch among providers/models.
- iPhone Safari is the initial test target; GitHub is the intended source-control path. Do not use Lovable AI for summarization.

## Open
- Build a real mobile-first app that can be tested in Safari and structured for later packaging as Android AAB and iOS IPA; do not deliver only a static HTML mockup.
- Use no shared backend key. Keep each user's provider keys on the user's device and call supported AI providers directly where their API/browser capabilities permit. Make the storage choice appropriate to the web app now and document how device-secure storage differs in a future native wrapper. Clearly warn that local key storage is accessible to someone with access to that device/browser and that document content sent for summarization goes to the selected provider; do not imply this is strict on-device AI.
- Select and validate a practical set of named AI providers and model choices; explain provider-specific key creation, quotas/costs, CORS/API limitations, and required capabilities in the app. Never silently switch providers. If a provider cannot be called directly from Safari, explain the limitation and keep the design honest rather than introducing a shared secret.
- Implement client-side file/text/Markdown/PDF extraction and article URL intake with a pasted-text/downloaded-file fallback for pages that cannot be fetched from the browser. Do not promise unlimited file size/page count: show progress, cancellation, errors, and practical limitations.
- Make the 5% word-count target approximate, display measured input/output counts, preserve source references, and report when extraction of scans, images, tables, or charts is uncertain or unavailable.
- Build deduplication and topic comparison, review/toggle controls, local summary downloads, and a confirmation-gated local PowerPoint download. Persist no cloud history; user can clear device-stored keys and session data.
- Treat large-file performance and iPhone Safari compatibility as items to benchmark on actual devices, not guaranteed capabilities.

Build a real working app, not a clickable prototype; the user's requirements above define its scope. Before building, walk through each flow as its user would and design what the requirements leave out, including loading, empty, error, and recovery states. Keep the interface simple and mobile-first. Build what is feasible in the browser without a backend or shared secret; clearly mark any provider or packaging feature that depends on future configuration or testing.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/518ffc18-1e08-40c6-aa9c-f562a4a47176).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
