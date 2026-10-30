// ==============================
// WEATHER WIDGET (IIFE — self-contained)
// ==============================
(function () {
    const WEATHER_HIDDEN_KEY = STORAGE_KEYS.WEATHER_HIDDEN;
    const WEATHER_CACHE_KEY = STORAGE_KEYS.WEATHER_CACHE;
    const WEATHER_LOCATION_KEY = STORAGE_KEYS.WEATHER_LOCATION;
    const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

    // Open-Meteo can return Fahrenheit directly, but we deliberately always
    // fetch and cache metric and convert at render time. Two reasons: the unit
    // toggle becomes instant (no refetch, no waiting on the network), and a
    // cache written under one unit can never be rendered under the other —
    // which is exactly the bug you get when the unit lives in the request.
    // Uses the shared resolver so an untouched install still shows °F in the
    // US — reading WEATHER_UNIT_KEY directly would report metric until the
    // settings panel happened to write a value.
    function isImperial() {
        return getWeatherUnit() === 'imperial';
    }

    function formatTemperature(celsius) {
        const value = isImperial() ? (celsius * 9 / 5) + 32 : celsius;
        return `${Math.round(value)}\u00B0${isImperial() ? 'F' : 'C'}`;
    }

    // Wind arrives in km/h. Only the *label* switches to mph — the gust
    // threshold in getWeatherState() stays on the canonical km/h value so the
    // "windy" condition triggers at the same real-world wind speed either way.
    function formatWind(kmh) {
        return isImperial()
            ? `${Math.round(kmh * 0.621371)} mph`
            : `${Math.round(kmh)} km/h`;
    }

    const widget = document.getElementById('weather-widget');
    const tempEl = document.getElementById('weather-temp');
    const iconEl = document.getElementById('weather-icon');
    const cityEl = document.getElementById('weather-city');

    if (!widget || !tempEl || !iconEl || !cityEl) return;

    let refreshTimer = null;
    // One-shot timer used on boot when the cached reading is still fresh — it
    // fires at the moment that reading expires, then hands off to refreshTimer.
    let firstRefreshTimer = null;
    let busy = false;
    // Current weather condition key ('clear' | 'partly-cloudy' | 'cloudy' |
    // 'rain' | 'snow' | 'storm' | 'fog' | 'windy') exposed to the rest of
    // the page so the greeting widget can pick a context-aware subtitle
    // ("Rainy morning — take it slow.", etc). Null until the first
    // successful render. Other modules read it via the global getter
    // and listen for the 'wf:weather-changed' event below to refresh
    // when the value updates after page load.
    let _currentWeatherCondition = null;
    window.wfGetWeatherCondition = function () { return _currentWeatherCondition; };

    // Hoisted out of getCoordsFromTimezone — the original re-allocated this
    // 100+ entry object on every call (twice on each refresh: once in
    // getResolvedCoords, once in the manual-location settings UI). Keeping it
    // module-scoped makes lookup O(1) without per-call allocation. The same
    // applies to TIMEZONE_REGION_DEFAULTS used as a fallback.
    const TIMEZONE_COORDS_MAP = {
        'Europe/Bucharest': { lat: 44.4268, lon: 26.1025 },
        'Europe/London': { lat: 51.5072, lon: -0.1276 },
        'Europe/Paris': { lat: 48.8566, lon: 2.3522 },
        'Europe/Berlin': { lat: 52.52, lon: 13.405 },
        'Europe/Madrid': { lat: 40.4168, lon: -3.7038 },
        'Europe/Rome': { lat: 41.9028, lon: 12.4964 },
        'Europe/Amsterdam': { lat: 52.3676, lon: 4.9041 },
        'Europe/Brussels': { lat: 50.8503, lon: 4.3517 },
        'Europe/Vienna': { lat: 48.2082, lon: 16.3738 },
        'Europe/Zurich': { lat: 47.3769, lon: 8.5417 },
        'Europe/Stockholm': { lat: 59.3293, lon: 18.0686 },
        'Europe/Oslo': { lat: 59.9139, lon: 10.7522 },
        'Europe/Copenhagen': { lat: 55.6761, lon: 12.5683 },
        'Europe/Helsinki': { lat: 60.1699, lon: 24.9384 },
        'Europe/Warsaw': { lat: 52.2297, lon: 21.0122 },
        'Europe/Prague': { lat: 50.0755, lon: 14.4378 },
        'Europe/Budapest': { lat: 47.4979, lon: 19.0402 },
        'Europe/Athens': { lat: 37.9838, lon: 23.7275 },
        'Europe/Lisbon': { lat: 38.7169, lon: -9.1395 },
        'Europe/Dublin': { lat: 53.3498, lon: -6.2603 },
        'Europe/Kiev': { lat: 50.4501, lon: 30.5234 },
        'Europe/Moscow': { lat: 55.7558, lon: 37.6173 },
        'Europe/Istanbul': { lat: 41.0082, lon: 28.9784 },
        'Europe/Sofia': { lat: 42.6977, lon: 23.3219 },
        'Europe/Belgrade': { lat: 44.7866, lon: 20.4489 },
        'Europe/Zagreb': { lat: 45.8150, lon: 15.9819 },
        'Europe/Bratislava': { lat: 48.1486, lon: 17.1077 },
        'Europe/Tallinn': { lat: 59.4370, lon: 24.7536 },
        'Europe/Riga': { lat: 56.9496, lon: 24.1052 },
        'Europe/Vilnius': { lat: 54.6872, lon: 25.2797 },
        'Europe/Minsk': { lat: 53.9045, lon: 27.5615 },
        'Europe/Sarajevo': { lat: 43.8563, lon: 18.4131 },
        'Europe/Skopje': { lat: 41.9981, lon: 21.4254 },
        'Europe/Tirane': { lat: 41.3317, lon: 19.8319 },
        'Europe/Chisinau': { lat: 47.0105, lon: 28.8638 },
        'Europe/Luxembourg': { lat: 49.6116, lon: 6.1319 },
        'Europe/Malta': { lat: 35.8997, lon: 14.5147 },
        'Europe/Nicosia': { lat: 35.1856, lon: 33.3823 },
        'Europe/Podgorica': { lat: 42.4304, lon: 19.2594 },
        'America/New_York': { lat: 40.7128, lon: -74.0060 },
        'America/Chicago': { lat: 41.8781, lon: -87.6298 },
        'America/Denver': { lat: 39.7392, lon: -104.9903 },
        'America/Los_Angeles': { lat: 34.0522, lon: -118.2437 },
        'America/Phoenix': { lat: 33.4484, lon: -112.0740 },
        'America/Anchorage': { lat: 61.2181, lon: -149.9003 },
        'America/Honolulu': { lat: 21.3069, lon: -157.8583 },
        'America/Toronto': { lat: 43.6510, lon: -79.3470 },
        'America/Vancouver': { lat: 49.2827, lon: -123.1207 },
        'America/Montreal': { lat: 45.5017, lon: -73.5673 },
        'America/Sao_Paulo': { lat: -23.5505, lon: -46.6333 },
        'America/Buenos_Aires': { lat: -34.6037, lon: -58.3816 },
        'America/Lima': { lat: -12.0464, lon: -77.0428 },
        'America/Bogota': { lat: 4.7110, lon: -74.0721 },
        'America/Santiago': { lat: -33.4489, lon: -70.6693 },
        'America/Mexico_City': { lat: 19.4326, lon: -99.1332 },
        'America/Caracas': { lat: 10.4806, lon: -66.9036 },
        'America/Montevideo': { lat: -34.9011, lon: -56.1645 },
        'Asia/Tokyo': { lat: 35.6762, lon: 139.6503 },
        'Asia/Shanghai': { lat: 31.2304, lon: 121.4737 },
        'Asia/Beijing': { lat: 39.9042, lon: 116.4074 },
        'Asia/Hong_Kong': { lat: 22.3193, lon: 114.1694 },
        'Asia/Singapore': { lat: 1.3521, lon: 103.8198 },
        'Asia/Seoul': { lat: 37.5665, lon: 126.9780 },
        'Asia/Kolkata': { lat: 22.5726, lon: 88.3639 },
        'Asia/Dubai': { lat: 25.2048, lon: 55.2708 },
        'Asia/Bangkok': { lat: 13.7563, lon: 100.5018 },
        'Asia/Jakarta': { lat: -6.2088, lon: 106.8456 },
        'Asia/Karachi': { lat: 24.8607, lon: 67.0011 },
        'Asia/Riyadh': { lat: 24.7136, lon: 46.6753 },
        'Asia/Tehran': { lat: 35.6892, lon: 51.3890 },
        'Asia/Baghdad': { lat: 33.3152, lon: 44.3661 },
        'Asia/Kabul': { lat: 34.5553, lon: 69.2075 },
        'Asia/Tashkent': { lat: 41.2995, lon: 69.2401 },
        'Asia/Almaty': { lat: 43.2220, lon: 76.8512 },
        'Asia/Dhaka': { lat: 23.8103, lon: 90.4125 },
        'Asia/Yangon': { lat: 16.8661, lon: 96.1951 },
        'Asia/Ho_Chi_Minh': { lat: 10.8231, lon: 106.6297 },
        'Asia/Manila': { lat: 14.5995, lon: 120.9842 },
        'Asia/Taipei': { lat: 25.0330, lon: 121.5654 },
        'Asia/Kuala_Lumpur': { lat: 3.1390, lon: 101.6869 },
        'Asia/Colombo': { lat: 6.9271, lon: 79.8612 },
        'Asia/Kathmandu': { lat: 27.7172, lon: 85.3240 },
        'Asia/Yerevan': { lat: 40.1872, lon: 44.5152 },
        'Asia/Tbilisi': { lat: 41.6938, lon: 44.8015 },
        'Asia/Baku': { lat: 40.4093, lon: 49.8671 },
        'Asia/Beirut': { lat: 33.8938, lon: 35.5018 },
        'Asia/Jerusalem': { lat: 31.7683, lon: 35.2137 },
        'Asia/Amman': { lat: 31.9454, lon: 35.9284 },
        'Asia/Kuwait': { lat: 29.3759, lon: 47.9774 },
        'Asia/Muscat': { lat: 23.5880, lon: 58.3829 },
        'Asia/Nicosia': { lat: 35.1856, lon: 33.3823 },
        'Africa/Cairo': { lat: 30.0444, lon: 31.2357 },
        'Africa/Johannesburg': { lat: -26.2041, lon: 28.0473 },
        'Africa/Lagos': { lat: 6.5244, lon: 3.3792 },
        'Africa/Nairobi': { lat: -1.2921, lon: 36.8219 },
        'Africa/Casablanca': { lat: 33.5731, lon: -7.5898 },
        'Africa/Algiers': { lat: 36.7372, lon: 3.0865 },
        'Africa/Accra': { lat: 5.6037, lon: -0.1870 },
        'Africa/Tunis': { lat: 36.8190, lon: 10.1658 },
        'Africa/Tripoli': { lat: 32.8872, lon: 13.1913 },
        'Africa/Khartoum': { lat: 15.5007, lon: 32.5599 },
        'Africa/Addis_Ababa': { lat: 9.1450, lon: 40.4897 },
        'Africa/Dar_es_Salaam': { lat: -6.7924, lon: 39.2083 },
        'Africa/Lusaka': { lat: -15.4166, lon: 28.2833 },
        'Africa/Harare': { lat: -17.8292, lon: 31.0522 },
        'Africa/Maputo': { lat: -25.9692, lon: 32.5732 },
        'Australia/Sydney': { lat: -33.8688, lon: 151.2093 },
        'Australia/Melbourne': { lat: -37.8136, lon: 144.9631 },
        'Australia/Brisbane': { lat: -27.4698, lon: 153.0251 },
        'Australia/Perth': { lat: -31.9505, lon: 115.8605 },
        'Australia/Adelaide': { lat: -34.9285, lon: 138.6007 },
        'Pacific/Auckland': { lat: -36.8509, lon: 174.7645 },
        'Pacific/Honolulu': { lat: 21.3069, lon: -157.8583 },
        'Pacific/Fiji': { lat: -18.1416, lon: 178.4419 },
    };
    const TIMEZONE_REGION_DEFAULTS = {
        'Europe': { lat: 48.8566, lon: 2.3522 },
        'America': { lat: 40.7128, lon: -74.0060 },
        'Asia': { lat: 35.6762, lon: 139.6503 },
        'Africa': { lat: 30.0444, lon: 31.2357 },
        'Australia': { lat: -33.8688, lon: 151.2093 },
        'Pacific': { lat: -36.8509, lon: 174.7645 },
        'Atlantic': { lat: 38.7169, lon: -9.1395 },
        'Indian': { lat: -20.1654, lon: 57.4896 },
    };

    // Returns saved manual location { name, lat, lon, country } or null if auto-detect
    function getManualLocation() {
        try {
            const raw = safeGet(WEATHER_LOCATION_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
            return null;
        } catch (_) { return null; }
    }

    function getResolvedCoords() {
        const manual = getManualLocation();
        if (manual) return { lat: manual.lat, lon: manual.lon, label: manual.name };
        const coords = getCoordsFromTimezone();
        return { lat: coords.lat, lon: coords.lon, label: getCityFromTimezone() };
    }

    // The detected city, in the interface's language once the shared lookup
    // in notifications.js has it, English from the timezone until then. The
    // settings panel shows the same name through the same helper.
    function getCityFromTimezone() {
        return (typeof wfDetectedCityName === 'function' && wfDetectedCityName()) || t('widget_weather_unknown_city');
    }

    // Repaint the label when the localized name arrives. A city picked by
    // hand keeps the name it was picked with.
    document.addEventListener('wf:city-name', () => {
        if (!getManualLocation()) cityEl.textContent = getResolvedCoords().label || '';
    });
    if (typeof wfLocalizeDetectedCity === 'function') wfLocalizeDetectedCity();

    // Repaint in the newly chosen unit without touching the network. Falls back
    // to the cache when this tab hasn't painted yet (widget hidden on boot).
    window.wfApplyWeatherUnit = function () {
        const payload = _lastRenderedPayload || readCache();
        if (payload) {
            render(payload);
        } else if (tempEl.textContent.startsWith('--')) {
            tempEl.textContent = `--\u00B0${isImperial() ? 'F' : 'C'}`;
        }
    };

    // Expose for the settings UI to refresh weather right after location change.
    // Deliberately bypasses the cache-age check in scheduleRefreshes() — the
    // user just picked a different city, so the cached reading is for the wrong
    // place regardless of how fresh it is. Clearing timers first drops any
    // pending one-shot still aimed at the previous location's expiry time.
    //
    // Note: this resets the cadence rather than calling scheduleRefreshes()
    // after the fetch. Rescheduling on completion would re-enter the "cache is
    // stale → fetch now" branch on every failure, turning a network outage into
    // a tight retry loop.
    window.wfRefreshWeather = function() {
        clearTimers();
        refreshWeather();
        refreshTimer = setInterval(refreshWeather, REFRESH_INTERVAL_MS);
    };

    // Memoized: the resolved timezone is stable for the lifetime of the tab
    // (a user can't change OS timezone without browser restart on Chrome
    // anyway). Caching avoids the Intl.DateTimeFormat() construction + map
    // lookup on every refresh cycle and on every settings panel render.
    let _cachedTimezoneCoords = null;
    function getCoordsFromTimezone() {
        if (_cachedTimezoneCoords) return _cachedTimezoneCoords;
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        let coords = TIMEZONE_COORDS_MAP[tz];
        if (!coords) {
            const region = tz.split('/')[0];
            coords = TIMEZONE_REGION_DEFAULTS[region] || { lat: 48.8566, lon: 2.3522 };
        }
        _cachedTimezoneCoords = coords;
        return coords;
    }

    // Inline SVG icons keyed by condition. Filled, two-tone (gray cloud +
    // amber sun + blue raindrops) so they read clearly over any wallpaper
    // without needing extra image assets. Each is a self-contained 36\u00D736
    // viewBox so the parent .weather-icon controls the rendered size.
    const ICON_SVG = {
        'clear': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="18" cy="18" r="7" fill="#fbbf24"/><g class="wfx-rays-lg" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="3" x2="18" y2="6.5"/><line x1="18" y1="29.5" x2="18" y2="33"/><line x1="3" y1="18" x2="6.5" y2="18"/><line x1="29.5" y1="18" x2="33" y2="18"/><line x1="7.5" y1="7.5" x2="10" y2="10"/><line x1="26" y1="26" x2="28.5" y2="28.5"/><line x1="7.5" y1="28.5" x2="10" y2="26"/><line x1="28.5" y1="7.5" x2="26" y2="10"/></g></svg>`,
        'partly-cloudy': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><line x1="11" y1="2.5" x2="11" y2="5"/><line x1="2.5" y1="11" x2="5" y2="11"/><line x1="4.5" y1="4.5" x2="6.3" y2="6.3"/><line x1="17.5" y1="4.5" x2="15.7" y2="6.3"/></g><circle cx="11" cy="11" r="4.5" fill="#fbbf24"/><path class="wfx-cloud-drift" d="M 8 28 H 28 A 4 4 0 0 0 29 19.5 A 5.5 5.5 0 0 0 18.5 17 A 4.5 4.5 0 0 0 10.5 19 A 4.5 4.5 0 0 0 8 28 Z" fill="#cbd5e1"/></svg>`,
        'cloudy': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path class="wfx-cloud-drift" d="M 5 26 H 29 A 4.5 4.5 0 0 0 30 16 A 6.5 6.5 0 0 0 17.5 13 A 5 5 0 0 0 8.5 15.5 A 5 5 0 0 0 5 26 Z" fill="#cbd5e1"/></svg>`,
        'rain': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 5 22 H 29 A 4.5 4.5 0 0 0 30 12 A 6.5 6.5 0 0 0 17.5 9 A 5 5 0 0 0 8.5 11.5 A 5 5 0 0 0 5 22 Z" fill="#cbd5e1"/><g fill="#60a5fa"><path class="wfx-drop wfx-drop-1" d="M 11 25 q -1.4 2.5 -1.4 4 a 1.4 1.4 0 0 0 2.8 0 q 0 -1.5 -1.4 -4 z"/><path class="wfx-drop wfx-drop-2" d="M 18 26 q -1.4 2.5 -1.4 4 a 1.4 1.4 0 0 0 2.8 0 q 0 -1.5 -1.4 -4 z"/><path class="wfx-drop wfx-drop-3" d="M 25 25 q -1.4 2.5 -1.4 4 a 1.4 1.4 0 0 0 2.8 0 q 0 -1.5 -1.4 -4 z"/></g></svg>`,
        'snow': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 5 22 H 29 A 4.5 4.5 0 0 0 30 12 A 6.5 6.5 0 0 0 17.5 9 A 5 5 0 0 0 8.5 11.5 A 5 5 0 0 0 5 22 Z" fill="#cbd5e1"/><g fill="#ffffff"><circle class="wfx-flake wfx-flake-1" cx="11" cy="28" r="1.4"/><circle class="wfx-flake wfx-flake-2" cx="18" cy="30" r="1.4"/><circle class="wfx-flake wfx-flake-3" cx="25" cy="28" r="1.4"/></g></svg>`,
        'storm': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 5 22 H 29 A 4.5 4.5 0 0 0 30 12 A 6.5 6.5 0 0 0 17.5 9 A 5 5 0 0 0 8.5 11.5 A 5 5 0 0 0 5 22 Z" fill="#94a3b8"/><path class="wfx-bolt" d="M 19 22 L 14 31 H 18 L 16 34 L 23 24 H 19 L 20.5 22 Z" fill="#fbbf24"/></svg>`,
        'fog': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><g class="wfx-fog" stroke="#cbd5e1" stroke-width="3" stroke-linecap="round"><line x1="6" y1="13" x2="30" y2="13"/><line x1="9" y1="20" x2="27" y2="20"/><line x1="6" y1="27" x2="30" y2="27"/></g></svg>`,
        'windy': `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><g class="wfx-wind" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" fill="none"><path d="M 5 12 H 22 a 3.5 3.5 0 1 0 -3.5 -3.5"/><path d="M 5 19 H 28 a 4 4 0 1 0 -4 -4"/><path d="M 5 26 H 18 a 3 3 0 1 0 -3 -3"/></g></svg>`,
    };

    function getWeatherState(code, windSpeed) {
        const c = Number(code);
        const wind = Number(windSpeed) || 0;

        if (wind >= 35) return { key: 'windy', label: t('weather_windy', { speed: formatWind(wind) }), svg: ICON_SVG['windy'] };
        if ([95, 96, 99].includes(c)) return { key: 'storm', label: t('weather_storm'), svg: ICON_SVG['storm'] };
        if ([71, 73, 75, 77, 85, 86].includes(c)) return { key: 'snow', label: t('weather_snow'), svg: ICON_SVG['snow'] };
        if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return { key: 'rain', label: t('weather_rain'), svg: ICON_SVG['rain'] };
        if ([45, 48].includes(c)) return { key: 'fog', label: t('weather_fog'), svg: ICON_SVG['fog'] };
        if (c === 3) return { key: 'cloudy', label: t('weather_cloudy'), svg: ICON_SVG['cloudy'] };
        if ([1, 2].includes(c)) return { key: 'partly-cloudy', label: t('weather_partly_cloudy'), svg: ICON_SVG['partly-cloudy'] };
        if (c === 0) return { key: 'clear', label: t('weather_clear'), svg: ICON_SVG['clear'] };
        return { key: 'partly-cloudy', label: t('weather_mild'), svg: ICON_SVG['partly-cloudy'] };
    }

    async function fetchJson(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error('Request failed');
            return response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function fetchWeather(lat, lon) {
        const params = new URLSearchParams({
            latitude: String(lat),
            longitude: String(lon),
            timezone: 'auto',
            current: 'temperature_2m,weather_code,wind_speed_10m'
        });
        const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
        return fetchJson(url);
    }

    function writeCache(payload) {
        safeSet(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), data: payload }));
    }

    // Returns the full cache envelope { at, data } so callers that care about
    // freshness can check the timestamp. writeCache() has always stamped `at`,
    // but nothing read it — every new tab fired a live request regardless of
    // how recent the cached reading was.
    function readCacheEntry() {
        try {
            const cached = JSON.parse(safeGet(WEATHER_CACHE_KEY) || 'null');
            if (!cached?.data) return null;
            return cached;
        } catch (_) {
            return null;
        }
    }

    // Age-agnostic accessor used by the network-failure fallback, where a stale
    // reading still beats showing "--°C".
    function readCache() {
        const entry = readCacheEntry();
        return entry ? entry.data : null;
    }

    // Last payload actually painted, kept so a unit change can repaint from
    // memory instead of going back to the network or re-parsing the cache.
    let _lastRenderedPayload = null;

    function render(payload) {
        const current = payload?.current;
        if (!current) return;

        _lastRenderedPayload = payload;

        const wind = Math.round(current.wind_speed_10m || 0);
        const state = getWeatherState(current.weather_code, wind);

        iconEl.innerHTML = state.svg;
        iconEl.title = state.label;
        // The condition was computed on every refresh and then spent on a
        // tooltip nobody hovers on a new tab. It says more than the city does:
        // "Partly cloudy" or "Windy 40 km/h" is the thing you actually wanted
        // to know before stepping outside.
        const condEl = document.getElementById('weather-cond');
        if (condEl) condEl.textContent = state.label || '';
        tempEl.textContent = formatTemperature(current.temperature_2m);
        cityEl.textContent = getResolvedCoords().label || '';

        // Notify other modules (currently the greeting widget) when the
        // condition changes \u2014 only fire when the key actually flipped to
        // avoid pointless work on the 30-min refresh tick.
        if (_currentWeatherCondition !== state.key) {
            _currentWeatherCondition = state.key;
            try {
                document.dispatchEvent(new CustomEvent('wf:weather-changed', {
                    detail: { condition: state.key }
                }));
            } catch (_) { /* CustomEvent unavailable \u2014 non-fatal */ }
        }
    }

    async function refreshWeather() {
        if (busy) return;
        busy = true;

        try {
            const coords = getResolvedCoords();
            const payload = await fetchWeather(coords.lat, coords.lon);
            writeCache(payload);
            render(payload);
        } catch (_) {
            const cached = readCache();
            if (cached) {
                render(cached);
            } else {
                tempEl.textContent = `--\u00B0${isImperial() ? 'F' : 'C'}`;
                cityEl.textContent = t('weather_unavailable');
                iconEl.innerHTML = '';
                iconEl.removeAttribute('title');
            }
        } finally {
            busy = false;
        }
    }

    function clearTimers() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        if (firstRefreshTimer) { clearTimeout(firstRefreshTimer); firstRefreshTimer = null; }
    }

    // Weather changes on the order of tens of minutes, but this widget boots
    // fresh in every new tab. Honouring the cache timestamp keeps a heavy-tab
    // user's session at ~2 calls/hour instead of one call per tab opened.
    //
    // When the cached reading is still inside REFRESH_INTERVAL_MS we don't
    // restart the full interval from now — that would stretch effective
    // staleness to (age + 30 min). Instead a one-shot fires exactly when the
    // cached reading expires, then hands off to the steady cadence.
    function scheduleRefreshes() {
        clearTimers();

        const entry = readCacheEntry();
        const age = entry ? Date.now() - (entry.at || 0) : Infinity;
        // A negative age means a clock change moved time backwards past the
        // stamp — treat that as stale rather than waiting out a bogus delay.
        const isFresh = age >= 0 && age < REFRESH_INTERVAL_MS;

        if (isFresh) {
            firstRefreshTimer = setTimeout(() => {
                firstRefreshTimer = null;
                refreshWeather();
                refreshTimer = setInterval(refreshWeather, REFRESH_INTERVAL_MS);
            }, REFRESH_INTERVAL_MS - age);
        } else {
            refreshWeather();
            refreshTimer = setInterval(refreshWeather, REFRESH_INTERVAL_MS);
        }
    }

    function boot() {
        const isHidden = safeGet(WEATHER_HIDDEN_KEY) === 'true';
        widget.classList.toggle('hide', isHidden);
        widget.classList.toggle('hidden-final', isHidden);
        // Settings panel persists this preference; respect it on boot so the
        // city span is hidden before the first paint instead of flashing in.
        widget.classList.toggle('no-city', safeGet('wf_weather_show_city') === 'false');

        const cachedEntry = readCacheEntry();
        if (cachedEntry) render(cachedEntry.data);

        scheduleRefreshes();

        wfOnVisibilityChange((hidden) => {
            if (hidden) {
                clearTimers();
            } else {
                // Same freshness rule as boot: a tab that gets backgrounded and
                // refocused a dozen times shouldn't refetch a dozen times.
                scheduleRefreshes();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

// ==============================
// SHORTCUTS WIDGET
// ==============================

const STORAGE_KEY = STORAGE_KEYS.SHORTCUTS;
const MIGRATION_FLAG_V2 = "shortcuts_migrated_v2";
const SHORTCUTS_OPEN_MODE_KEY_SHORT = "shortcutsOpenMode";
const SHORTCUTS_OPEN_MODE_MUSIC_KEY_SHORT = "shortcutsOpenModeWhenMusic";

const MAX_SHORTCUTS = 18;

const defaultShortcuts = [
  { name: "YouTube", url: "https://www.youtube.com/@wallsflow?sub_confirmation=1", userEdited: false },
  { name: "Google", url: "https://www.google.com", userEdited: false },
  { name: "Pinterest", url: "https://www.pinterest.com", userEdited: false },
  { name: "Steam", url: "https://store.steampowered.com/", userEdited: false },
];

const shortcuts = (() => {
  try {
    const raw = safeGet(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return [...defaultShortcuts];

    return parsed.map(sc => ({
      name: sc.name,
      url: sc.url,
      userEdited: sc.userEdited ?? false,
    }));
  } catch {
    return [...defaultShortcuts];
  }
})();

(() => {
  if (safeGet(MIGRATION_FLAG_V2)) return;

  let changed = false;
  for (let i = 0; i < shortcuts.length; i++) {
    const sc = shortcuts[i];
    if (sc.userEdited) continue;

    const isYouTubeLike =
      typeof sc.url === "string" &&
      sc.url.includes("youtube.com");

    const alreadyWallsflow = typeof sc.url === "string" && sc.url.includes("@wallsflow");

    if (isYouTubeLike && !alreadyWallsflow) {
      shortcuts[i] = {
        ...sc,
        url: "https://www.youtube.com/@wallsflow?sub_confirmation=1",
        userEdited: false,
      };
      changed = true;
    }
  }

  if (changed) safeSet(STORAGE_KEY, JSON.stringify(shortcuts));
  safeSet(MIGRATION_FLAG_V2, "1");
})();

const shortcutsContainer = document.getElementById("shortcuts");
const shortcutFormContainer = document.getElementById("shortcut-form-container");
const shortcutForm = document.getElementById("shortcut-form");
const shortcutNameInput = document.getElementById("shortcut-name");
const shortcutUrlInput = document.getElementById("shortcut-url");
const closeShortcutButton = document.getElementById("close-shortcut");
const deleteShortcutButton = document.getElementById("delete-shortcut");
const formTitle = document.getElementById("form-title");
const addShortcutButton = document.getElementById("add-shortcut");

let editingIndex = null;

function normalizeShortcutUrl(inputUrl) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return "";

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    // The URL parser accepts "not a url" as the host "not%20a%20url", which
    // saved a tile that could never open. A host has to look like one: labels
    // of letters, digits and hyphens joined by dots, or localhost, or an IP.
    if (!isPlausibleHost(parsed.hostname)) return "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function isPlausibleHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host.includes("%")) return false;
  if (host === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host);
}

// Two ways of writing the same site count as one shortcut: www. and the
// trailing slash are the parts people leave off or add without meaning to.
function shortcutUrlIdentity(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch (_) {
    return String(url || "").toLowerCase();
  }
}

// (isValidUrl helper removed — was a one-line wrapper around normalizeShortcutUrl
//  with no callers anywhere in the codebase.)

function getShortcutOpenMode() {
  return resolveOpenMode(SHORTCUTS_OPEN_MODE_KEY_SHORT, SHORTCUTS_OPEN_MODE_MUSIC_KEY_SHORT);
}

// Bookmarks had no setting of their own and followed Shortcuts. They still do
// until the user picks something in the Bookmarks row, so nobody's links
// change how they open because of the new row.
function getBookmarksOpenMode() {
  const hasOwn = safeGet(STORAGE_KEYS.BOOKMARKS_OPEN_MODE) !== null
    || safeGet(STORAGE_KEYS.BOOKMARKS_OPEN_MODE_MUSIC) !== null;
  if (!hasOwn) return getShortcutOpenMode();
  return resolveOpenMode(STORAGE_KEYS.BOOKMARKS_OPEN_MODE, STORAGE_KEYS.BOOKMARKS_OPEN_MODE_MUSIC);
}

function saveShortcuts() {
  const ok = safeSet(STORAGE_KEY, JSON.stringify(shortcuts));
  if (!ok) showPush(t('shortcuts_toast_save_failed'), 'warning');
  return ok;
}

const FAVICON_CACHE_KEY = STORAGE_KEYS.FAVICON_CACHE;
const FAVICON_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;
// Hard cap on the in-memory + localStorage cache. With MAX_SHORTCUTS=18 plus a
// long tail of edited/deleted shortcuts whose favicons may linger, 32 is
// comfortable headroom. When exceeded, oldest entries (by
// timestamp) are evicted LRU-style.
const FAVICON_CACHE_MAX_ENTRIES = 32;

// Inline SVG fallback shown if Google s2 fails to resolve a favicon. Encoded
// as a data URI so it doesn't trigger an HTTP request and never gets cached
// against a domain (it's a tile-level fallback, not a per-domain miss). The
// previous fallback `via.placeholder.com` no longer resolves DNS.
const FAVICON_FALLBACK = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2314B8A6' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18'/></svg>";

let _faviconCacheMemory = null;
// localStorage writes are synchronous (~0.5–5ms each). With a fresh install
// rendering 4 default shortcuts sequentially, that used to mean 4 blocking
// writes during first paint. Coalesce writes into a single trailing-edge
// flush per render turn.
let _faviconCacheDirty = false;
let _faviconCacheFlushHandle = null;

function getFaviconCache() {
  if (_faviconCacheMemory !== null) return _faviconCacheMemory;
  try {
    const cached = safeGet(FAVICON_CACHE_KEY);
    _faviconCacheMemory = cached ? JSON.parse(cached) : {};
  } catch {
    _faviconCacheMemory = {};
  }
  return _faviconCacheMemory;
}

function flushFaviconCache() {
  if (!_faviconCacheDirty || _faviconCacheMemory === null) return;
  _faviconCacheDirty = false;
  _faviconCacheFlushHandle = null;
  try {
    safeSet(FAVICON_CACHE_KEY, JSON.stringify(_faviconCacheMemory));
  } catch (e) {
    console.warn("Could not save favicon cache:", e);
  }
}

function scheduleFaviconCacheFlush() {
  _faviconCacheDirty = true;
  if (_faviconCacheFlushHandle) return;
  // requestIdleCallback when available, fallback to setTimeout. Either way the
  // batch lands well after first paint, off the critical path.
  if (typeof requestIdleCallback === "function") {
    _faviconCacheFlushHandle = requestIdleCallback(flushFaviconCache, { timeout: 800 });
  } else {
    _faviconCacheFlushHandle = setTimeout(flushFaviconCache, 250);
  }
}

function getFavicon(url) {
  try {
    const domain = new URL(url).origin;
    const cache = getFaviconCache();
    const cacheEntry = cache[domain];
    const now = Date.now();

    if (cacheEntry && (now - cacheEntry.timestamp) < FAVICON_CACHE_DURATION) {
      return cacheEntry.url;
    }

    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;

    cache[domain] = {
      url: faviconUrl,
      timestamp: now
    };

    // Prune expired entries first.
    for (const key of Object.keys(cache)) {
      if ((now - cache[key].timestamp) > FAVICON_CACHE_DURATION) {
        delete cache[key];
      }
    }

    // Then bound the cache size. After expiration prune, if still over cap,
    // drop the oldest entries until we're under the limit.
    const keys = Object.keys(cache);
    if (keys.length > FAVICON_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => (cache[a].timestamp || 0) - (cache[b].timestamp || 0));
      const dropCount = keys.length - FAVICON_CACHE_MAX_ENTRIES;
      for (let i = 0; i < dropCount; i++) {
        delete cache[keys[i]];
      }
    }
    scheduleFaviconCacheFlush();

    return faviconUrl;
  } catch {
    return FAVICON_FALLBACK;
  }
}

function openShortcut(url) {
  const openMode = getShortcutOpenMode();
  if (openMode === "_self") {
    window.location.assign(url);
  } else {
    window.open(url, "_blank");
  }
}

// HTML5 drag-and-drop reorder. The dragged tile holds its origin index in a
// closure-scoped variable rather than the dataTransfer payload \u2014 text/plain
// would force a string roundtrip and we already have direct DOM access.
// Suppressing the click that fires on dragend (Chrome bug \u2014 dragend triggers
// a synthetic click on the drop target) is handled via a 100ms time-window
// flag set in dragend and checked in the click handler.
let _dragSourceIndex = null;
let _dragJustEnded = 0;

function reorderShortcuts(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= shortcuts.length) return;
  if (toIndex < 0 || toIndex > shortcuts.length) return;
  const [moved] = shortcuts.splice(fromIndex, 1);
  // After splice, target index shifts by 1 if we were moving forward.
  const finalIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
  shortcuts.splice(finalIndex, 0, moved);
  saveShortcuts();
  renderShortcuts();
}

function renderShortcuts() {
  if (!shortcutsContainer) return;

  // Remove only the dynamic .shortcut tiles; keep the static #add-shortcut
  // node intact (it owns its own click listener bound at module load \u2014 used
  // to be re-fetched by getElementById on every render and re-appended).
  const dynamicTiles = shortcutsContainer.querySelectorAll(".shortcut:not(.add-shortcut)");
  for (const tile of dynamicTiles) tile.remove();

  // Build into a DocumentFragment so we hit the DOM exactly once at the end.
  const frag = document.createDocumentFragment();

  shortcuts.forEach((shortcut, index) => {
    const shortcutElement = document.createElement("div");
    shortcutElement.className = "shortcut";
    shortcutElement.setAttribute("role", "button");
    shortcutElement.tabIndex = 0;
    shortcutElement.draggable = true;
    shortcutElement.dataset.url = shortcut.url;
    shortcutElement.dataset.index = String(index);
    shortcutElement.title = shortcut.url;
    shortcutElement.setAttribute("aria-label", shortcut.name);

    const shortcutIcon = document.createElement("img");
    shortcutIcon.src = getFavicon(shortcut.url);
    shortcutIcon.alt = "";
    // Decorative \u2014 the tile's aria-label already announces the shortcut name.
    shortcutIcon.setAttribute("aria-hidden", "true");
    // The favicon image must NOT be independently draggable \u2014 it would steal
    // the dragstart event from the tile and the drag would carry just an
    // image preview instead of the full tile.
    shortcutIcon.draggable = false;
    // One-shot fallback: if Google s2 fails for this domain, swap to the
    // inline SVG globe. { once: true } prevents retry storms.
    shortcutIcon.addEventListener("error", () => {
      shortcutIcon.src = FAVICON_FALLBACK;
    }, { once: true });

    const shortcutName = document.createElement("span");
    shortcutName.textContent = shortcut.name;

    const menuButton = document.createElement("button");
    menuButton.className = "menu-button";
    menuButton.type = "button";
    menuButton.draggable = false;
    menuButton.setAttribute("aria-label", t('shortcuts_options_aria'));
    menuButton.textContent = "\u22EE";

    menuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      editingIndex = index;
      shortcutNameInput.value = shortcut.name;
      shortcutUrlInput.value = shortcut.url;
      formTitle.textContent = t('shortcuts_edit_shortcut');
      shortcutFormContainer.classList.add("visible");
      deleteShortcutButton.classList.remove("is-hidden");
    });

    shortcutElement.addEventListener("click", (event) => {
      // After a drag ends, Chrome fires a click on the drop target; ignore
      // those clicks within a short window so the drop doesn't accidentally
      // open the dropped-on shortcut's URL.
      if (Date.now() - _dragJustEnded < 100) return;
      if (event.target === menuButton || menuButton.contains(event.target)) {
        return;
      }
      openShortcut(shortcut.url);
    });

    // Keyboard activation: Enter or Space opens the shortcut.
    shortcutElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        if (event.target === menuButton || menuButton.contains(event.target)) return;
        event.preventDefault();
        openShortcut(shortcut.url);
      }
    });

    // Drag-and-drop reordering.
    shortcutElement.addEventListener("dragstart", (event) => {
      _dragSourceIndex = index;
      shortcutElement.classList.add("dragging");
      // Set a benign payload so Firefox triggers the drag at all (it requires
      // setData to start a drag session even if we don't read it back).
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", String(index)); } catch (_) {}
      }
    });

    shortcutElement.addEventListener("dragenter", (event) => {
      if (_dragSourceIndex === null) return;
      if (Number(shortcutElement.dataset.index) === _dragSourceIndex) return;
      event.preventDefault();
      shortcutElement.classList.add("drag-over");
    });

    shortcutElement.addEventListener("dragover", (event) => {
      if (_dragSourceIndex === null) return;
      // Required to allow drop. effectAllowed/dropEffect "move" cues the
      // OS-level drag cursor.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });

    shortcutElement.addEventListener("dragleave", (event) => {
      // dragleave fires for child nodes too; only clear when we actually leave
      // the tile bounds.
      if (event.target !== shortcutElement) return;
      shortcutElement.classList.remove("drag-over");
    });

    shortcutElement.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      shortcutElement.classList.remove("drag-over");
      const from = _dragSourceIndex;
      const to = Number(shortcutElement.dataset.index);
      _dragSourceIndex = null;
      _dragJustEnded = Date.now();
      if (Number.isFinite(from) && Number.isFinite(to)) {
        reorderShortcuts(from, to);
      }
    });

    shortcutElement.addEventListener("dragend", () => {
      _dragSourceIndex = null;
      _dragJustEnded = Date.now();
      shortcutElement.classList.remove("dragging");
      // Clear any lingering drag-over highlights on siblings (e.g. if the
      // user dropped outside any valid target).
      shortcutsContainer.querySelectorAll(".shortcut.drag-over").forEach(el => {
        el.classList.remove("drag-over");
      });
    });

    shortcutElement.appendChild(shortcutIcon);
    shortcutElement.appendChild(shortcutName);
    shortcutElement.appendChild(menuButton);

    frag.appendChild(shortcutElement);
  });

  // Insert the fragment BEFORE the add-shortcut tile so it stays as the last
  // visible cell in the row.
  if (addShortcutButton && addShortcutButton.parentNode === shortcutsContainer) {
    shortcutsContainer.insertBefore(frag, addShortcutButton);
  } else {
    shortcutsContainer.appendChild(frag);
  }

  // Spacious mode — when the user has 8 or fewer shortcuts there's room
  // to breathe, so we bump the tile size up (88×88 vs the compact 76×76)
  // and widen the gap. From 9 onward we drop back to compact so the
  // 9+9 layout for the 18-shortcut max stays symmetric on one container
  // width. Single CSS class on #shortcuts drives the switch — tile,
  // icon, label, gap, and the "+" add button all respond.
  shortcutsContainer.classList.toggle('spacious', shortcuts.length <= 8);

  if (addShortcutButton) {
    if (shortcuts.length >= MAX_SHORTCUTS) {
      addShortcutButton.classList.add("is-hidden");
    } else {
      addShortcutButton.classList.remove("is-hidden");
    }
  }
}

if (addShortcutButton) {
  addShortcutButton.addEventListener("click", () => {
    editingIndex = null;
    shortcutNameInput.value = "";
    shortcutUrlInput.value = "";
    formTitle.textContent = t('shortcuts_add_shortcut');
    shortcutFormContainer.classList.add("visible");
    deleteShortcutButton.classList.add('is-hidden');
  });
}

if (shortcutForm) {
  shortcutForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const name = shortcutNameInput.value.trim();
    const url = shortcutUrlInput.value.trim();
    const normalizedUrl = normalizeShortcutUrl(url);

    if (!normalizedUrl) {
      shortcutUrlInput.classList.add("error");
      shortcutUrlInput.setAttribute(
        "placeholder",
        t('shortcuts_invalid_url_placeholder')
      );
      shortcutUrlInput.value = "";
      return;
    }

    shortcutUrlInput.classList.remove("error");

    // Reject duplicates — bail out before saving so the user doesn't end
    // up with two tiles pointing at the same destination. When editing
    // an existing tile, exclude its own slot from the comparison so the
    // user can keep the URL unchanged while editing the name.
    const identity = shortcutUrlIdentity(normalizedUrl);
    const isDuplicate = shortcuts.some((sc, i) =>
      i !== editingIndex && shortcutUrlIdentity(sc.url) === identity
    );
    if (isDuplicate) {
      showPush(t('shortcuts_toast_duplicate_url'), 'warning');
      shortcutUrlInput.classList.add('error');
      setTimeout(() => shortcutUrlInput.classList.remove('error'), 1800);
      return;
    }

    if (editingIndex !== null) {
      shortcuts[editingIndex] = { ...shortcuts[editingIndex], name, url: normalizedUrl, userEdited: true };
    } else {
      shortcuts.push({ name, url: normalizedUrl, userEdited: true });
    }

    saveShortcuts();
    renderShortcuts();
    shortcutFormContainer.classList.remove("visible");
  });
}

if (deleteShortcutButton) {
  deleteShortcutButton.addEventListener("click", () => {
    if (editingIndex !== null) {
      shortcuts.splice(editingIndex, 1);
      saveShortcuts();
      renderShortcuts();
      shortcutFormContainer.classList.remove("visible");
      editingIndex = null;
    }
  });
}

if (closeShortcutButton) {
  closeShortcutButton.addEventListener("click", () => {
    shortcutFormContainer.classList.remove("visible");
    shortcutForm.reset();
    editingIndex = null;
  });
}

if (shortcutFormContainer) {
  shortcutFormContainer.addEventListener("click", (event) => {
    if (event.target === shortcutFormContainer) {
      shortcutFormContainer.classList.remove("visible");
      shortcutForm.reset();
      editingIndex = null;
    }
  });
}

renderShortcuts();

// One-time discoverability hint — show a toast on first page load with
// 2+ shortcuts explaining that tiles can be reordered via drag-and-drop.
// Persisted in localStorage so it never reappears once seen, and deferred
// 4 s after page load so it doesn't compete with the entry animations.
(function maybeShowDragHint() {
  if (shortcuts.length < 2) return;
  const SEEN_KEY = 'wf_shortcut_drag_hint_seen';
  if (safeGet(SEEN_KEY) === 'true') return;
  setTimeout(() => {
    if (typeof showPush === 'function') {
      showPush(t('shortcuts_toast_reorder_tip'), 'default');
    }
    safeSet(SEEN_KEY, 'true');
  }, 4000);
})();

// ==============================
// CLOCK & GREETING + Tab Visibility
// ==============================

function updateClockWidget() {
    const timeEl = document.getElementById('clock-time');
    const dateEl = document.getElementById('clock-date');
    if (!timeEl || !dateEl) return;

    const now = new Date();
    const format = safeGet('wf_clock_format') || (typeof getDefaultClockFormat === 'function' ? getDefaultClockFormat() : '12h');
    const is12h = format !== '24h';
    const showSeconds = safeGet('wf_clock_seconds') === 'true';
    const showDate = safeGet('wf_clock_date') !== 'false';

    const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: is12h };
    if (showSeconds) timeOpts.second = '2-digit';

    let timeStr;
    let period = '';
    if (is12h) {
        // Locales render the meridiem differently — "PM" (en-US), "p.m."
        // (ro-RO), "p. m." (es-ES), "下午" (zh-CN, and leading rather than
        // trailing). The previous regex only matched a bare AM/PM, so in every
        // other shape the raw string dropped into the UI unstyled and the
        // centering spacer never applied. formatToParts lifts the dayPeriod
        // out cleanly whatever form the locale gives it. Not a Firefox
        // quirk — V8 does the same, so Chrome was affected identically.
        const parts = new Intl.DateTimeFormat(window.wfI18n ? wfI18n.intlLocales() : [], timeOpts).formatToParts(now);
        period = (parts.find(p => p.type === 'dayPeriod')?.value || '')
            .replace(/[\s.]/g, '')   // "p.m." → "pm", "p. m." → "pm"
            .toUpperCase();
        timeStr = parts
            .filter(p => p.type !== 'dayPeriod')
            .map(p => p.value)
            .join('')
            .trim();
    } else {
        timeStr = now.toLocaleTimeString(window.wfI18n ? wfI18n.intlLocales() : [], timeOpts);
    }

    if (period) {
        // Mirror PM/AM as an invisible left-side spacer so the digits stay
        // optically centered even though the meridiem only sits on the right.
        // Without this, "08:52 PM" would shift the digits left of center
        // because PM takes width on one side only.
        timeStr = '<span class="clock-period clock-period-spacer" aria-hidden="true">' + period + '</span>'
            + timeStr
            + '<span class="clock-period">' + period + '</span>';
    }
    timeEl.innerHTML = timeStr;

    dateEl.textContent = now.toLocaleDateString(window.wfI18n ? wfI18n.intlLocales() : [], {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
    });
    dateEl.classList.toggle('is-hidden', !(showDate));
}

function applyClockSize() {
    const clockWidget = document.getElementById('clock-widget');
    if (!clockWidget) return;
    const size = safeGet('wf_clock_size') || 'M';
    clockWidget.classList.remove('clock-size-s', 'clock-size-m', 'clock-size-l');
    clockWidget.classList.add('clock-size-' + size.toLowerCase());
}

function applyClockFont() {
    const clockWidget = document.getElementById('clock-widget');
    if (!clockWidget) return;
    const VALID = ['default', 'rounded', 'handwrite'];
    let font = safeGet('wf_clock_font') || 'default';
    // Guard against legacy stored values ('serif', 'mono') from before the
    // font picker was curated down to lofi-friendly options — fall back
    // to 'default' so the user doesn't end up with no font class applied.
    if (!VALID.includes(font)) font = 'default';
    // Strip every class we've ever set, including legacy ones, so the
    // class state matches the validated value exactly.
    clockWidget.classList.remove(
        'clock-font-default', 'clock-font-serif', 'clock-font-mono',
        'clock-font-rounded', 'clock-font-handwrite'
    );
    clockWidget.classList.add('clock-font-' + font);
}

let _clockIntervalId = null;

function initClockWidget() {
    applyClockSize();
    applyClockFont();
    updateClockWidget();
    if (_clockIntervalId) clearInterval(_clockIntervalId);
    _clockIntervalId = setInterval(updateClockWidget, 1000);

    wfOnVisibilityChange((hidden) => {
        if (hidden) {
            if (_clockIntervalId) { clearInterval(_clockIntervalId); _clockIntervalId = null; }
        } else {
            updateClockWidget();
            _clockIntervalId = setInterval(updateClockWidget, 1000);
        }
    });
}

function typeText(el, text, options = {}) {
    const speed = Number(options.speed) || 70;
    const startDelay = Number(options.startDelay) || 0;
    const typingClass = options.typingClass || 'is-typing';

    return new Promise((resolve) => {
        const start = () => {
            let i = 0;
            el.textContent = '';
            el.classList.add(typingClass);

            const step = () => {
                i += 1;
                el.textContent = text.slice(0, i);
                if (i < text.length) {
                    setTimeout(step, speed);
                } else {
                    el.classList.remove(typingClass);
                    resolve();
                }
            };

            setTimeout(step, speed);
        };

        if (startDelay > 0) {
            setTimeout(start, startDelay);
        } else {
            start();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initClockWidget();

    const greetingText = document.getElementById('greeting-text');
    const greetingSubtitle = document.getElementById('greeting-subtitle');

    if (!greetingText || !greetingSubtitle) return;

    const { headline, subtitle } = getDailyMessageContent();

    // Honor the OS-level "reduce motion" preference — skip the typing
    // animation entirely (which uses ~30+ chained setTimeouts) and just paint
    // the final text. Same content, zero animation cost.
    const prefersReducedMotion = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
        greetingText.textContent = headline;
        greetingSubtitle.textContent = subtitle;
        greetingSubtitle.style.opacity = '1';
        return;
    }

    greetingText.textContent = '';
    greetingSubtitle.textContent = '';
    greetingSubtitle.style.opacity = '0';

    const runGreetingTyping = async () => {
        await typeText(greetingText, headline, {
            speed: 95,
            startDelay: 1720,
            typingClass: 'is-typing'
        });

        await new Promise((resolve) => setTimeout(resolve, 260));

        greetingSubtitle.style.opacity = '1';
        await typeText(greetingSubtitle, subtitle, {
            speed: 58,
            startDelay: 180,
            typingClass: 'is-typing'
        });
    };

    requestAnimationFrame(() => {
        runGreetingTyping();
    });
});

// Performance: Pause video when tab is hidden
wfOnVisibilityChange((hidden) => {
    const backgroundDiv = document.getElementById('background');
    if (!backgroundDiv) return;

    const videoElement = backgroundDiv.querySelector('video');
    if (!videoElement) return;

    if (hidden) {
        videoElement.pause();
    } else {
        const isPlaybackEnabled = safeGet('videoPlaybackEnabled') !== 'false';
        if (isPlaybackEnabled) {
            videoElement.play().catch(() => {});
        }
    }
});
