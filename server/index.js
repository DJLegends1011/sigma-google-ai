// Google Gemini, the server half: the generateContent API as two kinds of connection, translated to
// and from the app's neutral vocabulary:
//   1. "gemini" -> Google AI Studio (https://generativelanguage.googleapis.com/v1beta), an AI Studio API key
//   2. "vertex" -> Google Vertex AI (aiplatform.googleapis.com), an express-mode API key, an OAuth access
//      token (ya29.), or a pasted service-account / gcloud application-default credentials JSON

import { createSign } from 'node:crypto';

const STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// express mode: an API key and no project
const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1/publishers/google';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
// current models refuse a prefill-only conversation, so it opens and ends on the user's turn
const OPENING = '(The conversation begins.)';
const CLOSING = '(The conversation continues.)';
// why the model stopped, in the app's words
const FINISH = {
    STOP: 'stop', MAX_TOKENS: 'length',
    SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter', IMAGE_SAFETY: 'content_filter',
};
const HARM_CATEGORIES = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'];
// Gemini 2.x thinks to a token budget; later models to a named level
const BUDGET = { low: 1024, medium: 8192, high: 24576 };
const BUDGETED = /^gemini-2\./;
// Gemma takes no system instruction, so its system prompt opens the first user turn instead
const NO_SYSTEM = /^gemma-/;
// Vertex has no model list an express-mode key can read, so this is offered when its list is out of reach
const VERTEX_CATALOG = [
    { id: 'gemini-3-pro-preview', contextLength: 1048576, vision: true },
    { id: 'gemini-3-flash-preview', contextLength: 1048576, vision: true },
    { id: 'gemini-2.5-pro', contextLength: 1048576, vision: true },
    { id: 'gemini-2.5-flash', contextLength: 1048576, vision: true },
    { id: 'gemini-2.5-flash-lite', contextLength: 1048576, vision: true },
    { id: 'gemini-2.0-flash', contextLength: 1048576, vision: true },
    { id: 'gemini-2.0-flash-lite', contextLength: 1048576, vision: true },
];
const DEFAULTS = { safety: 'off', vertexProject: '', vertexLocation: 'global' };

export function register(router, ctx) {
    const { LlmError, classifyUpstream, boundedErrorText, networkError, readJsonBody, parseSse, translateParams } = ctx.llm.kit;

    // the adapter is handed no db, so the account's settings are read from the last request's
    const dbByProfile = new Map();
    let lastDb = null;
    ctx.hooks.add('llm.request', (req, facts) => {
        if (facts?.db) {
            lastDb = facts.db;
            if (facts.profileId) dbByProfile.set(facts.profileId, facts.db);
        }
        return req;
    });

    function accountSettings(profile) {
        const db = (profile?.id && dbByProfile.get(profile.id)) || lastDb;
        if (!db) return { ...DEFAULTS };
        try {
            return {
                safety: String(ctx.setting(db, 'safety') || DEFAULTS.safety),
                vertexProject: String(ctx.setting(db, 'vertexProject') || '').trim(),
                vertexLocation: String(ctx.setting(db, 'vertexLocation') || '').trim() || DEFAULTS.vertexLocation,
            };
        } catch {
            return { ...DEFAULTS };
        }
    }

    const modelId = (model) => String(model || '').trim().replace(/^(?:publishers\/google\/)?models\//, '');

    function paramsFor(model) {
        const flash = /flash/.test(model);
        return {
            temperature: 'temperature',
            topP: 'topP',
            topK: 'topK',
            maxTokens: 'maxOutputTokens',
            stop: 'stopSequences',
            presencePenalty: 'presencePenalty',
            frequencyPenalty: 'frequencyPenalty',
            seed: 'seed',
            json: (on, gc) => { if (on) gc.responseMimeType = 'application/json'; },
            // the thought summary is what the app keeps as the reply's reasoning
            reasoning: (r, gc) => {
                if (NO_SYSTEM.test(model)) return;
                const effort = BUDGET[r?.effort] ? r.effort : 'medium';
                gc.thinkingConfig = BUDGETED.test(model)
                    ? { includeThoughts: true, thinkingBudget: BUDGET[effort] }
                    // Pro models know only low and high
                    : { includeThoughts: true, thinkingLevel: effort === 'medium' && !flash ? 'high' : effort };
            },
        };
    }

    const textOf = (content) => (typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('') : '');

    // a turn's images go ahead of its text
    const partsOf = (images, text) => [
        ...images.map(i => ({ inlineData: { mimeType: i.mediaType, data: i.data } })),
        ...(text.trim() ? [{ text }] : []),
    ];

    // leading system messages are the system instruction, later ones user turns; empty ones go, and
    // turns of one role in a row become one
    function toContents(list, model) {
        const system = [];
        const contents = [];
        for (const m of Array.isArray(list) ? list : []) {
            const text = textOf(m?.content);
            const images = Array.isArray(m?.images) ? m.images : [];
            if (!text.trim() && !images.length) continue;
            if (m.role === 'system' && !contents.length) { system.push(text); continue; }
            const role = m.role === 'assistant' ? 'model' : 'user';
            const parts = partsOf(images, text);
            if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
            else contents.push({ role, parts });
        }
        if (!contents.length && system.length) contents.push({ role: 'user', parts: [{ text: system.pop() }] });
        if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: OPENING }] });
        if (contents.at(-1)?.role === 'model') contents.push({ role: 'user', parts: [{ text: CLOSING }] });
        const instruction = system.join('\n\n');
        if (instruction && NO_SYSTEM.test(model)) {
            contents[0].parts.unshift({ text: `${instruction}\n\n` });
            return { contents };
        }
        return { contents, ...(instruction ? { systemInstruction: { parts: [{ text: instruction }] } } : {}) };
    }

    function buildBody(profile, req, model) {
        const body = toContents(req.messages, model);
        const gc = translateParams(req.params || {}, paramsFor(model), {}, { debug: req.debug });
        if (Object.keys(gc).length) body.generationConfig = gc;
        const { safety } = accountSettings(profile);
        if (safety === 'off' || safety === 'none') {
            const threshold = safety === 'off' ? 'OFF' : 'BLOCK_NONE';
            body.safetySettings = HARM_CATEGORIES.map(category => ({ category, threshold }));
        }
        return body;
    }

    async function send(url, init, signal) {
        let resp;
        try {
            resp = await fetch(url, { ...init, signal });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            throw networkError(err);
        }
        if (!resp.ok) throw classifyUpstream(resp, await boundedErrorText(resp));
        return resp;
    }

    // ---- Vertex credentials ----

    // minted tokens by the credential they came from, each until a minute before it lapses
    const tokens = new Map();

    function serviceAccountAssertion(sa) {
        const now = Math.floor(Date.now() / 1000);
        const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL, iat: now, exp: now + 3600 })}`;
        const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
        return `${unsigned}.${signature}`;
    }

    async function mintToken(cred, signal) {
        const cacheKey = cred.client_email || cred.refresh_token;
        const cached = tokens.get(cacheKey);
        if (cached && cached.expires > Date.now()) return cached.token;
        let form;
        if (cred.type === 'service_account') {
            if (!cred.client_email || !cred.private_key) throw new LlmError('auth', 'the service-account JSON has no client_email or private_key');
            let assertion;
            try { assertion = serviceAccountAssertion(cred); } catch (err) { throw new LlmError('auth', `the service-account private key could not sign: ${err.message}`); }
            form = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion };
        } else if (cred.type === 'authorized_user') {
            if (!cred.client_id || !cred.client_secret || !cred.refresh_token) throw new LlmError('auth', 'the credentials JSON has no client_id, client_secret or refresh_token');
            form = { grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token };
        } else {
            throw new LlmError('auth', `credentials of type "${cred.type}" are not supported; paste a service_account or authorized_user JSON`);
        }
        const resp = await send(cred.type === 'service_account' && cred.token_uri ? cred.token_uri : TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        }, signal);
        const data = await readJsonBody(resp, signal);
        if (!data?.access_token) throw new LlmError('auth', 'Google answered no access token');
        const lifetime = Number.isFinite(data.expires_in) ? data.expires_in : 3600;
        tokens.set(cacheKey, { token: data.access_token, expires: Date.now() + (lifetime - 60) * 1000 });
        return data.access_token;
    }

    // what a Vertex connection's key field holds: an API key, an access token, or a credentials JSON
    async function vertexAuth(profile, signal) {
        const raw = String(profile.api_key || '').trim();
        if (!raw) throw new LlmError('auth', 'a Vertex AI connection needs an API key, an access token or a credentials JSON in its API Key field');
        if (raw.startsWith('{')) {
            let cred;
            try { cred = JSON.parse(raw); } catch { throw new LlmError('auth', 'the API Key field starts like JSON but does not parse'); }
            const token = await mintToken(cred, signal);
            const project = cred.project_id || cred.quota_project_id || '';
            // a user's own credentials bill to a quota project, which the request names
            return { token, project, userProject: cred.type === 'authorized_user' ? project : '' };
        }
        if (/^ya29\./.test(raw)) return { token: raw, project: '' };
        return { key: raw };
    }

    function vertexBase(profile, auth) {
        const raw = String(profile.base_url || '').trim().replace(/\/+$/, '');
        if (raw && raw !== VERTEX_BASE) return raw;
        if (auth.key) return VERTEX_BASE;
        const settings = accountSettings(profile);
        const project = settings.vertexProject || auth.project;
        if (!project) throw new LlmError('bad_request', 'Vertex AI with an access token needs a project: set one in Settings > Extensions > Google Gemini, or a Base URL naming it');
        const location = settings.vertexLocation;
        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google`;
    }

    // ---- the two kinds' endpoints ----

    const studio = {
        async endpoint(profile, path) {
            const base = String(profile.base_url || STUDIO_BASE).trim().replace(/\/+$/, '');
            const headers = { 'content-type': 'application/json', ...(profile.api_key ? { 'x-goog-api-key': String(profile.api_key).trim() } : {}) };
            return { url: `${base}${path}`, headers };
        },
    };

    const vertex = {
        async endpoint(profile, path, signal) {
            const auth = await vertexAuth(profile, signal);
            const base = vertexBase(profile, auth);
            const headers = { 'content-type': 'application/json' };
            let url = `${base}${path}`;
            if (auth.key) url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(auth.key)}`;
            else headers.authorization = `Bearer ${auth.token}`;
            if (auth.userProject) headers['x-goog-user-project'] = auth.userProject;
            return { url, headers, auth };
        },
    };

    // ---- replies ----

    const usageOf = (u) => {
        const prompt = u.promptTokenCount || 0;
        const completion = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u.totalTokenCount || prompt + completion };
    };
    const finishOf = (reason) => (reason ? FINISH[reason] || String(reason).toLowerCase() : null);
    const blocked = (data) => {
        const reason = data?.promptFeedback?.blockReason;
        return reason && !data?.candidates?.length ? new LlmError('bad_request', `Gemini blocked the prompt (${reason})`) : null;
    };
    // a mid-stream error carries its HTTP status as its code
    const streamError = (data) => classifyUpstream({ status: Number(data?.error?.code) || 0 }, JSON.stringify(data));

    function split(parts) {
        let text = '';
        let reasoning = '';
        for (const p of Array.isArray(parts) ? parts : []) {
            if (typeof p?.text !== 'string') continue;
            if (p.thought) reasoning += p.text; else text += p.text;
        }
        return { text, reasoning };
    }

    function makeAdapter(kind, displayName, defaultBaseUrl, door) {
        const prepare = async (profile, req, path, signal) => {
            const model = modelId(req.model || profile.model);
            if (!model) throw new LlmError('bad_request', 'the connection names no model');
            const { url, headers } = await door.endpoint(profile, `/models/${encodeURIComponent(model)}${path}`, signal);
            return { url, headers, body: JSON.stringify(buildBody(profile, req, model)) };
        };

        return {
            kind,
            displayName,
            defaultBaseUrl,
            requiresBaseUrl: false,
            capabilities: { streaming: true, json: true, reasoning: true, vision: true },
            paramTable: paramsFor(''),

            async chat(profile, req, signal) {
                const { url, headers, body } = await prepare(profile, req, ':generateContent', signal);
                const resp = await send(url, { method: 'POST', headers, body }, signal);
                const data = await readJsonBody(resp, signal);
                const refusal = blocked(data);
                if (refusal) throw refusal;
                if (!Array.isArray(data?.candidates)) throw new LlmError('upstream', 'unrecognized response shape');
                const candidate = data.candidates[0] || {};
                const { text, reasoning } = split(candidate.content?.parts);
                return {
                    content: text,
                    ...(reasoning ? { reasoning } : {}),
                    finishReason: finishOf(candidate.finishReason),
                    ...(data.usageMetadata ? { usage: usageOf(data.usageMetadata) } : {}),
                };
            },

            async *chatStream(profile, req, signal) {
                const { url, headers, body } = await prepare(profile, req, ':streamGenerateContent?alt=sse', signal);
                const resp = await send(url, { method: 'POST', headers, body }, signal);
                let finishReason = null;
                let usage = null;
                let read = false;
                for await (const frame of parseSse(resp.body, signal)) {
                    let data;
                    try { data = JSON.parse(frame.data); } catch { continue; }
                    read = true;
                    if (data?.error) throw streamError(data);
                    const refusal = blocked(data);
                    if (refusal) throw refusal;
                    const candidate = data?.candidates?.[0];
                    const { text, reasoning } = split(candidate?.content?.parts);
                    if (reasoning) yield { reasoning };
                    if (text) yield { text };
                    if (candidate?.finishReason) finishReason = finishOf(candidate.finishReason);
                    // each frame's usage is the running total
                    if (data?.usageMetadata) usage = usageOf(data.usageMetadata);
                }
                // the stream just closes when it is done, and its last frame names why
                if (!read) throw new LlmError('upstream', 'unrecognized response shape');
                if (!finishReason) throw new LlmError('network', 'the reply stream ended before the endpoint finished the reply', { retryable: true });
                yield { done: { finishReason, ...(usage ? { usage } : {}) } };
            },

            listModels: (profile, signal) => door.listModels(profile, signal),
        };
    }

    studio.listModels = async (profile, signal) => {
        const out = [];
        let pageToken = '';
        do {
            const { url, headers } = await studio.endpoint(profile, `/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
            const resp = await send(url, { method: 'GET', headers }, signal);
            const data = await readJsonBody(resp, signal);
            if (!Array.isArray(data?.models)) throw new LlmError('upstream', 'unrecognized response shape');
            for (const m of data.models) {
                if (!m?.supportedGenerationMethods?.includes('generateContent')) continue;
                const id = modelId(m.name);
                if (!id) continue;
                out.push({
                    id,
                    ...(Number.isFinite(m.inputTokenLimit) && m.inputTokenLimit > 0 ? { contextLength: m.inputTokenLimit } : {}),
                    // every Gemini model reads pictures; the list does not say so of the rest
                    ...(/^gemini-/.test(id) ? { vision: true } : {}),
                });
            }
            pageToken = data.nextPageToken || '';
        } while (pageToken && !signal?.aborted);
        return out.sort((a, b) => a.id.localeCompare(b.id));
    };

    vertex.listModels = async (profile, signal) => {
        // reaching the token endpoint (or not) is what tests a credentials JSON
        const { headers, auth } = await vertex.endpoint(profile, '', signal);
        const ids = new Map(VERTEX_CATALOG.map(m => [m.id, m]));
        // the publisher list wants an access token and lives on v1beta1; an express key checks itself
        // with a tiny count instead
        try {
            if (auth.key) {
                const { url, headers: h } = await vertex.endpoint(profile, '/models/gemini-2.5-flash:countTokens', signal);
                await send(url, { method: 'POST', headers: h, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) }, signal);
            } else {
                const resp = await send('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=200&listAllVersions=false', { method: 'GET', headers }, signal);
                const data = await readJsonBody(resp, signal);
                for (const m of Array.isArray(data?.publisherModels) ? data.publisherModels : []) {
                    const id = modelId(String(m?.name || '').replace(/^publishers\/google\//, ''));
                    if (/^gemini-/.test(id) && !ids.has(id)) ids.set(id, { id, vision: true });
                }
            }
        } catch (err) {
            // a wrong key or token is worth saying; a list Vertex will not hand out is not
            if (err?.name === 'AbortError' || err?.kind === 'auth' || err?.status === 401 || err?.status === 403) throw err;
        }
        return [...ids.values()].sort((a, b) => a.id.localeCompare(b.id));
    };

    ctx.llm.registerAdapter(makeAdapter('gemini', 'Google AI Studio (Gemini API)', STUDIO_BASE, studio));
    ctx.llm.registerAdapter(makeAdapter('vertex', 'Google Vertex AI', VERTEX_BASE, vertex));
}
