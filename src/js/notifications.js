// ==============================
// SAFE STORAGE HELPERS
// ==============================

function safeGet(key, fallback = null) {
    try { return localStorage.getItem(key); }
    catch { return fallback; }
}

// Returns false when the write did not happen (storage full or blocked).
// Most callers ignore that: a lost preference reappears as its default, which
// is annoying but honest. A caller that tells the user "Saved" has to check.
function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
}

// For a setting the user just changed: stores it, and if the browser refuses
// the write says so instead of letting the page claim "Saved". A slider fires
// many writes a second, so the warning shows at most once every few seconds.
let _saveWarnedAt = -Infinity;
function saveSetting(key, value) {
    if (safeSet(key, value)) return true;
    const now = Date.now();
    if (now - _saveWarnedAt > 4000 && typeof showPush === 'function') {
        _saveWarnedAt = now;
        showPush(t('common_save_failed_retry'), 'warning');
    }
    return false;
}

function safeRemove(key) {
    try { localStorage.removeItem(key); return true; }
    catch { return false; }
}

// ==============================
// SHARED HELPERS — escape + URL safety
// ==============================

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Returns the URL only if it parses as a safe http/https/data URL.
// Used before injecting into CSS url(...) to block javascript: and similar schemes.
function safeUrlForCss(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw, window.location.href);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:' || protocol === 'blob:') {
            return parsed.toString();
        }
    } catch (_) { /* malformed */ }
    return '';
}

// Resolve the user's preferred link-open mode for a given widget pair (default
// vs while-music-playing). Used by Shortcuts, Bookmarks and the Search Bar so
// the same logic doesn't drift across modules.
//   defaultKey: localStorage key that stores '_blank' | '_self' for normal use.
//   musicKey:   localStorage key that stores the override active while music plays.
// Returns '_blank' or '_self'. Defaults to '_blank' on missing/invalid values.
function resolveOpenMode(defaultKey, musicKey) {
    const dflt = safeGet(defaultKey);
    const music = safeGet(musicKey);
    const isMusicPlaying = !!document.querySelector('.music-widget-btn.playing');
    const value = isMusicPlaying ? music : dflt;
    return value === '_self' ? '_self' : '_blank';
}

// Single visibilitychange listener shared across all modules. Each module
// registers a callback via wfOnVisibilityChange(cb); the hub fans out a single
// `document.addEventListener('visibilitychange', ...)` to all of them.
// Saves 4 redundant DOM event listeners (clock, weather, video, pomodoro,
// music) and ensures consistent ordering of pause/resume actions.
const _visibilityCallbacks = new Set();
let _visibilityHubAttached = false;

function wfOnVisibilityChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _visibilityCallbacks.add(callback);
    if (!_visibilityHubAttached) {
        _visibilityHubAttached = true;
        document.addEventListener('visibilitychange', () => {
            const hidden = document.hidden;
            for (const cb of _visibilityCallbacks) {
                try { cb(hidden); } catch (_) { /* one bad callback shouldn't break the others */ }
            }
        });
    }
    // Return an unsubscribe handle for callers that want to detach later.
    return () => _visibilityCallbacks.delete(callback);
}

// Make the hub available to other modules via the global scope.
window.wfOnVisibilityChange = wfOnVisibilityChange;

// ==============================
// THE DETECTED CITY'S NAME
// ==============================
// The weather's automatic location comes from the timezone, and the timezone
// only knows the city's English name: "Europe/Bucharest" says Bucharest on a
// page in Romanian. The geocoder the city search already uses knows the name
// in every language, so it is asked once per timezone and language and the
// answer kept. Until it answers, or if it never does, the English name shows.
const WF_CITY_NAMES_KEY = 'wf_weather_city_names';

function wfDetectedTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
}

// "America/New_York" → "New York". Empty when there is no city in the zone,
// as in "UTC" or "Etc/GMT+2".
function wfDetectedCityEnglish() {
    const tz = wfDetectedTimezone();
    if (!tz.includes('/')) return '';
    return (tz.split('/').pop() || '').replace(/_/g, ' ');
}

function wfReadCityNames() {
    try {
        const parsed = JSON.parse(safeGet(WF_CITY_NAMES_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
}

function wfInterfaceLanguage() {
    return (window.wfI18n && wfI18n.lang) || 'en';
}

// The name to show right now: the stored name in the interface's language
// when there is one, otherwise the English one from the timezone.
function wfDetectedCityName() {
    const english = wfDetectedCityEnglish();
    const lang = wfInterfaceLanguage();
    if (!english || lang === 'en') return english;
    const stored = wfReadCityNames()[`${wfDetectedTimezone()}|${lang}`];
    return typeof stored === 'string' && stored ? stored : english;
}

// Looks the name up when it is not known yet. Resolves with the name once it
// is, and with null when there was nothing to do or the lookup failed. Callers
// that draw the city listen for 'wf:city-name' on the document instead of
// waiting on this, so every widget repaints from one answer.
let _cityLookup = null;
function wfLocalizeDetectedCity() {
    const english = wfDetectedCityEnglish();
    const lang = wfInterfaceLanguage();
    const tz = wfDetectedTimezone();
    if (!english || lang === 'en') return Promise.resolve(null);
    const key = `${tz}|${lang}`;
    if (wfReadCityNames()[key]) return Promise.resolve(null);
    if (_cityLookup) return _cityLookup;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(english)}&count=5&language=${encodeURIComponent(lang)}&format=json`;
    _cityLookup = fetch(url)
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
            const results = Array.isArray(data && data.results) ? data.results : [];
            // The geocoder returns several places called that; the one in
            // this timezone is the one the weather is for.
            const match = results.find((r) => r && r.timezone === tz) || results[0];
            const name = match && typeof match.name === 'string' ? match.name.trim() : '';
            if (!name) return null;
            const names = wfReadCityNames();
            names[key] = name;
            safeSet(WF_CITY_NAMES_KEY, JSON.stringify(names));
            try {
                document.dispatchEvent(new CustomEvent('wf:city-name', { detail: { name } }));
            } catch (_) { /* nothing listens on a page without CustomEvent */ }
            return name;
        })
        .catch(() => null)
        .finally(() => { _cityLookup = null; });
    return _cityLookup;
}

window.wfDetectedCityName = wfDetectedCityName;
window.wfLocalizeDetectedCity = wfLocalizeDetectedCity;

// ==============================
// STORAGE KEY REGISTRY
// ==============================
// Central catalog of every localStorage key the extension reads or writes.
// Two purposes: (1) single grep target — `STORAGE_KEYS\.` finds every key in
// use; (2) typo prevention for new code. Existing modules still use raw string
// literals or per-module const declarations; new code should prefer this map.
// Keys are grouped by feature; the value is the literal localStorage entry.
const STORAGE_KEYS = Object.freeze({
    // Music — playback state, metadata, ownership lock
    MUSIC_URL: 'wf_music_url',
    MUSIC_NAME: 'wf_music_name',
    MUSIC_POSITION: 'wf_music_position',
    MUSIC_ACTIVE_TAB_ID: 'wf_music_active_tab_id',
    MUSIC_HEARTBEAT: 'wf_music_heartbeat',
    MUSIC_TAB_ID: 'wf_music_tab_id', // sessionStorage, not localStorage
    MUSIC_WAS_PLAYING: 'wf_music_was_playing',
    MUSIC_SMART_RESUME: 'wf_music_smart_resume',
    MUSIC_DOCK_HINT_SEEN: 'wf_music_dock_hint_seen',
    MUSIC_OEMBED_CACHE: 'wf_oembed_cache_v1',
    MUSIC_SAVED_PLAYLISTS: 'wf_saved_playlists',
    MUSIC_AMBIENT_MUTED: 'wf_ambient_muted',
    MUSIC_AMBIENT_MIX_STATE: 'wf_ambient_mix_state',
    // YouTube bridge
    YT_BRIDGE_BASE: 'wf_youtube_bridge_base',
    YT_BRIDGE_VOLUME: 'wf_youtube_bridge_volume',
    YT_BRIDGE_MUTED: 'wf_youtube_bridge_muted',
    YT_LOOP: 'wf_youtube_loop',
    // Pomodoro
    POMO_STATE: 'wf_pomo_state',
    POMO_SESSIONS: 'wf_pomo_sessions',
    POMO_SESSIONS_DATE: 'wf_pomo_sessions_date',
    POMO_COMPLETED_AT: 'wf_pomo_completed_at', // end time of the last run counted, so two tabs count it once
    POMO_FOCUS_MIN: 'wf_pomo_focus_min',
    POMO_SHORT_MIN: 'wf_pomo_short_min',
    POMO_LONG_MIN: 'wf_pomo_long_min',
    POMO_AUTO_START: 'wf_pomo_auto_start',
    POMO_FOCUS_MODE: 'wf_pomo_focus_mode',
    POMO_FOCUS_TASKS: 'wf_pomo_focus_tasks',
    POMO_FOCUS_STREAMING_PENDING: 'wf_pomo_focus_streaming_pending',
    POMO_FOCUS_AMBIENT_MEMORY: 'wf_pomo_focus_ambient_memory',
    // Clock & greeting
    CLOCK_FORMAT: 'wf_clock_format',
    CLOCK_SECONDS: 'wf_clock_seconds',
    CLOCK_DATE: 'wf_clock_date',
    CLOCK_SIZE: 'wf_clock_size',
    DAILY_MESSAGE_NAME: 'dailyMessageName',
    // Weather
    WEATHER_HIDDEN: 'weatherHidden',
    WEATHER_CACHE: 'weatherCache',
    WEATHER_LOCATION: 'wf_weather_location',
    WEATHER_LOCATION_MODE: 'wf_weather_location_mode',
    WEATHER_SHOW_CITY: 'wf_weather_show_city',
    WEATHER_UNIT: 'wf_weather_unit', // 'metric' | 'imperial' — display only; data is cached in metric
    WEATHER_CITY_NAMES: 'wf_weather_city_names', // the detected city's name per timezone and language, looked up once
    // Shortcuts & favicons
    SHORTCUTS: 'shortcuts',
    FAVICON_CACHE: 'favicon_cache_v1',
    // Wallpaper
    VIDEO_PLAYBACK_ENABLED: 'videoPlaybackEnabled',
    WALLPAPER_SCHEDULE_HIDDEN: 'wallpaperScheduleHidden',
    WALLPAPER_ROTATE_MINUTES: 'wf_wallpaper_rotate_minutes', // '0' | '5' | '15' | '30' | '60'
    WALLPAPER_LAST_KEY: 'wf_wallpaper_last_key', // what the previous tab showed, so a new one starts elsewhere
    THUMBNAIL_MIGRATION_FLAG: 'wf_thumbnail_migration_v3',
    // Search & shortcuts
    SHORTCUTS_OPEN_MODE: 'shortcutsOpenMode',
    SHORTCUTS_OPEN_MODE_MUSIC: 'shortcutsOpenModeWhenMusic',
    SEARCH_OPEN_MODE: 'wf_search_open_mode',
    SEARCH_OPEN_MODE_MUSIC: 'wf_search_open_mode_when_music',
    // Unset means "same as Shortcuts", which is what every existing user has.
    BOOKMARKS_OPEN_MODE: 'wf_bookmarks_open_mode',
    BOOKMARKS_OPEN_MODE_MUSIC: 'wf_bookmarks_open_mode_when_music',
    // Widget visibility flags (read directly across many modules)
    MUSIC_HIDDEN: 'musicHidden',
    // Review prompts & first-run timestamps
    REVIEW_SUBMITTED: 'reviewSubmitted',
    REVIEW_NEXT_PROMPT_DAY: 'reviewNextPromptDay',
    FIRST_TAB_OPEN_TIME: 'firstTabOpenTime',
    // One-time hints, shown once per install
    WIDGET_OPTIONS_HINT_SEEN: 'wf_widget_options_hint_seen',
    SHORTCUT_DRAG_HINT_SEEN: 'wf_shortcut_drag_hint_seen',

    // Tasks: the list the user writes, and which task a finished focus
    // session is asking about. The question is transient and never exported.
    TASKS: 'wf_tasks',
    TASKS_ASK: 'wf_tasks_ask',
    // The interface language picked in Settings (absent means Auto), and the
    // merged catalogue that language needs at startup. Both read by i18n.js.
    UI_LANGUAGE: 'wf_ui_language',
    UI_LANGUAGE_PACK: 'wf_ui_language_pack',

    // Appearance
    CLOCK_FONT: 'wf_clock_font',
    BG_BLUR: 'wf_bg_blur',
    BG_BRIGHTNESS: 'wf_bg_brightness',
    TEXT_SHADOW: 'wf_text_shadow',
    TEXT_COLOR: 'wf_text_color',
    BACKGROUND_HIDDEN: 'backgroundHidden',
    SEARCH_HIDDEN: 'searchHidden',
    SHORTCUTS_HIDDEN: 'shortcutsHidden',
    CLOCK_HIDDEN: 'clockHidden',
    GREETING_HIDDEN: 'greetingHidden',
    POMODORO_HIDDEN: 'pomodoroHidden',
    BOOKMARKS_HIDDEN: 'bookmarksHidden',

    // Caches
    MUSIC_OEMBED_FAILURES: 'wf_oembed_failures_v1',
});

// Keys that may leave this machine, as an explicit allowlist rather than a dump
// of localStorage. The distinction is not tidiness: three categories of key are
// actively harmful to carry across.
//
//   Coordination state — wf_music_active_tab_id, the heartbeat, the tab id.
//   These decide which tab owns playback. Imported onto a second machine they
//   would name a tab that does not exist and block music until they went stale.
//
//   Wallpaper references — rotationKeys, activeVideoKey, the day/night slots.
//   They point at IndexedDB records by number, and the blobs themselves are far
//   too large to export. On another machine those numbers address either
//   nothing or somebody else's wallpaper, which is exactly the dangling
//   reference this release already had to clean up once.
//
//   Caches and local history — weather, favicons, oEmbed, review timers, first
//   run timestamps, one-time hints, migration flags. They rebuild themselves,
//   and carrying them means importing a stranger's stale data.
//
// What remains is what a person would actually call "my settings", plus the two
// lists they built by hand: their shortcuts and their saved playlists.
const EXPORTABLE_KEYS = Object.freeze([
    // Clock
    'wf_clock_format', 'wf_clock_seconds', 'wf_clock_date', 'wf_clock_size', 'wf_clock_font',
    // Daily message
    'dailyMessageName',
    // Weather
    'wf_weather_location', 'wf_weather_location_mode', 'wf_weather_show_city', 'wf_weather_unit',
    // Shortcuts + search behaviour
    'shortcuts', 'shortcutsOpenMode', 'shortcutsOpenModeWhenMusic',
    'wf_search_open_mode', 'wf_search_open_mode_when_music',
    'wf_bookmarks_open_mode', 'wf_bookmarks_open_mode_when_music',
    // Pomodoro durations and behaviour (not the running timer, not today's count)
    'wf_pomo_focus_min', 'wf_pomo_short_min', 'wf_pomo_long_min',
    'wf_pomo_auto_start', 'wf_pomo_focus_mode', 'wf_pomo_focus_tasks',
    // Background filters
    'wf_bg_blur', 'wf_bg_brightness',
    'wf_text_shadow', 'wf_text_color',
    // Music preferences and the library the user assembled
    'wf_saved_playlists', 'wf_ambient_mix_state', 'wf_ambient_muted',
    'wf_music_smart_resume', 'wf_youtube_bridge_volume', 'wf_youtube_bridge_muted', 'wf_youtube_loop',
    // The third list people build by hand, beside shortcuts and playlists
    'wf_tasks',
    // The interface language, when one was picked instead of Auto
    'wf_ui_language',
    // Which widgets are shown
    'searchHidden', 'shortcutsHidden', 'musicHidden', 'clockHidden', 'weatherHidden',
    'greetingHidden', 'pomodoroHidden', 'bookmarksHidden', 'backgroundHidden',
    'wallpaperScheduleHidden', 'videoPlaybackEnabled',
    // How often the wallpaper changes. The per-wallpaper durations stay behind:
    // they name IndexedDB rows, like rotationKeys.
    'wf_wallpaper_rotate_minutes',
]);
window.STORAGE_KEYS = STORAGE_KEYS;

// ==============================
// WEATHER UNITS — shared default
// ==============================
// Lives here rather than in widgets.js because two modules need the same
// answer: the settings panel (to light up the right segment) and the weather
// widget in utils.js (to format the reading). Keeping it in the shared layer
// means neither depends on the other's DOMContentLoaded handler running first.

// Countries that don't use Celsius day-to-day: the US (plus its territories),
// Liberia and Myanmar. Consulted only to pick the *initial* default for someone
// who has never touched the Units toggle — once they pick one, the stored value
// wins forever after.
const IMPERIAL_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'LR', 'MM']);

// IANA zones for those same countries. The timezone is the better signal than
// navigator.language: a Romanian running Chrome in US English reports "en-US"
// but lives on Celsius, and the weather widget already derives its location
// from the timezone — so the unit agrees with the reading it labels.
const IMPERIAL_TIMEZONES = new Set([
    'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville',
    'America/Kentucky/Monticello', 'America/Indiana/Indianapolis',
    'America/Indiana/Vincennes', 'America/Indiana/Winamac',
    'America/Indiana/Marengo', 'America/Indiana/Petersburg',
    'America/Indiana/Vevay', 'America/Indiana/Tell_City', 'America/Indiana/Knox',
    'America/Chicago', 'America/Menominee', 'America/North_Dakota/Center',
    'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah',
    'America/Denver', 'America/Boise', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'America/Juneau',
    'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome',
    'America/Adak', 'Pacific/Honolulu', 'America/Puerto_Rico', 'Pacific/Guam',
    'Pacific/Saipan', 'America/St_Thomas', 'Pacific/Pago_Pago',
    'Africa/Monrovia', 'Asia/Yangon', 'Asia/Rangoon',
]);

// The clock starts in the hour cycle of the interface's language: 24 hours in
// Romanian, German, French, Spanish and British English, 12 in US English.
// Only the starting point: a format someone picks is stored and wins.
function getDefaultClockFormat() {
    try {
        const locales = window.wfI18n ? wfI18n.intlLocales() : [];
        const options = new Intl.DateTimeFormat(locales, { hour: 'numeric' }).resolvedOptions();
        if (typeof options.hour12 === 'boolean') return options.hour12 ? '12h' : '24h';
        if (options.hourCycle) return options.hourCycle === 'h11' || options.hourCycle === 'h12' ? '12h' : '24h';
    } catch (_) { /* no Intl: keep the old default */ }
    return '12h';
}

function getRegionFromLanguage() {
    try {
        return (new Intl.Locale(navigator.language).region || '').toUpperCase();
    } catch (_) {
        // Intl.Locale is unavailable on older engines — parse the tag directly
        // ("en-US" -> "US").
        const parts = String(navigator.language || '').split('-');
        return (parts.length > 1 ? parts[parts.length - 1] : '').toUpperCase();
    }
}

function getDefaultWeatherUnit() {
    // 1. A manually picked city wins — it's the most explicit statement of
    //    "this is the place I care about".
    try {
        const raw = safeGet(STORAGE_KEYS.WEATHER_LOCATION);
        if (raw) {
            const loc = JSON.parse(raw);
            const code = String(loc?.countryCode || '').toUpperCase();
            if (code) return IMPERIAL_REGIONS.has(code) ? 'imperial' : 'metric';
        }
    } catch (_) { /* corrupt entry — fall through */ }

    // 2. Timezone: what "zone the user is in" actually means.
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        if (tz) {
            // Legacy aliases ("US/Eastern", "US/Hawaii") that Chrome normally
            // canonicalizes away, but some embedders still report verbatim.
            if (tz.startsWith('US/')) return 'imperial';
            if (IMPERIAL_TIMEZONES.has(tz)) return 'imperial';
            // A known non-imperial zone is a definite answer, not a fall-through
            // to the language guess.
            if (tz.includes('/')) return 'metric';
        }
    } catch (_) { /* Intl unavailable — fall through */ }

    // 3. Last resort: the browser's language tag.
    return IMPERIAL_REGIONS.has(getRegionFromLanguage()) ? 'imperial' : 'metric';
}

// Resolved preference: explicit choice if there is one, region default if not.
function getWeatherUnit() {
    const stored = safeGet(STORAGE_KEYS.WEATHER_UNIT);
    if (stored === 'metric' || stored === 'imperial') return stored;
    return getDefaultWeatherUnit();
}
window.getWeatherUnit = getWeatherUnit;

// ==============================
// NOTIFICATIONS (showPush / hidePush)
// ==============================

let pushTimeout = null;
let _pushContainer = null;
let _pushMessageSpan = null;
let _pushTagSpan = null;

function _initPushElements() {
  if (_pushContainer) return true;
  _pushContainer = document.getElementById("push-container");
  if (!_pushContainer) return false;
  _pushMessageSpan = _pushContainer.querySelector(".push-message");
  _pushTagSpan = _pushContainer.querySelector(".push-tag");
  return !!(_pushMessageSpan && _pushTagSpan);
}

function showPush(message, type = "default") {
  if (!_initPushElements()) return;
  const push = _pushContainer;
  const messageSpan = _pushMessageSpan;
  const tagSpan = _pushTagSpan;

  if (pushTimeout) {
    clearTimeout(pushTimeout);
    pushTimeout = null;
  }

  messageSpan.textContent = typeof message === 'string' ? message : String(message);

  push.classList.remove("hide");
  push.classList.add("show");
  push.classList.remove("push-success", "push-warning", "push-enabled", "push-disabled");

  let tagText = t('toast_update');
  if (type === "success") {
    push.classList.add("push-success");
    tagText = t('toast_tag_saved');
  } else if (type === "warning") {
    push.classList.add("push-warning");
    tagText = t('toast_tag_heads_up');
  } else if (type === "enabled") {
    push.classList.add("push-enabled");
    tagText = t('toast_tag_enabled');
  } else if (type === "disabled") {
    push.classList.add("push-disabled");
    tagText = t('toast_tag_disabled');
  }
  tagSpan.textContent = tagText;

  const duration = type === "warning" ? 4000 : 3000;
  pushTimeout = setTimeout(() => {
    push.classList.remove("show");
    push.classList.add("hide");
    pushTimeout = null;
  }, duration);
}

function hidePush() {
  if (!_initPushElements()) return;
  _pushContainer.classList.remove('show');
  _pushContainer.classList.add('hide');
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.querySelector('.push-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePush();
    });
  }
});
