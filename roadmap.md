# Roadmap

## Done
- [x] Up to 5 sources: PDF, Word (.docx), text, Markdown, pasted text, article link (with paste fallback and opt-in reader service)
- [x] On-device summarizer (no key): TextRank + MMR de-duplication, per-source balance, theme grouping, [n] citations
- [x] AI providers (bring your own key): Gemini, OpenAI, Anthropic, OpenRouter, Groq; key auto-detection, verification, per-provider model lists only
- [x] Long documents: split → condense → merge, retries on rate limits, one length-correction pass
- [x] Topic check (TF-IDF), visual findings (captions, tables, PDF embedded images) with per-item toggles
- [x] Summary length slider (default 5%), measured input/output counts
- [x] Theme changer: light/dark/auto + 6 colour palettes; tap-friendly help popovers
- [x] Downloads: Markdown, text, confirmation-gated PowerPoint (+ iOS share sheet)

## Next
- [ ] Test on real iPhone Safari (file picker, PDF speed, PowerPoint download / Save to Files)
- [ ] OCR for scanned PDFs
- [ ] Optional in-browser AI model (WebGPU) for fluent summaries without a key
- [ ] Secure key storage in a native wrapper (Keychain / Keystore) for AAB / IPA packaging
