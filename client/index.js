// Google Gemini client half: safety filters and the Vertex project / location in Settings > Extensions.

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default {
    init(ctx) {
        ctx.ui.addSettingsSection((el) => {
            const safety = String(ctx.settings.get('safety') || 'off');
            const braille = String(ctx.settings.get('brailleSpaces') || 'argon');
            const project = String(ctx.settings.get('vertexProject') || '');
            const location = String(ctx.settings.get('vertexLocation') || 'global');

            el.innerHTML = `
                <div class="settings-row">
                    <label for="gai-safety">Safety filters</label>
                    <select id="gai-safety" class="glass-input" data-gai-set="safety">
                        <option value="off"${safety === 'off' ? ' selected' : ''}>Off (threshold OFF)</option>
                        <option value="none"${safety === 'none' ? ' selected' : ''}>Block none (threshold BLOCK_NONE)</option>
                        <option value="default"${safety === 'default' ? ' selected' : ''}>Google's defaults (send no safety settings)</option>
                    </select>
                    <span class="settings-hint">Harassment, hate speech, sexually explicit and dangerous content. A blocked reply ends with the <code>content_filter</code> reason.</span>
                </div>
                <div class="settings-row">
                    <label for="gai-braille">Braille JB whitespace (<code>U+2800</code> → space)</label>
                    <select id="gai-braille" class="glass-input" data-gai-set="brailleSpaces">
                        <option value="argon"${braille === 'argon' ? ' selected' : ''}>Argon &amp; Gemini 3+ models only</option>
                        <option value="all"${braille === 'all' ? ' selected' : ''}>All Gemini models</option>
                        <option value="off"${braille === 'off' ? ' selected' : ''}>Off (keep raw U+2800)</option>
                    </select>
                    <span class="settings-hint">Converts Braille blank spaces (<code>⠀</code>) from ShieldGemma / Braille JB prompts back into normal spaces as replies arrive, so word-wrapping and keyword triggers work normally.</span>
                </div>
                <div class="settings-row">
                    <label for="gai-project">Vertex AI project ID</label>
                    <input id="gai-project" class="glass-input" type="text" placeholder="my-gcp-project" value="${esc(project)}" data-gai-set="vertexProject">
                    <span class="settings-hint" style="overflow-wrap:anywhere;">Used with an access token or credentials JSON. Leave it blank to use the JSON's <code>project_id</code>. An express-mode API key needs no project.</span>
                </div>
                <div class="settings-row">
                    <label for="gai-location">Vertex AI location</label>
                    <input id="gai-location" class="glass-input" type="text" placeholder="global" value="${esc(location)}" data-gai-set="vertexLocation">
                    <span class="settings-hint" style="overflow-wrap:anywhere;"><code>global</code> serves the newest models. A region such as <code>us-central1</code> or <code>europe-west4</code> keeps data in that region.</span>
                </div>`;

            for (const input of el.querySelectorAll('[data-gai-set]')) {
                input.addEventListener('change', () => ctx.settings.set(input.dataset.gaiSet, input.value.trim()));
            }
        });
    },
};
