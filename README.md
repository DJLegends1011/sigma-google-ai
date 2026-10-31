# Google Gemini (AI Studio & Vertex AI) for Project Σ (`google-ai`)

> **Status:** `v1.0.0-beta`: beta release for testing.

Adds **two native connection kinds** for Google's Gemini `generateContent` API (`ctx.llm.registerAdapter`), modeled on the bundled Anthropic extension:

1. **Google AI Studio (Gemini API)** (`gemini`)
   - Default Base URL: `https://generativelanguage.googleapis.com/v1beta`
   - API Key field: your AI Studio key (`AIza…`), sent as `x-goog-api-key`.
2. **Google Vertex AI** (`vertex`). The API Key field accepts any of:
   - **Express-mode API key**: uses `https://aiplatform.googleapis.com/v1/publishers/google` and needs no project.
   - **OAuth access token** (`ya29.…`, e.g. from `gcloud auth print-access-token`): needs a project set in Settings > Extensions. Tokens expire after about an hour.
   - **Credentials JSON** pasted whole: a `service_account` key file, or `application_default_credentials.json` from `gcloud auth application-default login` (`authorized_user`). Access tokens are minted and refreshed automatically. The project comes from `project_id` / `quota_project_id` unless you set one in settings.
   - With a token or JSON, the endpoint is `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google` (no prefix for `global`). A custom Base URL ending in `/publishers/google` overrides this.

## Features

- **Thinking**: a connection's **Reasoning effort** turns on `thinkingConfig.includeThoughts`, and the thought summary streams into the **Thinking** fold. Gemini 2.x uses `thinkingBudget` (1024 / 8192 / 24576). Gemini 3+ uses `thinkingLevel`; Pro models get `high` for medium effort.
- **Vision**: a message's images are sent as `inlineData` parts.
- **Samplers**: temperature, top P, top K, max output tokens, stop sequences, presence and frequency penalties, seed, and JSON mode (`responseMimeType`).
- **Safety filters**: `OFF` by default. You can also pick `BLOCK_NONE` or Google's defaults. A blocked prompt shows as an error; a blocked reply ends with `content_filter`.
- **Conversation shaping**: leading system messages become `systemInstruction`, and consecutive same-role turns are merged. The conversation always starts and ends on a user turn. For Gemma, the system prompt goes at the top of the first user turn, because Gemma has no system instruction.
- **Model list**: AI Studio uses the live `/models` list, keeping only models that support `generateContent`. Vertex combines a built-in Gemini catalog with the publisher model list where a token can read it. **Test connection** still checks the key or token.

## Installation

1. In **Settings > Extensions**, upload `google-ai.zip`, or copy the folder to `extensions/installed/google-ai/`.
2. Restart the Project Σ server and switch **Google Gemini (AI Studio & Vertex AI)** on.
3. In **Settings > AI**, add a connection of kind **Google AI Studio (Gemini API)** or **Google Vertex AI**.
