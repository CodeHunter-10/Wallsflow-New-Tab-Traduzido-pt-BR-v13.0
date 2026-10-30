// ==============================
// WIDGET CORE — state & Day/Night UI
// ==============================

let currentWallpapersFilter = 'all';
let currentWidgetsFilter = 'all';
// Aliased to STORAGE_KEYS (defined in notifications.js, loaded first) so the
// canonical key catalog has a single source of truth.
const SHORTCUTS_OPEN_MODE_KEY = STORAGE_KEYS.SHORTCUTS_OPEN_MODE;
const SHORTCUTS_OPEN_MODE_MUSIC_KEY = STORAGE_KEYS.SHORTCUTS_OPEN_MODE_MUSIC;
const SEARCH_OPEN_MODE_KEY = STORAGE_KEYS.SEARCH_OPEN_MODE;
const SEARCH_OPEN_MODE_MUSIC_KEY = STORAGE_KEYS.SEARCH_OPEN_MODE_MUSIC;
const DAILY_MESSAGE_NAME_KEY = STORAGE_KEYS.DAILY_MESSAGE_NAME;
// (WALLPAPER_SCHEDULE_HIDDEN_KEY const removed — used in only one place;
//  inlined as 'wallpaperScheduleHidden' below.)

function isDayNightWidgetEnabled() {
    return safeGet('wallpaperScheduleHidden') !== 'true';
}

function updateDayNightUiAvailability() {
    const enabled = isDayNightWidgetEnabled();

    // Cache all wallpapers-list queries in a single pass — before, each branch
    // below re-ran querySelectorAll for overlapping selectors (6 DOM walks total).
    const wallpapersList = document.getElementById('wallpapers-list');
    const slotButtons = wallpapersList ? wallpapersList.querySelectorAll('.fav-time-slot') : [];
    const randomButtons = wallpapersList ? wallpapersList.querySelectorAll('.fav-random') : [];
    const allCards = wallpapersList ? wallpapersList.querySelectorAll('.fav-card') : [];
    let hasCustomWallpapers = false;
    for (const card of allCards) {
        if (!card.classList.contains('default-wallpaper')) { hasCustomWallpapers = true; break; }
    }

    for (const btn of slotButtons) {
        btn.classList.toggle('is-hidden', !(enabled));
    }

    for (const btn of randomButtons) {
        const card = btn.closest('.fav-card');
        const isDefaultCard = !!card && card.classList.contains('default-wallpaper');
        if (isDefaultCard && !hasCustomWallpapers) {
            btn.classList.add('is-hidden');
            continue;
        }
        btn.classList.toggle('is-hidden', enabled);
    }

    const dayNightFilters = document.querySelectorAll('.wallpapers-filter-btn[data-filter="day"], .wallpapers-filter-btn[data-filter="night"]');
    for (const btn of dayNightFilters) {
        btn.classList.toggle('is-hidden', !(enabled));
        btn.classList.toggle('disabled', !enabled);
        btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        btn.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    }

    const randomFilterBtn = document.querySelector('.wallpapers-filter-btn[data-filter="random"]');
    if (randomFilterBtn) {
        randomFilterBtn.classList.toggle('is-hidden', enabled);
        randomFilterBtn.setAttribute('aria-hidden', enabled ? 'true' : 'false');
    }

    for (const card of allCards) {
        updateWallpaperCardBadges(card);
    }

    if (enabled && currentWallpapersFilter === 'random') {
        currentWallpapersFilter = 'all';
    }

    if (!enabled && (currentWallpapersFilter === 'day' || currentWallpapersFilter === 'night')) {
        currentWallpapersFilter = 'all';
    }

    updateWallpaperFilterButtons();
    applyWallpaperFilters();
    renderWallpaperFilterHelpContent();
}

// ==============================
// WIDGET BEHAVIORS — event handlers, settings, toggles
// ==============================

// Utility: debounce — delays execution until after `wait` ms of inactivity
function debounce(fn, wait) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

// Every control in Settings writes straight to storage — there is no Save
// button. A toast on each change is what communicates that, so the panel doesn't
// feel like it swallowed the input. Card title, row label and value are all read
// back out of the DOM, so the message can never drift from what the control
// actually says, and new settings get a toast for free.
//
// `sourceEl` is the control that changed (segmented button, slider, text input).
// `valueOverride` is for controls whose value isn't their own text content.
function announceSettingChange(sourceEl, valueOverride) {
    if (!sourceEl || typeof showPush !== 'function') return;

    // Options now live inside their widget's row, so the subject comes from the
    // row's own name instead of a separate settings card that no longer exists.
    const card = sourceEl.closest('.simple-widget-item');
    const cardTitle = card?.querySelector('.simple-widget-name')?.textContent?.trim() || '';
    const row = sourceEl.closest('.widget-option-row');
    const rowLabel = row?.querySelector('.widget-option-label')?.textContent?.trim() || '';
    const value = String(valueOverride ?? sourceEl.textContent ?? '').trim();

    // "Open by default" exists under BOTH Shortcuts and Search Bar — the card
    // title is the only thing that tells the two toasts apart.
    const subject = [cardTitle, rowLabel].filter(Boolean).join(' \u00B7 ');
    if (!subject) {
        showPush(t('toast_setting_saved_plain'), 'success');
        return;
    }

    // 'success' renders the "Saved" tag, which is the whole point: make it
    // obvious that nothing needs confirming.
    showPush(value ? t('toast_setting_value', { subject, value }) : t('toast_setting_saved', { subject }), 'success');
}
window.wfAnnounceSettingChange = announceSettingChange;

// Initialize widget toggle switches
async function initializeWidgetToggles() {
    const widgetItems = document.querySelectorAll('.simple-widget-item');

    for (const item of widgetItems) {
        const toggle = item.querySelector('.simple-toggle-switch');
        const target = item.getAttribute('data-target');

        if (toggle && target) {
            await initializeWidgetState(item, toggle, target);

            toggle.addEventListener('click', (e) => {
                e.stopPropagation();

                if (item.classList.contains('disabled')) {
                    return;
                }

                item.classList.toggle('active');
                const isNowActive = item.classList.contains('active');

                updateToggleState(toggle, isNowActive);
                applyCurrentWidgetsFilter();

                // A refused write leaves the switch where it was: the next tab
                // would show the old state anyway, so this one should too.
                if (handleWidgetToggle(target, isNowActive) === false) {
                    item.classList.toggle('active');
                    updateToggleState(toggle, !isNowActive);
                    applyCurrentWidgetsFilter();
                }
            });

            // The row used to toggle the widget. It no longer does: the switch
            // owns on/off, and the row owns opening the options. One click doing
            // two different things depending on where it landed was the
            // ambiguity worth removing — a click that sometimes turns your clock
            // off and sometimes opens a panel is not a click anyone can predict.
            // See initializeWidgetOptionDisclosures for the row's behaviour.
        }
    }

    applyCurrentWidgetsFilter();
}

// Options are folded away by default. Eleven rows stay scannable, and the
// configuration is one click from the switch it belongs to instead of one tab
// away. Only rows that actually have options carry a disclosure.

function initializeWidgetOptionDisclosures() {
    for (const item of document.querySelectorAll('.simple-widget-item.has-options')) {
        const btn = item.querySelector('.widget-expand-btn');
        const setOpen = (open) => {
            item.classList.toggle('options-open', open);
            if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        item.addEventListener('click', (e) => {
            // The switch owns on/off. The help owns its own dropdown. And a
            // click inside the options is someone using them, not asking to
            // close the panel they are working in.
            if (e.target.closest('.simple-toggle-switch, .widget-help-btn, .widget-help-dropdown, .widget-inline-options')) return;
            setOpen(!item.classList.contains('options-open'));
        });

        // The chevron stays a real button so the row is reachable by keyboard;
        // it is only hidden visually until the pointer is on the row.
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setOpen(!item.classList.contains('options-open'));
            });
        }
    }
}

// One-time hint, on first visit to the Widgets tab rather than on page load —
// a tip about a panel is useless while the panel is closed. Mirrors the
// shortcut drag hint: shown once, then never again.
function maybeShowWidgetOptionsHint() {
    const SEEN_KEY = 'wf_widget_options_hint_seen';
    if (typeof safeGet !== 'function' || safeGet(SEEN_KEY) === 'true') return;
    if (!document.querySelector('.simple-widget-item.has-options')) return;
    setTimeout(() => {
        if (typeof showPush === 'function') {
            showPush(t('widgets_toast_options_tip'), 'default');
        }
        if (typeof safeSet === 'function') safeSet(SEEN_KEY, 'true');
    }, 600);
}

function initializeWidgetHelpDropdowns() {
    const widgetItems = document.querySelectorAll('.simple-widget-item');

    if (!widgetItems.length) return;

    function closeAllHelpDropdowns(exceptItem = null) {
        for (const item of widgetItems) {
            if (exceptItem && item === exceptItem) continue;

            item.classList.remove('help-open');
            const btn = item.querySelector('.widget-help-btn');
            if (btn) {
                btn.classList.remove('active');
                btn.setAttribute('aria-expanded', 'false');
            }
        }
    }

    for (const item of widgetItems) {
        const helpBtn = item.querySelector('.widget-help-btn');
        const helpDropdown = item.querySelector('.widget-help-dropdown');

        if (!helpBtn || !helpDropdown) continue;

        helpBtn.addEventListener('click', (e) => {
            e.stopPropagation();

            const isOpen = item.classList.contains('help-open');
            closeAllHelpDropdowns(item);

            item.classList.toggle('help-open', !isOpen);
            helpBtn.classList.toggle('active', !isOpen);
            helpBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        });

        helpDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#widgets-section')) {
            closeAllHelpDropdowns();
        }
    });
}

// Shortcuts and Bookmarks share this control: two segmented rows, one for
// the default and one for while music plays. `fallbackKeys` paints the row
// from another widget's choice while this one has none of its own.
function initializeOpenModeSettings({ widget, defaultKey, musicKey, fallbackKeys = null }) {
    const settingsRoot = document.querySelector(`[data-widget-options="${widget}"]`);
    if (!settingsRoot) return;

    const allButtons = settingsRoot.querySelectorAll('.widget-open-mode-btn');
    if (!allButtons.length) return;

    const getStoredMode = (storageKey, fallbackKey) => {
        let stored = safeGet(storageKey);
        if (stored === null && fallbackKey) stored = safeGet(fallbackKey);
        return stored === '_self' ? '_self' : '_blank';
    };

    const setActiveButton = (setting, value) => {
        const settingButtons = settingsRoot.querySelectorAll(`.widget-open-mode-btn[data-setting="${setting}"]`);
        for (const button of settingButtons) {
            const isActive = button.getAttribute('data-value') === value;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
    };

    const syncActiveButtons = () => {
        setActiveButton('default', getStoredMode(defaultKey, fallbackKeys?.defaultKey));
        setActiveButton('music', getStoredMode(musicKey, fallbackKeys?.musicKey));
    };

    syncActiveButtons();

    if (settingsRoot.dataset.initialized === 'true') {
        return;
    }
    settingsRoot.dataset.initialized = 'true';

    settingsRoot.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    for (const button of allButtons) {
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const setting = button.getAttribute('data-setting');
            const value = button.getAttribute('data-value') === '_self' ? '_self' : '_blank';
            let saved = false;
            if (setting === 'default') {
                saved = saveSetting(defaultKey, value);
            } else if (setting === 'music') {
                saved = saveSetting(musicKey, value);
            } else {
                return;
            }

            syncActiveButtons();
            if (saved) announceSettingChange(button);
        });
    }
}

function initializeShortcutBehaviorSettings() {
    initializeOpenModeSettings({
        widget: 'shortcuts',
        defaultKey: SHORTCUTS_OPEN_MODE_KEY,
        musicKey: SHORTCUTS_OPEN_MODE_MUSIC_KEY,
    });
}

function initializeBookmarksBehaviorSettings() {
    initializeOpenModeSettings({
        widget: 'bookmarks',
        defaultKey: STORAGE_KEYS.BOOKMARKS_OPEN_MODE,
        musicKey: STORAGE_KEYS.BOOKMARKS_OPEN_MODE_MUSIC,
        fallbackKeys: { defaultKey: SHORTCUTS_OPEN_MODE_KEY, musicKey: SHORTCUTS_OPEN_MODE_MUSIC_KEY },
    });
}

// Tasks: wiping the whole list sits in the Pomodoro card, behind a
// confirmation, away from a stray click. Tasks in focus is an ordinary
// Pomodoro setting and needs nothing here. The list itself is not a setting,
// so the Reset card never touches it.
function initializeTasksSettings() {
    const clearAllBtn = document.getElementById('tasks-clear-all-btn');
    if (!clearAllBtn || clearAllBtn.dataset.wired === 'true') return;
    clearAllBtn.dataset.wired = 'true';

    clearAllBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const confirmed = await showConfirmModal(
            'tasks-clear-all-modal',
            'tasks-clear-all-cancel',
            'tasks-clear-all-confirm',
            t('tasks_confirm_delete_all')
        );
        if (!confirmed) return;
        if (typeof window.wfClearAllTasks === 'function' && window.wfClearAllTasks()) {
            showPush(t('tasks_toast_all_deleted'), 'default');
        }
    });
}

function initializeSearchBarSettings() {
    const settingsRoot = document.querySelector('[data-widget-options="search"]');
    if (!settingsRoot) return;

    const allButtons = settingsRoot.querySelectorAll('.widget-open-mode-btn');
    if (!allButtons.length) return;

    const getStoredOpenMode = (key) => {
        const stored = safeGet(key);
        return stored === '_self' ? '_self' : '_blank';
    };

    const setActiveButton = (setting, value) => {
        const btns = settingsRoot.querySelectorAll(`.widget-open-mode-btn[data-setting="${setting}"]`);
        for (const btn of btns) {
            const isActive = btn.getAttribute('data-value') === String(value);
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
    };

    const syncActiveButtons = () => {
        setActiveButton('default', getStoredOpenMode(SEARCH_OPEN_MODE_KEY));
        setActiveButton('music', getStoredOpenMode(SEARCH_OPEN_MODE_MUSIC_KEY));
    };

    syncActiveButtons();

    if (settingsRoot.dataset.initialized === 'true') return;
    settingsRoot.dataset.initialized = 'true';

    settingsRoot.addEventListener('click', (e) => { e.stopPropagation(); });

    for (const button of allButtons) {
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const setting = button.getAttribute('data-setting');
            const rawValue = button.getAttribute('data-value');

            let saved = false;
            if (setting === 'default') {
                saved = saveSetting(SEARCH_OPEN_MODE_KEY, rawValue === '_self' ? '_self' : '_blank');
            } else if (setting === 'music') {
                saved = saveSetting(SEARCH_OPEN_MODE_MUSIC_KEY, rawValue === '_self' ? '_self' : '_blank');
            } else {
                return;
            }
            if (!saved) { syncActiveButtons(); return; }

            syncActiveButtons();
            announceSettingChange(button);
        });
    }
}

function getDailyMessageName() {
    const storedName = safeGet(DAILY_MESSAGE_NAME_KEY) || '';
    return storedName.trim();
}

// Subtitle variants keyed by [time-of-day][weather-condition]. The greeting
// picks one at random within the matching bucket; the pick is cached so
// repeat refreshes (settings-panel saves, name input edits) don't reroll
// and feel flickery. The cache invalidates only when the (time, weather)
// pair changes — so dawn/dusk transitions and weather flips DO reroll.
//
// Tone: short, calm, lo-fi vibe to match the rest of the extension. Avoid
// exclamation marks except where the rhythm calls for one.
//
// The table holds message names, each written out in full so the catalogue
// tests can find it. Every language keeps the same number of lines per bucket;
// a translator may repeat a line rather than drop one.
const GREETING_VARIANTS = {
    morning: {
        clear:           ['greet_morning_clear_1', 'greet_morning_clear_2', 'greet_morning_clear_3'],
        'partly-cloudy': ['greet_morning_partly_cloudy_1', 'greet_morning_partly_cloudy_2'],
        cloudy:          ['greet_morning_cloudy_1', 'greet_morning_cloudy_2'],
        rain:            ['greet_morning_rain_1', 'greet_morning_rain_2', 'greet_morning_rain_3'],
        snow:            ['greet_morning_snow_1', 'greet_morning_snow_2'],
        storm:           ['greet_morning_storm_1', 'greet_morning_storm_2'],
        fog:             ['greet_morning_fog_1', 'greet_morning_fog_2'],
        windy:           ['greet_morning_windy_1', 'greet_morning_windy_2'],
        default:         ['greet_morning_default_1', 'greet_morning_default_2']
    },
    afternoon: {
        clear:           ['greet_afternoon_clear_1', 'greet_afternoon_clear_2'],
        'partly-cloudy': ['greet_afternoon_partly_cloudy_1', 'greet_afternoon_partly_cloudy_2'],
        cloudy:          ['greet_afternoon_cloudy_1', 'greet_afternoon_cloudy_2'],
        rain:            ['greet_afternoon_rain_1', 'greet_afternoon_rain_2'],
        snow:            ['greet_afternoon_snow_1', 'greet_afternoon_snow_2'],
        storm:           ['greet_afternoon_storm_1', 'greet_afternoon_storm_2'],
        fog:             ['greet_afternoon_fog_1', 'greet_afternoon_fog_2'],
        windy:           ['greet_afternoon_windy_1', 'greet_afternoon_windy_2'],
        default:         ['greet_afternoon_default_1', 'greet_afternoon_default_2']
    },
    evening: {
        clear:           ['greet_evening_clear_1', 'greet_evening_clear_2', 'greet_evening_clear_3'],
        'partly-cloudy': ['greet_evening_partly_cloudy_1', 'greet_evening_partly_cloudy_2'],
        cloudy:          ['greet_evening_cloudy_1', 'greet_evening_cloudy_2'],
        rain:            ['greet_evening_rain_1', 'greet_evening_rain_2', 'greet_evening_rain_3'],
        snow:            ['greet_evening_snow_1', 'greet_evening_snow_2'],
        storm:           ['greet_evening_storm_1', 'greet_evening_storm_2'],
        fog:             ['greet_evening_fog_1', 'greet_evening_fog_2'],
        windy:           ['greet_evening_windy_1', 'greet_evening_windy_2'],
        default:         ['greet_evening_default_1', 'greet_evening_default_2']
    },
    night: {
        clear:           ['greet_night_clear_1', 'greet_night_clear_2', 'greet_night_clear_3'],
        'partly-cloudy': ['greet_night_partly_cloudy_1', 'greet_night_partly_cloudy_2'],
        cloudy:          ['greet_night_cloudy_1', 'greet_night_cloudy_2'],
        rain:            ['greet_night_rain_1', 'greet_night_rain_2'],
        snow:            ['greet_night_snow_1', 'greet_night_snow_2'],
        storm:           ['greet_night_storm_1', 'greet_night_storm_2'],
        fog:             ['greet_night_fog_1', 'greet_night_fog_2'],
        windy:           ['greet_night_windy_1', 'greet_night_windy_2'],
        default:         ['greet_night_default_1', 'greet_night_default_2']
    }
};

function getGreetingTimeBucket(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
}

// Cache the most recent (timeBucket, weatherCondition) pair and the picked
// subtitle so repeat calls return the same line — repicking on every render
// would flicker each time the settings panel opens or the name input fires
// the debounced save. Repick only when the input pair actually changes.
let _greetingCachedKey = '';
let _greetingCachedSubtitle = '';

function pickGreetingSubtitle(timeBucket, weatherCondition) {
    const bucket = GREETING_VARIANTS[timeBucket] || GREETING_VARIANTS.evening;
    const condKey = (weatherCondition && bucket[weatherCondition]) ? weatherCondition : 'default';
    const cacheKey = `${timeBucket}:${condKey}`;
    if (cacheKey === _greetingCachedKey && _greetingCachedSubtitle) {
        return _greetingCachedSubtitle;
    }
    const variants = bucket[condKey] || bucket.default;
    const picked = variants[Math.floor(Math.random() * variants.length)];
    _greetingCachedKey = cacheKey;
    _greetingCachedSubtitle = picked;
    return picked;
}

function getDailyMessageContent() {
    const hour = new Date().getHours();
    const timeBucket = getGreetingTimeBucket(hour);

    let greeting;
    if (timeBucket === 'morning') greeting = t('greet_headline_morning');
    else if (timeBucket === 'afternoon') greeting = t('greet_headline_afternoon');
    else if (timeBucket === 'evening') greeting = t('greet_headline_evening');
    else greeting = t('greet_headline_night');

    const weatherCondition = (typeof window.wfGetWeatherCondition === 'function')
        ? window.wfGetWeatherCondition()
        : null;
    // A name picked from GREETING_VARIANTS, where each one is written in full.
    const subtitle = wfI18n.t(pickGreetingSubtitle(timeBucket, weatherCondition));

    return { headline: greeting, subtitle: personalizeGreeting(subtitle, getDailyMessageName()) };
}

// Puts the user's name into a greeting line, before its closing punctuation.
// The template decides the order and the separator for each language, and
// any spaces before the mark travel with it, so French keeps "Belle soirée,
// Ana !" and Spanish keeps its opening "¡".
function personalizeGreeting(subtitle, name, translate = t) {
    if (!name) return subtitle;
    const match = subtitle.match(/\s*[.!?…]+$/u);
    const end = match ? match[0] : translate('greet_with_name_default_end');
    const line = match ? subtitle.slice(0, match.index) : subtitle;
    return translate('greet_with_name', { line, name, end });
}

// When the weather widget reports a condition change (first successful
// fetch after page load, or a real shift like sun → storm later in the
// day), repaint the greeting subtitle so it matches the new context.
//
// Skip the repaint while the entry typing animation in utils.js is still
// running: that handler captured the subtitle once at DOMContentLoaded
// and is appending characters via setTimeout chains; a textContent reset
// from us mid-stream would corrupt the partially-typed string. The
// typing animation drops the .is-typing class on completion, so testing
// for it is enough. Cold-start case (no weather cache) accepts a slight
// loss — the first tab open shows the "default" subtitle if weather
// arrives mid-typing; subsequent tabs hit the cache before typing
// captures the subtitle and so type out the weather-aware line directly.
document.addEventListener('wf:weather-changed', () => {
    const titleEl = document.getElementById('greeting-text');
    const subEl = document.getElementById('greeting-subtitle');
    if ((titleEl && titleEl.classList.contains('is-typing'))
        || (subEl && subEl.classList.contains('is-typing'))) {
        return;
    }
    refreshDailyMessageText();
});

function refreshDailyMessageText() {
    const greetingText = document.getElementById('greeting-text');
    const greetingSubtitle = document.getElementById('greeting-subtitle');
    if (!greetingText || !greetingSubtitle) return;

    const { headline, subtitle } = getDailyMessageContent();
    greetingText.textContent = headline;
    greetingSubtitle.textContent = subtitle;
}

function initializeDailyMessageSettings() {
    const settingsRoot = document.querySelector('[data-widget-options="greeting"]');
    const input = document.getElementById('daily-message-name-input');
    if (!settingsRoot || !input) return;

    input.value = getDailyMessageName();
    refreshDailyMessageText();

    if (settingsRoot.dataset.initialized === 'true') {
        return;
    }
    settingsRoot.dataset.initialized = 'true';

    settingsRoot.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    input.addEventListener('input', debounce(() => {
        const cleanName = input.value.replace(/\s+/g, ' ').trim();
        if (cleanName) {
            safeSet(DAILY_MESSAGE_NAME_KEY, cleanName);
        } else {
            safeRemove(DAILY_MESSAGE_NAME_KEY);
        }

        refreshDailyMessageText();
        // Already debounced by the wrapper, so typing doesn't produce a toast
        // per keystroke.
        announceSettingChange(input, cleanName || 'cleared');
    }, 350));
}

const WEATHER_LOCATION_KEY = STORAGE_KEYS.WEATHER_LOCATION;
const WEATHER_LOCATION_MODE_KEY = STORAGE_KEYS.WEATHER_LOCATION_MODE; // 'auto' | 'manual'
const WEATHER_SHOW_CITY_KEY = STORAGE_KEYS.WEATHER_SHOW_CITY; // 'true' | 'false', default 'true'
const WEATHER_UNIT_KEY = STORAGE_KEYS.WEATHER_UNIT; // 'metric' | 'imperial'

function initializeWeatherSettings() {
    const settingsRoot = document.querySelector('[data-widget-options="weather"]');
    if (!settingsRoot) return;
    const modeBtns = settingsRoot.querySelectorAll('.widget-open-mode-btn[data-setting="weatherLocationMode"]');
    const autoRow = document.getElementById('weather-auto-row');
    const autoDetectedEl = document.getElementById('weather-auto-detected');
    const manualRow = document.getElementById('weather-manual-row');
    const input = document.getElementById('weather-city-input');
    const suggestionsEl = document.getElementById('weather-city-suggestions');
    const currentEl = document.getElementById('weather-city-current');
    if (!modeBtns.length || !autoRow || !autoDetectedEl || !manualRow || !input || !suggestionsEl || !currentEl) return;

    // The same name the weather widget shows, from the shared lookup in
    // notifications.js: localized once known, English from the timezone first.
    const getDetectedCity = () => (typeof wfDetectedCityName === 'function' && wfDetectedCityName()) || t('widget_weather_unknown_city');
    document.addEventListener('wf:city-name', () => {
        if (getMode() === 'auto') autoDetectedEl.textContent = getDetectedCity();
    });
    if (typeof wfLocalizeDetectedCity === 'function') wfLocalizeDetectedCity();

    const getMode = () => safeGet(WEATHER_LOCATION_MODE_KEY) || 'auto';
    const getSavedLocation = () => {
        try {
            const raw = safeGet(WEATHER_LOCATION_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon) ? parsed : null;
        } catch (_) { return null; }
    };

    const renderCurrentLocation = () => {
        const loc = getSavedLocation();
        if (loc) {
            currentEl.hidden = false;
            const region = [loc.admin1, loc.country].filter(Boolean).join(', ');
            currentEl.innerHTML = '';
            const label = document.createElement('span');
            label.className = 'weather-city-current-label';
            label.textContent = loc.name + (region ? ', ' + region : '');
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'weather-city-clear';
            clear.title = t('widget_weather_clear_city_title');
            clear.textContent = '×';
            clear.addEventListener('click', (e) => {
                e.stopPropagation();
                safeRemove(WEATHER_LOCATION_KEY);
                renderCurrentLocation();
                if (typeof window.wfRefreshWeather === 'function') window.wfRefreshWeather();
            });
            currentEl.appendChild(label);
            currentEl.appendChild(clear);
        } else {
            currentEl.hidden = true;
            currentEl.innerHTML = '';
        }
    };

    // `refresh` is false when painting the saved mode at init: the cached
    // reading is still for the right place, and fetching on every new tab
    // was exactly what the 30 minute cache exists to prevent.
    const setMode = (mode, { refresh = true } = {}) => {
        saveSetting(WEATHER_LOCATION_MODE_KEY, mode);
        autoRow.classList.toggle('is-hidden', mode !== 'auto');
        manualRow.classList.toggle('is-hidden', mode !== 'manual');
        // Hide suggestions if any are open when switching mode
        suggestionsEl.hidden = true;
        for (const btn of modeBtns) {
            const isActive = btn.getAttribute('data-value') === mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
        if (mode === 'auto') {
            // Auto mode → clear manual override + show detected city
            safeRemove(WEATHER_LOCATION_KEY);
            autoDetectedEl.textContent = getDetectedCity();
            renderCurrentLocation();
            if (refresh && typeof window.wfRefreshWeather === 'function') window.wfRefreshWeather();
        } else {
            renderCurrentLocation();
        }
    };

    const cityToggleBtns = settingsRoot.querySelectorAll('.widget-open-mode-btn[data-setting="weatherShowCity"]');
    const unitToggleBtns = settingsRoot.querySelectorAll('.widget-open-mode-btn[data-setting="weatherUnit"]');
    const weatherWidgetEl = document.getElementById('weather-widget');

    const getUnit = () => getWeatherUnit(); // shared resolver — notifications.js
    const setUnit = (unit) => {
        const value = unit === 'imperial' ? 'imperial' : 'metric';
        saveSetting(WEATHER_UNIT_KEY, value);
        for (const btn of unitToggleBtns) {
            const isActive = btn.getAttribute('data-value') === value;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
        // Repaint from the cached reading — no refetch, so the switch is instant
        // and doesn't burn an API call.
        if (typeof window.wfApplyWeatherUnit === 'function') window.wfApplyWeatherUnit();
    };

    const getShowCity = () => safeGet(WEATHER_SHOW_CITY_KEY) !== 'false';
    const setShowCity = (show) => {
        saveSetting(WEATHER_SHOW_CITY_KEY, show ? 'true' : 'false');
        if (weatherWidgetEl) weatherWidgetEl.classList.toggle('no-city', !show);
        for (const btn of cityToggleBtns) {
            const isActive = btn.getAttribute('data-value') === (show ? 'true' : 'false');
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
    };

    // Init UI from storage
    setMode(getMode(), { refresh: false });
    setShowCity(getShowCity());
    setUnit(getUnit());

    if (settingsRoot.dataset.initialized === 'true') return;
    settingsRoot.dataset.initialized = 'true';

    settingsRoot.addEventListener('click', (e) => e.stopPropagation());

    // The push lives in the click handler, not in setMode/setShowCity/setUnit —
    // those also run on init to paint stored state, and firing there would greet
    // every new tab with a stack of toasts.
    for (const btn of modeBtns) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMode(btn.getAttribute('data-value'));
            announceSettingChange(btn);
        });
    }

    for (const btn of cityToggleBtns) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setShowCity(btn.getAttribute('data-value') === 'true');
            announceSettingChange(btn);
        });
    }

    for (const btn of unitToggleBtns) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setUnit(btn.getAttribute('data-value'));
            announceSettingChange(btn);
        });
    }

    // Geocoding search via Open-Meteo (free, no API key)
    let searchAbort = null;
    const search = async (query) => {
        if (searchAbort) searchAbort.abort();
        searchAbort = new AbortController();
        try {
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=${encodeURIComponent(window.wfI18n ? wfI18n.geoLanguage() : 'en')}&format=json`;
            const res = await fetch(url, { signal: searchAbort.signal });
            if (!res.ok) throw new Error('search failed');
            const data = await res.json();
            return Array.isArray(data?.results) ? data.results : [];
        } catch (_) { return []; }
    };

    const renderSuggestions = (items) => {
        suggestionsEl.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'weather-city-suggestions-empty';
            empty.textContent = t('widget_weather_no_cities');
            suggestionsEl.appendChild(empty);
            suggestionsEl.hidden = false;
            return;
        }
        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'weather-city-suggestion';
            const name = document.createElement('div');
            name.className = 'weather-city-suggestion-name';
            name.textContent = item.name;
            const region = document.createElement('div');
            region.className = 'weather-city-suggestion-region';
            region.textContent = [item.admin1, item.country].filter(Boolean).join(', ');
            row.appendChild(name);
            row.appendChild(region);
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                const loc = {
                    name: item.name,
                    lat: item.latitude,
                    lon: item.longitude,
                    country: item.country || '',
                    // ISO2 from the geocoder. Kept so the °C/°F default can key
                    // off the city the user actually picked — someone in Bucharest
                    // who searches "Miami" gets °F, which is what they meant.
                    countryCode: item.country_code || '',
                    admin1: item.admin1 || ''
                };
                safeSet(WEATHER_LOCATION_KEY, JSON.stringify(loc));
                input.value = '';
                suggestionsEl.hidden = true;
                renderCurrentLocation();
                if (typeof window.wfRefreshWeather === 'function') window.wfRefreshWeather();
                showPush(t('widget_weather_toast_location_set', { city: item.name }), 'success');
            });
            suggestionsEl.appendChild(row);
        });
        suggestionsEl.hidden = false;
    };

    input.addEventListener('click', (e) => e.stopPropagation());

    input.addEventListener('input', debounce(async () => {
        const q = input.value.trim();
        if (q.length < 2) {
            suggestionsEl.hidden = true;
            return;
        }
        const items = await search(q);
        renderSuggestions(items);
    }, 280));

    input.addEventListener('focus', () => {
        if (input.value.trim().length >= 2 && suggestionsEl.children.length) {
            suggestionsEl.hidden = false;
        }
    });

    document.addEventListener('click', (e) => {
        if (!suggestionsEl.contains(e.target) && e.target !== input) {
            suggestionsEl.hidden = true;
        }
    }, true);
}

const CLOCK_SETTINGS_MAP = {
    // Follows the interface's language until a format is picked.
    format: { key: 'wf_clock_format', fallback: () => (typeof getDefaultClockFormat === 'function' ? getDefaultClockFormat() : '12h') },
    seconds: { key: 'wf_clock_seconds', fallback: 'false' },
    date: { key: 'wf_clock_date', fallback: 'true' },
    size: { key: 'wf_clock_size', fallback: 'M' },
    font: { key: 'wf_clock_font', fallback: 'default' }
};

function initializeClockSettings() {
    const settingsRoot = document.querySelector('[data-widget-options="clock"]');
    if (!settingsRoot) return;

    const allButtons = settingsRoot.querySelectorAll('.widget-open-mode-btn');
    if (!allButtons.length) return;

    const syncActiveButtons = () => {
        for (const [setting, config] of Object.entries(CLOCK_SETTINGS_MAP)) {
            const stored = safeGet(config.key) || (typeof config.fallback === 'function' ? config.fallback() : config.fallback);
            const btns = settingsRoot.querySelectorAll(`.widget-open-mode-btn[data-setting="${setting}"]`);
            for (const btn of btns) {
                const isActive = btn.getAttribute('data-value') === stored;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            }
        }
    };

    syncActiveButtons();

    if (settingsRoot.dataset.initialized === 'true') return;
    settingsRoot.dataset.initialized = 'true';

    settingsRoot.addEventListener('click', (e) => { e.stopPropagation(); });

    for (const button of allButtons) {
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const setting = button.getAttribute('data-setting');
            const value = button.getAttribute('data-value');
            const config = CLOCK_SETTINGS_MAP[setting];
            if (!config) return;

            if (!saveSetting(config.key, value)) { syncActiveButtons(); return; }
            syncActiveButtons();

            if (typeof updateClockWidget === 'function') updateClockWidget();
            if (typeof applyClockSize === 'function') applyClockSize();
            if (typeof applyClockFont === 'function') applyClockFont();
            announceSettingChange(button);
        });
    }
}

// (syncSettingsAvailabilityByWidgetState lived here. It existed only to keep a
// split UI consistent: it looked up each Settings card's matching widget row and
// dimmed the card and disabled its controls when the widget was off. With the
// options moved inside the widget row itself, the existing CSS rule
// `.simple-widget-item:not(.active) .widget-inline-options { display: none }`
// does the whole job — a function whose reason for existing was the split.)

// (initializeWidgetsResetButton lived here, behind a "Show every widget again"
// button. It answered the question "where did my widget go?" back when the tab
// was a flat list with no way to see what was off. The Enabled/Disabled filter
// answers it better — you see exactly which ones are missing and switch back
// only the ones you want, rather than also re-enabling widgets you had
// deliberately turned off.)


// Bumped only if the shape of the file changes, not when keys are added or
// removed: an importer that filters against its own allowlist tolerates both.
// ==============================
// SETTINGS BACKUP — export / import
// ==============================

// Bumped only if the shape of the file changes, not when keys are added or
// removed: an importer that filters against its own allowlist tolerates both.
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_MAX_BYTES = 2 * 1024 * 1024;

function buildSettingsBackup() {
    const settings = {};
    for (const key of EXPORTABLE_KEYS) {
        const value = safeGet(key);
        if (value !== null && value !== undefined) settings[key] = value;
    }
    // The language on screen goes in even when nothing is stored, because it
    // came from the browser or was picked as the language the browser already
    // prefers. Restoring a backup brings back the language that was in use.
    if (!settings.wf_ui_language && window.wfI18n && wfI18n.lang) {
        settings.wf_ui_language = wfI18n.lang;
    }
    return {
        format: BACKUP_FORMAT_VERSION,
        app: 'Wallsflow New Tab',
        version: (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })(),
        exported: new Date().toISOString(),
        settings,
    };
}

function exportSettingsToFile() {
    let url = null;
    try {
        const backup = buildSettingsBackup();
        const count = Object.keys(backup.settings).length;
        if (count === 0) {
            showPush(t('settings_toast_nothing_to_export'), 'warning');
            return;
        }
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wallsflow-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        showPush(t('settings_toast_exported', { count }), 'success');
    } catch (err) {
        console.error('Settings export failed', err);
        showPush(t('settings_toast_export_failed'), 'warning');
    } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

// Everything here is defensive on purpose: the file has been out of the
// extension's hands and may have been edited, truncated or swapped.
async function importSettingsFromFile(file) {
    if (!file) return;
    if (file.size > BACKUP_MAX_BYTES) {
        showPush(t('settings_toast_import_too_large'), 'warning');
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch (_) {
        showPush(t('settings_toast_import_not_json'), 'warning');
        return;
    }

    const incoming = parsed && typeof parsed === 'object' ? parsed.settings : null;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        showPush(t('settings_toast_import_not_backup'), 'warning');
        return;
    }

    // Filter against our own allowlist rather than trusting the file's keys.
    // A hand-edited backup must not be able to write playback coordination
    // state or wallpaper references — the two things that would break rather
    // than configure.
    let applied = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(incoming)) {
        if (!EXPORTABLE_KEYS.includes(key)) { skipped += 1; continue; }
        if (typeof value !== 'string') { skipped += 1; continue; }
        safeSet(key, value);
        applied += 1;
    }

    if (applied === 0) {
        showPush(t('settings_toast_import_nothing_applied'), 'warning');
        return;
    }

    // Reload rather than re-running each initializer by hand. Imported settings
    // reach widget visibility, shortcuts and the saved playlist library, and
    // missing one initializer would leave the page half-updated in a way the
    // user would read as a bug.
    // Three sentences, each with its own plural, rather than one sentence
    // holding two counts: that is the form every language can translate.
    const importedText = [
        t('settings_toast_imported', { count: applied }),
        skipped ? t('settings_toast_import_ignored', { count: skipped }) : '',
        t('common_reloading'),
    ].filter(Boolean).join(' ');
    showPush(importedText, 'success');
    // A backup that picks a language needs that language's catalogue in place
    // before the reload. If it cannot be fetched here, i18n.js builds it on the
    // reloaded page before showing anything.
    const importedLanguage = typeof incoming.wf_ui_language === 'string' ? incoming.wf_ui_language : '';
    const languageReady = importedLanguage && importedLanguage !== 'auto' && window.wfI18n
        ? wfI18n.preparePack(importedLanguage).catch(() => false)
        : Promise.resolve(true);
    languageReady.then(() => setTimeout(() => window.location.reload(), 900));
}

// The interface language. Auto follows the browser through chrome.i18n. A
// picked language is stored with its catalogue and the page reloads, because
// hundreds of strings are already drawn by the time anyone opens Settings.
function initializeLanguageSettings() {
    const select = document.getElementById('ui-language-select');
    if (!select || !window.wfI18n || select.dataset.wired === 'true') return;
    select.dataset.wired = 'true';

    const locales = Array.from(wfI18n.supported);
    const current = wfI18n.lang;

    // Each language is written in itself, so someone who cannot read the
    // current one can still find their own.
    for (const locale of locales) {
        const option = document.createElement('option');
        option.value = locale.code;
        option.lang = locale.code;
        option.setAttribute('translate', 'no');
        option.textContent = locale.native;
        select.appendChild(option);
    }
    select.value = current;

    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', async () => {
        const next = select.value;
        if (next === current) return;
        select.disabled = true;
        // The language the browser would start in anyway is not a choice to
        // store: picking it goes back to following the browser.
        const switched = await wfI18n.setLanguage(next === wfI18n.autoLang ? 'auto' : next);
        if (!switched) {
            select.disabled = false;
            select.value = current;
            showPush(t('settings_language_failed'), 'warning');
        }
    });
}

function initializeSettingsBackupControls() {
    const exportBtn = document.getElementById('settings-export-btn');
    const importBtn = document.getElementById('settings-import-btn');
    const fileInput = document.getElementById('settings-import-input');
    if (exportBtn) exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportSettingsToFile(); });
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            // Cleared so picking the same file twice in a row still fires.
            fileInput.value = '';
            importSettingsFromFile(file);
        });
    }
}

function initializeSettingsResetButton() {
    const resetBtn = document.getElementById('settings-reset-btn');
    if (!resetBtn) return;

    resetBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const shouldReset = await confirmSettingsReset();
        if (!shouldReset) return;

        safeSet(SHORTCUTS_OPEN_MODE_KEY, '_blank');
        safeSet(SHORTCUTS_OPEN_MODE_MUSIC_KEY, '_blank');
        safeSet(SEARCH_OPEN_MODE_KEY, '_blank');
        safeSet(SEARCH_OPEN_MODE_MUSIC_KEY, '_blank');
        safeRemove(STORAGE_KEYS.BOOKMARKS_OPEN_MODE);
        safeRemove(STORAGE_KEYS.BOOKMARKS_OPEN_MODE_MUSIC);
        safeRemove(DAILY_MESSAGE_NAME_KEY);
        safeRemove('wf_clock_format');
        safeRemove('wf_clock_seconds');
        safeRemove('wf_clock_date');
        safeRemove('wf_clock_size');
        safeRemove('wf_clock_font');
        safeRemove('wf_pomo_focus_min');
        safeRemove('wf_pomo_short_min');
        safeRemove('wf_pomo_long_min');
        safeRemove('wf_pomo_auto_start');
        safeRemove('wf_pomo_focus_mode');
        safeRemove('wf_pomo_focus_tasks');
        safeRemove('wf_weather_location');
        safeRemove('wf_weather_location_mode');
        // The °C/°F choice arrived with the units toggle and was never added
        // here, so a reset left the temperature in whatever unit had been
        // picked while claiming everything was back to defaults.
        safeRemove(STORAGE_KEYS.WEATHER_UNIT);
        safeRemove(BG_BLUR_KEY);
        safeRemove(BG_BRIGHTNESS_KEY);
        safeRemove(TEXT_SHADOW_KEY);
        safeRemove(TEXT_COLOR_KEY);
        safeRemove(STORAGE_KEYS.WALLPAPER_ROTATE_MINUTES);
        initializeShortcutBehaviorSettings();
        initializeBookmarksBehaviorSettings();
        initializeSearchBarSettings();
        initializeDailyMessageSettings();
        initializeClockSettings();
        initializeWeatherSettings();
        initializeBackgroundSettings();
        initializeTextAppearanceSettings();
        if (typeof window.wfRefreshWeather === 'function') window.wfRefreshWeather();
        if (typeof initializePomodoroSettings === 'function') initializePomodoroSettings();
        if (typeof initializeWallpaperRotationSettings === 'function') initializeWallpaperRotationSettings();
        if (typeof resetPomodoroTimer === 'function') resetPomodoroTimer();
        if (typeof updateClockWidget === 'function') updateClockWidget();
        if (typeof applyClockSize === 'function') applyClockSize();
        if (typeof applyClockFont === 'function') applyClockFont();
        applyBackgroundFilter();

        showPush(t('settings_toast_reset_done'), 'default');
    });
}

// Shared helper for "Are you sure?" confirmation modals. Both the Widgets
// and Settings reset flows had ~30 lines of identical wiring; this collapses
// them. Also fixes the Chrome a11y warning that fired when the modal closed
// with focus still on the confirm/cancel button: the modal was flipped back
// to aria-hidden="true" while the focused descendant remained inside it. We
// now move focus back to the trigger element BEFORE marking the modal hidden,
// which is also the better keyboard UX (user lands back on the Reset button).
function showConfirmModal(modalId, cancelId, confirmId, fallbackMessage) {
    const modal = document.getElementById(modalId);
    const cancelBtn = document.getElementById(cancelId);
    const confirmBtn = document.getElementById(confirmId);

    if (!modal || !cancelBtn || !confirmBtn) {
        return Promise.resolve(window.confirm(fallbackMessage));
    }

    // Remember who triggered the modal so focus can return there on close.
    // Grabbed before any focus changes from the modal opening.
    const triggerEl = document.activeElement;

    return new Promise((resolve) => {
        const closeModal = (result) => {
            // Move focus out of the modal subtree BEFORE flipping aria-hidden
            // back to "true". Otherwise the focused button sits inside an
            // aria-hidden ancestor and Chrome warns about hidden focus.
            if (modal.contains(document.activeElement)) {
                if (triggerEl && typeof triggerEl.focus === 'function') {
                    triggerEl.focus();
                } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
                    document.activeElement.blur();
                }
            }
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
            modal.removeEventListener('click', onBackdropClick);
            cancelBtn.removeEventListener('click', onCancel);
            confirmBtn.removeEventListener('click', onConfirm);
            document.removeEventListener('keydown', onKeyDown);
            resolve(result);
        };

        const onCancel = () => closeModal(false);
        const onConfirm = () => closeModal(true);
        const onBackdropClick = (event) => {
            if (event.target === modal) closeModal(false);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') closeModal(false);
        };

        cancelBtn.addEventListener('click', onCancel);
        confirmBtn.addEventListener('click', onConfirm);
        modal.addEventListener('click', onBackdropClick);
        document.addEventListener('keydown', onKeyDown);
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
    });
}

function confirmSettingsReset() {
    return showConfirmModal(
        'settings-reset-modal',
        'settings-reset-cancel',
        'settings-reset-confirm',
        t('modal_reset_confirm_fallback')
    );
}

function initializeWidgetsFilterHelp() {
    const helpContainer = document.getElementById('widgets-filter-help');
    if (!helpContainer) return;

    const helpBtn = helpContainer.querySelector('.widgets-filter-help-btn');
    const helpDropdown = helpContainer.querySelector('.widgets-filter-help-dropdown');
    if (!helpBtn || !helpDropdown) return;

    helpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = helpContainer.classList.contains('open');
        helpContainer.classList.toggle('open', !isOpen);
        helpBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });

    helpDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#widgets-filter-help')) {
            helpContainer.classList.remove('open');
            helpBtn.setAttribute('aria-expanded', 'false');
        }
    });
}

function initializeWidgetsFilterControls() {
    const filterButtons = document.querySelectorAll('.widgets-filter-btn');
    if (!filterButtons.length) return;

    for (const button of filterButtons) {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const filter = button.getAttribute('data-filter');
            if (!filter) return;

            currentWidgetsFilter = filter;
            updateWidgetsFilterButtons();
            applyCurrentWidgetsFilter();
        });
    }

    updateWidgetsFilterButtons();
}

function updateWidgetsFilterButtons() {
    const filterButtons = document.querySelectorAll('.widgets-filter-btn');
    for (const button of filterButtons) {
        const filter = button.getAttribute('data-filter');
        const isActive = filter === currentWidgetsFilter;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
}

// Hide a group whose every row was filtered out. Without this, switching to
// "Disabled" leaves headings standing over nothing — a heading that describes
// an empty space is worse than no heading, because it reads as a rendering bug.
function syncWidgetGroupVisibility() {
    for (const group of document.querySelectorAll('.widgets-group')) {
        const rows = group.querySelectorAll('.simple-widget-item');
        // The reset card shares the group's card styling but holds no widgets;
        // without this it would be judged empty and hidden on every filter.
        if (!rows.length) continue;
        const anyVisible = [...rows].some((r) => !r.classList.contains('filter-hidden'));
        group.classList.toggle('is-empty', !anyVisible);
    }
}

function applyCurrentWidgetsFilter() {
    const widgetItems = document.querySelectorAll('.simple-widget-item');
    if (!widgetItems.length) return;
    const emptyState = document.getElementById('widgets-empty-state');
    const counts = { all: 0, active: 0, hidden: 0 };
    let visibleCount = 0;

    for (const item of widgetItems) {
        const isActive = item.classList.contains('active');
        counts.all += 1;
        if (isActive) counts.active += 1;
        else counts.hidden += 1;

        const shouldHide =
            (currentWidgetsFilter === 'active' && !isActive) ||
            (currentWidgetsFilter === 'hidden' && isActive);

        item.classList.toggle('filter-hidden', shouldHide);
        if (!shouldHide) visibleCount += 1;
    }

    for (const btn of document.querySelectorAll('.widgets-filter-btn[data-filter]')) {
        const filter = btn.getAttribute('data-filter');
        const count = counts[filter] ?? 0;
        let countSpan = btn.querySelector('.filter-count');
        if (!countSpan) {
            countSpan = document.createElement('span');
            countSpan.className = 'filter-count';
            btn.appendChild(countSpan);
        }
        countSpan.textContent = count;
    }

    syncWidgetGroupVisibility();

    if (emptyState) {
        emptyState.classList.toggle('show', visibleCount === 0);
    }
}

async function initializeWidgetState(item, toggle, target) {
    const storageKeys = {
        search: 'searchHidden',
        shortcuts: 'shortcutsHidden',
        music: 'musicHidden',
        greeting: 'greetingHidden',
        clock: 'clockHidden',
        weather: 'weatherHidden',
        pomodoro: 'pomodoroHidden',
        bookmarks: 'bookmarksHidden',
        background: 'backgroundHidden',
        'wallpaper-schedule': 'wallpaperScheduleHidden',
        'video-playback': 'videoPlaybackEnabled'
    };

    const storageKey = storageKeys[target];
    if (!storageKey) return;

    let isActive;
    if (target === 'video-playback') {
        const videoEnabled = safeGet(storageKey);
        isActive = videoEnabled === null ? true : videoEnabled === 'true';
    } else {
        const isHidden = safeGet(storageKey) === 'true';
        isActive = !isHidden;
    }

    if (isActive) {
        item.classList.add('active');
        toggle.classList.add('active');
    } else {
        item.classList.remove('active');
        toggle.classList.remove('active');
    }
    if (target === 'wallpaper-schedule') {
        updateDayNightUiAvailability();
        return;
    }

    const targetElements = {
        search: document.getElementById('searchBar'),
        shortcuts: document.getElementById('shortcuts-container'),
        music: document.getElementById('music-widget'),
        greeting: document.getElementById('greeting-container'),
        clock: document.getElementById('clock-widget'),
        weather: document.getElementById('weather-widget'),
        pomodoro: document.getElementById('pomodoro-widget'),
        bookmarks: document.getElementById('bookmarks-widget'),
    };

    const element = targetElements[target];
    if (element) {
        if (isActive) {
            element.classList.remove('hidden-final');
            element.classList.remove('hide');
        } else {
            element.classList.add('hidden-final');
            element.classList.add('hide');
        }
    }
}

function updateToggleState(toggle, isActive) {
    if (isActive) {
        toggle.classList.add('active');
    } else {
        toggle.classList.remove('active');
    }
}

function handleWidgetToggle(target, isActive, options = {}) {
    const showNotification = options.showNotification !== false;

    if (target === 'wallpaper-schedule') {
        if (!saveSetting('wallpaperScheduleHidden', isActive ? 'false' : 'true')) return false;
        updateDayNightUiAvailability();
        updateVideo('SET_BUTTON');
        if (showNotification) {
            showPush(isActive ? t('widget_wallpaper_schedule_toast_enabled') : t('widget_wallpaper_schedule_toast_disabled'), isActive ? 'enabled' : 'disabled');
        }
        return;
    }

    if (target === 'background') {
        // The "Background" toggle has no DOM widget to show / hide — its
        // entire effect is the CSS filter on .bg video / .bg img driven
        // by --wf-bg-blur / --wf-bg-brightness. Toggling off forces the
        // filter to its no-op state without wiping the saved slider
        // values, so re-enabling restores the user's last setup.
        if (!saveSetting('backgroundHidden', isActive ? 'false' : 'true')) return false;
        if (typeof applyBackgroundFilter === 'function') applyBackgroundFilter();
        if (showNotification) {
            showPush(
                isActive ? t('widget_background_toast_enabled') : t('widget_background_toast_disabled'),
                isActive ? 'enabled' : 'disabled'
            );
        }
        return;
    }

    const configs = {
        search: {
            element: document.getElementById('searchBar'),
            storageKey: 'searchHidden',
            // Whole sentences per widget: a shared "{widget} enabled" would get
            // the grammatical gender wrong in languages that inflect the verb.
            toastOn: () => t('widget_search_toast_enabled'),
            toastOff: () => t('widget_search_toast_disabled'),
        },
        shortcuts: {
            element: document.getElementById('shortcuts-container'),
            storageKey: 'shortcutsHidden',
            toastOn: () => t('widget_shortcuts_toast_enabled'),
            toastOff: () => t('widget_shortcuts_toast_disabled'),
        },
        music: {
            element: document.getElementById('music-widget'),
            storageKey: 'musicHidden',
            toastOn: () => t('widget_music_toast_enabled'),
            toastOff: () => t('widget_music_toast_disabled'),
        },
        greeting: {
            element: document.getElementById('greeting-container'),
            storageKey: 'greetingHidden',
            toastOn: () => t('widget_greeting_toast_enabled'),
            toastOff: () => t('widget_greeting_toast_disabled'),
        },
        clock: {
            element: document.getElementById('clock-widget'),
            storageKey: 'clockHidden',
            toastOn: () => t('widget_clock_toast_enabled'),
            toastOff: () => t('widget_clock_toast_disabled'),
        },
        weather: {
            element: document.getElementById('weather-widget'),
            storageKey: 'weatherHidden',
            toastOn: () => t('widget_weather_toast_enabled'),
            toastOff: () => t('widget_weather_toast_disabled'),
        },
        pomodoro: {
            element: document.getElementById('pomodoro-widget'),
            storageKey: 'pomodoroHidden',
            toastOn: () => t('widget_pomodoro_toast_enabled'),
            toastOff: () => t('widget_pomodoro_toast_disabled'),
        },
        bookmarks: {
            element: document.getElementById('bookmarks-widget'),
            storageKey: 'bookmarksHidden',
            toastOn: () => t('widget_bookmarks_toast_enabled'),
            toastOff: () => t('widget_bookmarks_toast_disabled'),
        },
    };

    if (target === 'video-playback') {
        handleVideoPlaybackToggle(isActive, showNotification);
        return;
    }

    const config = configs[target];
    if (!config || !config.element) return;

    // Stored before anything on the page moves, so a refused write changes
    // nothing and the caller can leave the switch alone.
    if (!saveSetting(config.storageKey, isActive ? 'false' : 'true')) return false;

    if (isActive) {
        config.element.classList.remove('hidden-final');
        void config.element.offsetWidth;
        config.element.classList.remove('hide');
        config.element.classList.remove('auto-fade-out');
        if (target === 'greeting') {
            config.element.style.animation = 'none';
            void config.element.offsetWidth;
            config.element.style.animation = '';
        }

        if (showNotification) {
            showPush(config.toastOn(), 'enabled');
        }

        if (target === 'music' || target === 'bookmarks') {
            config.element.classList.remove('is-hidden');
        }
    } else {
        const hideImmediately = target === 'greeting';

        if (hideImmediately) {
            config.element.style.animation = 'none';
            config.element.classList.remove('auto-fade-out');
            config.element.classList.add('hide');
            config.element.classList.add('hidden-final');

            if (showNotification) {
                showPush(config.toastOff(), 'disabled');
            }
            return;
        }

        config.element.classList.add('hide');
        config.element.classList.remove('auto-fade-out');

        if (showNotification) {
            showPush(config.toastOff(), 'disabled');
        }

        if (target === 'music') {
            stopMusic();
            setTimeout(() => {
                config.element.classList.add('is-hidden');
            }, 500);
        } else if (target === 'bookmarks') {
            setTimeout(() => {
                config.element.classList.add('is-hidden');
            }, 500);
        } else {
            setTimeout(() => {
                config.element.classList.add('hidden-final');
            }, 500);
        }
    }
}

function initializeWidgetVisibility() {
    const configs = {
        search: {
            element: document.getElementById('searchBar'),
            storageKey: 'searchHidden'
        },
        shortcuts: {
            element: document.getElementById('shortcuts-container'),
            storageKey: 'shortcutsHidden'
        },
        music: {
            element: document.getElementById('music-widget'),
            storageKey: 'musicHidden'
        },
        greeting: {
            element: document.getElementById('greeting-container'),
            storageKey: 'greetingHidden'
        },
        clock: {
            element: document.getElementById('clock-widget'),
            storageKey: 'clockHidden'
        },
        weather: {
            element: document.getElementById('weather-widget'),
            storageKey: 'weatherHidden'
        },
        pomodoro: {
            element: document.getElementById('pomodoro-widget'),
            storageKey: 'pomodoroHidden'
        },
        bookmarks: {
            element: document.getElementById('bookmarks-widget'),
            storageKey: 'bookmarksHidden'
        },
    };

    Object.keys(configs).forEach(target => {
        const config = configs[target];
        if (!config || !config.element) return;

        const isHidden = safeGet(config.storageKey) === 'true';

        if (isHidden) {
            config.element.classList.add('hide');

            if (target === 'music' || target === 'bookmarks') {
                config.element.classList.add('is-hidden');
            } else {
                setTimeout(() => {
                    config.element.classList.add('hidden-final');
                }, 100);
            }
        } else {
            config.element.classList.remove('hide');
            config.element.classList.remove('hidden-final');

            if (target === 'music' || target === 'bookmarks') {
                config.element.classList.remove('is-hidden');
            }
        }
    });

    updateDayNightUiAvailability();
}

// ==============================
// BACKGROUND FILTER SETTINGS
// ==============================
// User-tunable blur + brightness on the wallpaper, wired up from the
// "Background" card in Settings. Persists two integers in localStorage
// (px and percent), reapplies them via CSS custom properties on :root
// so .bg video / .bg img inherit through the cascade. Defaults are
// no-op (blur 0, brightness 100%) so existing users see no change on
// the first load after this ships. Capped at 20 px blur to keep the
// per-frame GPU cost reasonable on video wallpapers.
const BG_BLUR_KEY = 'wf_bg_blur';
const BG_BRIGHTNESS_KEY = 'wf_bg_brightness';
const BG_BLUR_MAX = 20;
const BG_BLUR_DEFAULT = 0;
const BG_BRIGHTNESS_MIN = 40;
const BG_BRIGHTNESS_MAX = 100;
const BG_BRIGHTNESS_DEFAULT = 100;

function applyBackgroundFilter() {
    // Widget toggle off → neutral filter regardless of stored slider values.
    // The slider values stay in localStorage so re-enabling restores the
    // user's last-saved blur/brightness without forcing them to redrag.
    const isHidden = safeGet('backgroundHidden') === 'true';
    let blur, brightness;
    if (isHidden) {
        blur = 0;
        brightness = 100;
    } else {
        const blurRaw = parseInt(safeGet(BG_BLUR_KEY) || String(BG_BLUR_DEFAULT), 10);
        const brightnessRaw = parseInt(safeGet(BG_BRIGHTNESS_KEY) || String(BG_BRIGHTNESS_DEFAULT), 10);
        blur = Math.max(0, Math.min(BG_BLUR_MAX, Number.isFinite(blurRaw) ? blurRaw : BG_BLUR_DEFAULT));
        brightness = Math.max(
            BG_BRIGHTNESS_MIN,
            Math.min(BG_BRIGHTNESS_MAX, Number.isFinite(brightnessRaw) ? brightnessRaw : BG_BRIGHTNESS_DEFAULT)
        );
    }
    document.documentElement.style.setProperty('--wf-bg-blur', blur + 'px');
    document.documentElement.style.setProperty('--wf-bg-brightness', brightness + '%');
}

// Apply at module-load time (defer scripts run after the DOM is
// parsed, so document.documentElement exists). The CSS rule that
// reads the variables targets .bg video / .bg img via the cascade,
// so when wallpaper.js inserts the wallpaper element later, the
// filter is already in place.
applyBackgroundFilter();

function _paintBgSliderFill(slider, min, max) {
    if (!slider) return;
    const v = parseInt(slider.value, 10);
    const lo = parseInt(min, 10);
    const hi = parseInt(max, 10);
    const pct = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    slider.style.setProperty('--slider-pct', pct + '%');
}

const TEXT_SHADOW_KEY = 'wf_text_shadow';
const TEXT_COLOR_KEY = 'wf_text_color';
const TEXT_SHADOW_DEFAULT = 45;
const TEXT_COLOR_DEFAULT = '#ffffff';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Page text sits on top of whatever image the user chose, and a bright photo
// swallows white text. Until now the only remedy was the Brightness slider,
// which buys legibility by damaging the wallpaper. These two change the text
// instead. The shadow scales the alpha those elements already carried rather
// than replacing their geometry, so at the default nothing looks different.
function applyTextAppearance() {
    const rawShadow = parseInt(safeGet(TEXT_SHADOW_KEY) ?? String(TEXT_SHADOW_DEFAULT), 10);
    const shadow = Number.isFinite(rawShadow) ? Math.min(100, Math.max(0, rawShadow)) : TEXT_SHADOW_DEFAULT;
    const stored = safeGet(TEXT_COLOR_KEY);
    // Anything that is not a plain hex colour is ignored rather than written
    // into a style rule — this value can arrive from an imported backup.
    const color = HEX_COLOR.test(stored || '') ? stored : TEXT_COLOR_DEFAULT;
    const root = document.documentElement;
    root.style.setProperty('--wf-text-shadow-alpha', String(shadow / 100));
    root.style.setProperty('--wf-text-color', color);
}

function initializeTextAppearanceSettings() {
    applyTextAppearance();

    const shadowSlider = document.getElementById('text-shadow-slider');
    if (shadowSlider) {
        const stored = parseInt(safeGet(TEXT_SHADOW_KEY) ?? String(TEXT_SHADOW_DEFAULT), 10);
        shadowSlider.value = String(Number.isFinite(stored) ? stored : TEXT_SHADOW_DEFAULT);
        // The filled portion of the track is painted from a CSS variable, not by
        // the browser — the other two sliders set it and this one did not, so it
        // sat visually empty however far it was dragged.
        _paintBgSliderFill(shadowSlider, 0, 100);
        let timer = null;
        shadowSlider.addEventListener('input', () => {
            saveSetting(TEXT_SHADOW_KEY, shadowSlider.value);
            _paintBgSliderFill(shadowSlider, 0, 100);
            applyTextAppearance();
            // Same debounce as the other sliders: dragging fires continuously,
            // and one toast per pixel would be unusable.
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                announceSettingChange(shadowSlider, `${shadowSlider.value}%`);
                timer = null;
            }, 500);
        });
    }

    const colorInput = document.getElementById('text-color-input');
    if (colorInput) {
        const stored = safeGet(TEXT_COLOR_KEY);
        colorInput.value = HEX_COLOR.test(stored || '') ? stored : TEXT_COLOR_DEFAULT;
        let timer = null;
        colorInput.addEventListener('input', () => {
            saveSetting(TEXT_COLOR_KEY, colorInput.value);
            applyTextAppearance();
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                announceSettingChange(colorInput, colorInput.value);
                timer = null;
            }, 500);
        });
    }
}

function initializeBackgroundSettings() {
    // The rotation interval moved in here with the rest of the background
    // settings; wallpaper.js owns its behaviour, this only makes sure it is
    // wired whichever panel the user opens first.
    if (typeof initializeWallpaperRotationSettings === 'function') initializeWallpaperRotationSettings();
    const blurSlider = document.getElementById('bg-blur-slider');
    const brightnessSlider = document.getElementById('bg-brightness-slider');
    if (!blurSlider || !brightnessSlider) return;

    // Restore from storage
    const storedBlur = safeGet(BG_BLUR_KEY);
    const storedBrightness = safeGet(BG_BRIGHTNESS_KEY);
    blurSlider.value = storedBlur !== null ? storedBlur : String(BG_BLUR_DEFAULT);
    brightnessSlider.value = storedBrightness !== null ? storedBrightness : String(BG_BRIGHTNESS_DEFAULT);
    _paintBgSliderFill(blurSlider, 0, BG_BLUR_MAX);
    _paintBgSliderFill(brightnessSlider, BG_BRIGHTNESS_MIN, BG_BRIGHTNESS_MAX);
    applyBackgroundFilter();

    // dataset.initialized guard so reopening the settings panel doesn't
    // stack listeners on the same input. Same pattern used by the other
    // settings init helpers in this file.
    if (blurSlider.dataset.initialized === 'true') return;
    blurSlider.dataset.initialized = 'true';
    brightnessSlider.dataset.initialized = 'true';

    // `input` fires continuously while dragging — debounce the toast so a single
    // drag produces one message once the user settles, not sixty.
    const announceBlur = debounce(() => announceSettingChange(blurSlider, blurSlider.value), 500);
    const announceBrightness = debounce(
        () => announceSettingChange(brightnessSlider, `${brightnessSlider.value}%`),
        500
    );

    blurSlider.addEventListener('input', () => {
        saveSetting(BG_BLUR_KEY, blurSlider.value);
        _paintBgSliderFill(blurSlider, 0, BG_BLUR_MAX);
        applyBackgroundFilter();
        announceBlur();
    });
    brightnessSlider.addEventListener('input', () => {
        saveSetting(BG_BRIGHTNESS_KEY, brightnessSlider.value);
        _paintBgSliderFill(brightnessSlider, BG_BRIGHTNESS_MIN, BG_BRIGHTNESS_MAX);
        applyBackgroundFilter();
        announceBrightness();
    });
}

// ==============================
// WIDGET INIT — DOMContentLoaded bootstrap
// ==============================

document.addEventListener('DOMContentLoaded', function() {
    initVideoPlaybackState();

    const wallpapersBtn = document.getElementById('wallpapers-btn');
    const widgetsBtn = document.getElementById('widgets-btn');
    const settingsBtn = document.getElementById('settings-btn');

    const wallpapersSection = document.getElementById('wallpapers-section');
    const widgetsSection = document.getElementById('widgets-section');
    const settingsSection = document.getElementById('settings-section');

    if (wallpapersBtn && widgetsBtn && settingsBtn && wallpapersSection && widgetsSection && settingsSection) {
        const sectionMap = {
            wallpapers: { btn: wallpapersBtn, section: wallpapersSection },
            widgets: { btn: widgetsBtn, section: widgetsSection },
            settings: { btn: settingsBtn, section: settingsSection }
        };

        // Was assigned to `window.activateManagementSection` — only consumed
        // by the three listeners below in this same file. Made local.
        const activateManagementSection = (sectionName) => {
            Object.entries(sectionMap).forEach(([name, obj]) => {
                const isTarget = name === sectionName;
                obj.btn.classList.toggle('active', isTarget);
                obj.section.classList.toggle('active', isTarget);
            });
        };

        wallpapersBtn.addEventListener('click', () => activateManagementSection('wallpapers'));
        widgetsBtn.addEventListener('click', () => {
            activateManagementSection('widgets');
            maybeShowWidgetOptionsHint();
        });
        settingsBtn.addEventListener('click', () => activateManagementSection('settings'));

        initializeWidgetOptionDisclosures();
        initializeSettingsBackupControls();
        initializeLanguageSettings();
        initializeWallpaperFilterControls();
        initializeDailyMessageSettings();
        initializeShortcutBehaviorSettings();
        initializeBookmarksBehaviorSettings();
        initializeSearchBarSettings();
        initializeClockSettings();
        initializeWeatherSettings();
        initializeBackgroundSettings();
        initializeTextAppearanceSettings();
        if (typeof initializePomodoroSettings === 'function') initializePomodoroSettings();
        if (typeof initializeBookmarksWidget === 'function') initializeBookmarksWidget();
        if (typeof initializeTasksWidget === 'function') initializeTasksWidget();
        initializeWidgetHelpDropdowns();
        initializeWidgetsFilterHelp();
        initializeWidgetsFilterControls();
        initializeSettingsResetButton();
        initializeTasksSettings();

        initializeWidgetToggles().then(() => {
            initializeWidgetVisibility();
        });
    }
});
