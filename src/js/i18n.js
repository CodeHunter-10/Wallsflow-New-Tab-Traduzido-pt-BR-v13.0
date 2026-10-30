(function() {
    'use strict';

    // ==============================
    // TRANSLATIONS
    // ==============================
    // Every string a user reads comes from _locales/<language>/messages.json,
    // the format the Web Store already needs for the extension's own name.
    // This file picks the language, translates the marked-up page before it is
    // shown, and gives the other scripts t() for whatever they draw later.
    //
    // Which language:
    // - Until someone picks one, the first language in the browser's preferred
    //   list that the extension ships. That is the list every website sees
    //   (chrome://settings/languages), not the language of Chrome's own menus:
    //   plenty of people run Chrome's menus in English and still put their own
    //   language first, and chrome.i18n only knows the menus.
    // - A language picked in Settings, stored until they pick again.
    //
    // Where its messages come from:
    // - chrome.i18n, when it already serves that language. Synchronous, free,
    //   and Chrome falls back from a region to its language and then to English.
    // - Otherwise a pack: that language's catalogues merged over English and
    //   kept in localStorage, which every later tab reads synchronously. The
    //   first tab that needs a pack reads the catalogues synchronously from the
    //   extension's own files, once, so the page is never shown in English first.
    //
    // It depends on no other script, so whats-new.html and popup.html load it
    // on its own.

    const UI_LANGUAGE_KEY = 'wf_ui_language';
    const UI_LANGUAGE_PACK_KEY = 'wf_ui_language_pack';

    // Where this script was loaded from, so the catalogues can still be found
    // when a page is opened outside the extension, on a local preview server.
    const SCRIPT_BASE = (() => {
        try { return (document.currentScript && document.currentScript.src) || ''; } catch (_) { return ''; }
    })();

    // A language joins this list only once every message is translated. The
    // catalogue test keeps this list and the _locales folders in step.
    const WF_SUPPORTED_LOCALES = Object.freeze([
        Object.freeze({ code: 'en', folder: 'en', native: 'English' }),
        Object.freeze({ code: 'de', folder: 'de', native: 'Deutsch' }),
        Object.freeze({ code: 'fr', folder: 'fr', native: 'Français' }),
        Object.freeze({ code: 'es', folder: 'es', native: 'Español' }),
        Object.freeze({ code: 'ro', folder: 'ro', native: 'Română' }),
        Object.freeze({ code: 'pt-BR', folder: 'pt_BR', native: 'Português (Brasil)' }),
    ]);

    const ALLOWED_TAGS = new Set(['b', 'strong', 'em', 'br']);
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    // ------------------------------
    // The browser
    // ------------------------------

    function readStorage(key) {
        try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }

    function writeStorage(key, value) {
        try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
    }

    function removeStorage(key) {
        try { window.localStorage.removeItem(key); } catch (_) { /* nothing to remove */ }
    }

    function i18nApi() {
        try {
            if (typeof chrome !== 'undefined' && chrome && chrome.i18n && typeof chrome.i18n.getMessage === 'function') return chrome.i18n;
            if (typeof browser !== 'undefined' && browser && browser.i18n && typeof browser.i18n.getMessage === 'function') return browser.i18n;
        } catch (_) { /* no extension API, as on a plain web page */ }
        return null;
    }

    function manifestVersion() {
        try { return String(chrome.runtime.getManifest().version || ''); } catch (_) { return ''; }
    }

    // The browser's preferred languages, most wanted first. Chrome's menu
    // language only stands in when a browser reports no list at all.
    function preferredLanguages() {
        try {
            if (typeof navigator !== 'undefined' && navigator) {
                if (Array.isArray(navigator.languages) && navigator.languages.length) return Array.from(navigator.languages);
                if (navigator.languages && typeof navigator.languages.length === 'number' && navigator.languages.length) return Array.from(navigator.languages);
                if (navigator.language) return [navigator.language];
            }
        } catch (_) { /* fall through to Chrome's menu language */ }
        try {
            const api = i18nApi();
            const ui = api && typeof api.getUILanguage === 'function' ? api.getUILanguage() : '';
            return ui ? [ui] : [];
        } catch (_) {
            return [];
        }
    }

    function catalogUrl(folder) {
        try {
            if (typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
                return chrome.runtime.getURL(`_locales/${folder}/messages.json`);
            }
        } catch (_) { /* not inside the extension */ }
        return new URL(`../../_locales/${folder}/messages.json`, SCRIPT_BASE || location.href).href;
    }

    // ------------------------------
    // Pure pieces, exported for the tests
    // ------------------------------

    // The first preferred language the extension ships, with the tag it came
    // from ("en-GB" keeps British dates). A language that is not shipped is
    // passed over for the next one, so Russian then Romanian gets Romanian.
    function detectLanguage(preferred, supported) {
        const codes = supported.map((locale) => locale.code);
        for (const raw of preferred || []) {
            const tag = String(raw || '').trim().replace(/_/g, '-');
            if (!tag) continue;
            const exact = codes.find((code) => code.toLowerCase() === tag.toLowerCase());
            if (exact) return { code: exact, tag };
            const base = tag.split('-')[0].toLowerCase();
            const byBase = codes.find((code) => code.toLowerCase() === base);
            if (byBase) return { code: byBase, tag };
        }
        return null;
    }

    // Which language a page uses, how it got there, and where its messages
    // come from: 'chrome' (chrome.i18n already serves it), 'pack' (a stored
    // pack for it) or 'build' (a pack has to be made first).
    function resolveLanguage({ setting, pack, preferred, localeCode, supported, version }) {
        const codes = supported.map((locale) => locale.code);
        const chromeLang = codes.includes(localeCode) ? localeCode : 'en';
        const detected = detectLanguage(preferred, supported);
        const autoLang = detected ? detected.code : chromeLang;
        const usable = (code) => Boolean(pack && pack.code === code && pack.m && typeof pack.m === 'object');
        const picked = setting && setting !== 'auto' && codes.includes(setting) ? setting : '';

        const lang = picked || autoLang;
        const mode = picked ? 'manual' : 'auto';
        const tag = picked ? picked : (detected ? detected.tag : '');
        if (lang === chromeLang) return { lang, mode, source: 'chrome', stale: false, autoLang, tag };
        if (usable(lang)) return { lang, mode, source: 'pack', stale: pack.v !== version, autoLang, tag };
        return { lang, mode, source: 'build', stale: false, autoLang, tag };
    }

    // The folders a language is built from, in the order they override each
    // other: English, then the language, then its region.
    function folderChain(code) {
        const chain = ['en'];
        const [base] = String(code).split('-');
        if (base && base !== 'en') chain.push(base);
        if (String(code).includes('-')) chain.push(String(code).replace('-', '_'));
        return chain;
    }

    function buildPack(code, version, catalogs) {
        const m = {};
        for (const catalog of catalogs) {
            if (!catalog || typeof catalog !== 'object') continue;
            for (const [name, entry] of Object.entries(catalog)) {
                if (entry && typeof entry.message === 'string') m[name.toLowerCase()] = entry.message;
            }
        }
        return { v: version, code, m };
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function decodeEntities(value) {
        return value.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39|nbsp);/gi, (whole, entity) => {
            const lower = entity.toLowerCase();
            if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
            if (lower.startsWith('#') && lower !== '#39') return String.fromCodePoint(Number(lower.slice(1)));
            return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[lower] || whole;
        });
    }

    // Builds nodes from a translated message that may carry <b>, <strong>,
    // <em> and <br>. Anything else that looks like a tag stays visible as text:
    // a translation can never inject markup.
    function appendMarkup(doc, parent, markup) {
        const stack = [parent];
        const top = () => stack[stack.length - 1];
        const pushText = (text) => {
            if (text) top().appendChild(doc.createTextNode(decodeEntities(text)));
        };
        const re = /<(\/?)([a-z]+)\s*\/?>/gi;
        let last = 0;
        let match;
        while ((match = re.exec(markup))) {
            const tag = match[2].toLowerCase();
            if (!ALLOWED_TAGS.has(tag)) continue;
            pushText(markup.slice(last, match.index));
            last = re.lastIndex;
            if (tag === 'br') {
                if (!match[1]) top().appendChild(doc.createElement('br'));
            } else if (match[1]) {
                if (stack.length > 1 && String(top().tagName).toLowerCase() === tag) stack.pop();
            } else {
                const element = doc.createElement(tag);
                top().appendChild(element);
                stack.push(element);
            }
        }
        pushText(markup.slice(last));
    }

    // t() and tHtml() over any lookup, so the tests can drive plural rules for
    // languages that are not shipped yet.
    function createTranslator({ getLang, lookup, numberLocales, onMissing, doc }) {
        function pluralName(name, count) {
            let category = 'other';
            try { category = new Intl.PluralRules(getLang()).select(count); } catch (_) { /* keep other */ }
            const exact = `${name}_${category}`;
            return lookup(exact) ? exact : `${name}_other`;
        }

        function format(message, params) {
            if (!params) return message;
            return message.replace(/\{(\w+)\}/g, (whole, name) => {
                if (!hasOwn(params, name)) return whole;
                const value = params[name];
                if (typeof value === 'number') {
                    try { return new Intl.NumberFormat(numberLocales()).format(value); } catch (_) { return String(value); }
                }
                return String(value);
            });
        }

        function t(key, params) {
            let name = String(key);
            if (params && typeof params.count === 'number') name = pluralName(name, params.count);
            const message = lookup(name);
            if (!message) {
                onMissing(name);
                return name;
            }
            return format(message, params);
        }

        function tHtml(key, params) {
            const document = doc();
            const fragment = document.createDocumentFragment();
            if (!/_html$/.test(String(key))) {
                fragment.appendChild(document.createTextNode(t(key, params)));
                return fragment;
            }
            let safe = params;
            if (params) {
                safe = {};
                for (const [name, value] of Object.entries(params)) {
                    safe[name] = typeof value === 'number' ? value : escapeHtml(value);
                }
            }
            appendMarkup(document, fragment, t(key, safe));
            return fragment;
        }

        return { t, tHtml };
    }

    // ------------------------------
    // This page
    // ------------------------------

    const state = { lang: 'en', mode: 'auto', pack: null, autoLang: 'en', tag: '', preferred: [] };
    const cache = new Map();
    const warned = new Set();

    function lookup(name) {
        const key = name.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let message = '';
        if (state.pack && hasOwn(state.pack.m, key)) {
            message = String(state.pack.m[key]);
        } else {
            const api = i18nApi();
            try { message = api ? api.getMessage(key) || '' : ''; } catch (_) { message = ''; }
        }
        cache.set(key, message);
        return message;
    }

    // Dates and numbers in the interface's language. A detected language keeps
    // the tag it came from, so "en-GB" still writes 13 September.
    function intlLocales() {
        return state.tag ? [state.tag] : [];
    }

    // The base language for services that take one, like the city search. A
    // picked language wins; otherwise the browser's first choice, even one the
    // interface is not translated into, because city names exist in far more
    // languages than the extension does.
    function geoLanguage() {
        const code = state.mode === 'manual' ? state.lang : (state.preferred[0] || state.lang);
        return String(code || 'en').split(/[-_]/)[0].toLowerCase() || 'en';
    }

    const translator = createTranslator({
        getLang: () => state.lang,
        lookup,
        numberLocales: intlLocales,
        onMissing: (name) => {
            if (warned.has(name)) return;
            warned.add(name);
            try { console.warn(`[i18n] no message named "${name}"`); } catch (_) { /* nowhere to warn */ }
        },
        doc: () => document,
    });
    const t = translator.t;
    const tHtml = translator.tHtml;

    // The English in the markup is identical to the English catalogue (a test
    // holds them together), so an English page has nothing to replace.
    function applyDom(root) {
        if (state.lang === 'en' && !state.pack) return 0;
        const scope = root || document;
        let count = 0;
        scope.querySelectorAll('[data-i18n]').forEach((element) => {
            element.textContent = t(element.getAttribute('data-i18n'));
            count += 1;
        });
        scope.querySelectorAll('[data-i18n-html]').forEach((element) => {
            element.replaceChildren(tHtml(element.getAttribute('data-i18n-html')));
            count += 1;
        });
        scope.querySelectorAll('[data-i18n-attr]').forEach((element) => {
            for (const pair of element.getAttribute('data-i18n-attr').split(';')) {
                const colon = pair.indexOf(':');
                if (colon < 1) continue;
                const attribute = pair.slice(0, colon).trim();
                const key = pair.slice(colon + 1).trim();
                if (attribute && key) element.setAttribute(attribute, t(key));
            }
            count += 1;
        });
        return count;
    }

    function readPack() {
        const raw = readStorage(UI_LANGUAGE_PACK_KEY);
        if (!raw) return null;
        try {
            const pack = JSON.parse(raw);
            return pack && typeof pack === 'object' && typeof pack.code === 'string' && pack.m && typeof pack.m === 'object' ? pack : null;
        } catch (_) {
            return null;
        }
    }

    // English and the language itself must load; a missing base folder for a
    // region is skipped. readFolder returns a catalogue or null.
    function collectCatalogs(code, readFolder) {
        const catalogs = [];
        const chain = folderChain(code);
        for (const folder of chain) {
            const catalog = readFolder(folder);
            const required = folder === 'en' || folder === chain[chain.length - 1];
            if (!catalog && required) return null;
            if (catalog) catalogs.push(catalog);
        }
        return catalogs;
    }

    async function fetchCatalog(folder) {
        const response = await fetch(catalogUrl(folder));
        if (!response || !response.ok) return null;
        return response.json();
    }

    // Builds and stores the pack for a language, in the background.
    async function preparePack(code) {
        if (!WF_SUPPORTED_LOCALES.some((locale) => locale.code === code)) return false;
        try {
            const loaded = {};
            for (const folder of folderChain(code)) {
                try { loaded[folder] = await fetchCatalog(folder); } catch (_) { loaded[folder] = null; }
            }
            const catalogs = collectCatalogs(code, (folder) => loaded[folder]);
            if (!catalogs) return false;
            return writeStorage(UI_LANGUAGE_PACK_KEY, JSON.stringify(buildPack(code, manifestVersion(), catalogs)));
        } catch (_) {
            return false;
        }
    }

    // The same pack, read synchronously from the extension's own files, for the
    // one tab that needs a language before any pack exists. The files are
    // local, so this is a few milliseconds, once. The pack serves this tab even
    // when storage refuses to keep it.
    function readCatalogSync(folder) {
        try {
            const request = new XMLHttpRequest();
            request.open('GET', catalogUrl(folder), false);
            request.send(null);
            if ((request.status !== 200 && request.status !== 0) || !request.responseText) return null;
            return JSON.parse(request.responseText);
        } catch (_) {
            return null;
        }
    }

    function buildPackNow(code, store = true) {
        try {
            const catalogs = collectCatalogs(code, readCatalogSync);
            if (!catalogs) return null;
            const pack = buildPack(code, manifestVersion(), catalogs);
            if (store) writeStorage(UI_LANGUAGE_PACK_KEY, JSON.stringify(pack));
            return pack;
        } catch (_) {
            return null;
        }
    }

    // 'auto' goes back to following the browser. The pack is written before
    // the setting, so no page ever sees a setting without the pack it needs.
    // The page reloads because some 850 strings have already been copied into
    // ten scripts' state; redrawing in place would miss some of them.
    async function setLanguage(code) {
        if (!code || code === 'auto') {
            removeStorage(UI_LANGUAGE_KEY);
            removeStorage(UI_LANGUAGE_PACK_KEY);
            location.reload();
            return true;
        }
        if (!(await preparePack(code))) return false;
        if (!writeStorage(UI_LANGUAGE_KEY, code)) {
            removeStorage(UI_LANGUAGE_PACK_KEY);
            return false;
        }
        location.reload();
        return true;
    }

    function scheduleRefresh(code) {
        const run = () => { preparePack(code).catch(() => {}); };
        try {
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(run, { timeout: 5000 });
                return;
            }
        } catch (_) { /* fall through to a timer */ }
        setTimeout(run, 2000);
    }

    function init() {
        // Opened outside the extension there is no chrome.i18n to ask, and the
        // scripts would show message names. Read English from the catalogue
        // beside this script instead, for this page only. A file:// page cannot
        // read files at all and keeps the English written into its markup.
        if (!i18nApi()) {
            state.preferred = preferredLanguages();
            state.pack = buildPackNow('en', false);
            return;
        }

        const setting = readStorage(UI_LANGUAGE_KEY);
        let localeCode = '';
        try {
            const api = i18nApi();
            localeCode = api ? api.getMessage('locale_code') : '';
        } catch (_) { localeCode = ''; }

        state.preferred = preferredLanguages();
        const resolved = resolveLanguage({
            setting,
            pack: readPack(),
            preferred: state.preferred,
            localeCode,
            supported: WF_SUPPORTED_LOCALES,
            version: manifestVersion(),
        });
        state.lang = resolved.lang;
        state.mode = resolved.mode;
        state.autoLang = resolved.autoLang;
        state.tag = resolved.tag;

        if (resolved.source === 'pack') {
            state.pack = readPack();
            // An old pack still serves this tab; the next one gets a fresh pack.
            if (resolved.stale) scheduleRefresh(resolved.lang);
        } else if (resolved.source === 'build') {
            state.pack = buildPackNow(resolved.lang);
            if (!state.pack) {
                // The catalogues could not be read: show what Chrome serves
                // rather than message names, and try again in the background.
                state.lang = WF_SUPPORTED_LOCALES.some((locale) => locale.code === localeCode) ? localeCode : 'en';
                state.tag = '';
                scheduleRefresh(resolved.lang);
            }
        }
    }

    function reveal() {
        try {
            const root = document.documentElement;
            if (root) {
                root.setAttribute('lang', state.lang);
                root.classList.remove('i18n-pending');
            }
        } catch (_) { /* the stylesheet's failsafe shows the page */ }
        try {
            if (typeof performance !== 'undefined' && performance && typeof performance.mark === 'function') {
                performance.mark('wf-i18n-applied');
            }
        } catch (_) { /* timing is a nicety */ }
    }

    window.wfI18n = Object.freeze({
        get lang() { return state.lang; },
        get mode() { return state.mode; },
        get autoLang() { return state.autoLang; },
        supported: WF_SUPPORTED_LOCALES,
        t,
        tHtml,
        intlLocales,
        geoLanguage,
        applyDom,
        setLanguage,
        preparePack,
        detectLanguage,
        resolveLanguage,
        buildPack,
        folderChain,
        createTranslator,
    });
    window.t = t;
    window.tHtml = tHtml;

    try {
        init();
    } catch (_) {
        state.lang = 'en';
        state.mode = 'auto';
        state.pack = null;
        state.tag = '';
    }
    try {
        applyDom(document);
    } catch (err) {
        try { console.warn('[i18n] the page could not be translated', err); } catch (_) { /* nowhere to warn */ }
    } finally {
        reveal();
    }
})();
