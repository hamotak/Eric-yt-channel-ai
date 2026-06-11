# 69labs API Notes

The user-provided API docs are saved here so future sessions do not need the
attachments again:

- `api-reference.txt` - external API reference pasted into Codex.
- `developer-guide.txt` - external API developer guide pasted into Codex.

Image Studio integration rules from these docs:

- Use only the public REST base URL: `https://69labs.vip/api/v1`.
- Keep the `vk_*` API key server-side.
- Image generation is asynchronous: `POST /images/generate`, poll
  `GET /images/status/:jobId`, then download with
  `GET /images/download/:jobId`.
- Poll image status every 3-5 seconds.
- Follow redirects when downloading generated images.
- Discover models and limits at runtime with `/models` or `/images/models`.
- For pay-per-use keys, model discovery can include `limits.maxConcurrentJobs`,
  `limits.activeJobs`, and `limits.remainingJobs`.
- Respect `Retry-After` on 429 responses.
- Treat the 69labs message `Concurrent image generation limit reached` as a
  temporary provider-capacity state, not as an auth/access failure.
