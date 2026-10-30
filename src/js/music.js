/* Sounds & Music unified module: music-core + music-library + music-main */
(function() {
'use strict';

/* --- music-core.js --- */
// -------- Music Player functionality --------
// Music player variables
let currentPlayer = null;
let playerContainer = null;
let modalPlayerContainer = null;
let activeSounds = new Map(); // Track active sounds with their audio objects
let checkMusicButtonAnimation = () => {};
let syncMusicPlayerPlacement = () => {};
let setMusicDockExpanded = () => {};
let updateMusicDockLabel = () => {};
let renderDockProgress = () => {};
let stopProgressInterpolation = () => {};
let startProgressInterpolation = () => {};
let currentPlayerHost = null;
let isMusicPaused = false;
let _lastKnownPosition = null;
let _positionLastBridgeTime = 0;
let _positionLastCurrentTime = 0;
let _positionDuration = 0;
let _positionIsLive = false;
let _liveTypeUpdateDone = false;

// The YouTube bridge fires WF_BRIDGE_POSITION roughly once per second while
// playing. Persisting position to localStorage on every event means ~60
// synchronous writes per minute (each ~0.5–5ms on Windows + AV scanning).
// Throttle to one write per 5s for the hot path; the visibility-hidden and
// beforeunload paths still flush immediately so we never lose more than a
// few seconds of resume state on tab/window close.
let _wfMusicPositionLastWrite = 0;
const writeMusicPositionThrottled = () => {
    if (!_lastKnownPosition) return;
    const now = Date.now();
    if (now - _wfMusicPositionLastWrite < 5000) return;
    _wfMusicPositionLastWrite = now;
    safeSet('wf_music_position', JSON.stringify(_lastKnownPosition));
};
const writeMusicPositionImmediate = () => {
    if (!_lastKnownPosition) return;
    _wfMusicPositionLastWrite = Date.now();
    safeSet('wf_music_position', JSON.stringify(_lastKnownPosition));
};
const MUSIC_ACTIVE_TAB_KEY = STORAGE_KEYS.MUSIC_ACTIVE_TAB_ID;
const MUSIC_TAB_ID_SESSION_KEY = STORAGE_KEYS.MUSIC_TAB_ID;
const MUSIC_HEARTBEAT_KEY = STORAGE_KEYS.MUSIC_HEARTBEAT;
const MUSIC_HEARTBEAT_STALE_MS = 10000; // 10 seconds — if no heartbeat, owner is dead

// In-memory cache for the saved-playlists JSON. Refreshed on save and on
// first read; avoids re-parsing localStorage on every render path that calls
// getSavedPlaylists (the modal alone hits this several times per open).
let _savedPlaylistsCache = null;
const SAVED_PLAYLISTS_KEY = STORAGE_KEYS.MUSIC_SAVED_PLAYLISTS;

function getSavedPlaylists() {
    if (_savedPlaylistsCache) return _savedPlaylistsCache;
    try {
        const data = safeGet(SAVED_PLAYLISTS_KEY);
        _savedPlaylistsCache = data ? JSON.parse(data) : [];
    } catch (_) {
        _savedPlaylistsCache = [];
    }
    return _savedPlaylistsCache;
}

// The cache follows the write: a library the browser refused to store must
// not look saved for the rest of this tab's life and vanish on the next one.
function savePlaylists(playlists) {
    const ok = safeSet(SAVED_PLAYLISTS_KEY, JSON.stringify(playlists));
    if (ok) _savedPlaylistsCache = playlists;
    return ok;
}

const MUSIC_SOURCE_CONFIG = {
    spotify: { label: 'Spotify', art: 'SP' },
    soundcloud: { label: 'SoundCloud', art: 'SC' },
    youtube: { label: 'YouTube', art: 'YT' }
};

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const ss = s % 60;
    if (h > 0) return `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

// escapeHtml + safeUrlForCss are provided by notifications.js (loaded first).

function prettifyMusicSlug(value) {
    return String(value || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function extractMusicAuthor(subtitle, host) {
    const cleanSubtitle = String(subtitle || '').trim();
    if (!cleanSubtitle) return String(host || '').trim();
    const splitToken = cleanSubtitle.includes(' • ') ? ' • ' : cleanSubtitle.includes(' - ') ? ' - ' : '';
    if (!splitToken) return cleanSubtitle;
    return cleanSubtitle.split(splitToken)[0].trim() || cleanSubtitle;
}

function normalizeMusicUrl(rawUrl) {
    if (!rawUrl) return '';

    let candidate = String(rawUrl).trim();
    if (!candidate) return '';

    if (!/^https?:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    try {
        return new URL(candidate).toString();
    } catch (error) {
        return '';
    }
}

function getMusicPreviewData(rawUrl) {
    const normalizedUrl = normalizeMusicUrl(rawUrl);
    if (!normalizedUrl) {
        return {
            valid: false,
            normalizedUrl: '',
            source: '',
            sourceLabel: '',
            title: '',
            subtitle: '',
            typeLabel: '',
            host: '',
            thumbnailUrl: '',
            embedUrl: ''
        };
    }

    try {
        const parsedUrl = new URL(normalizedUrl);
        const host = parsedUrl.hostname.replace(/^www\./, '');
        const pathname = parsedUrl.pathname;
        const spotifyPlaylistId = pathname.match(/\/playlist\/([A-Za-z0-9]+)/)?.[1];
        const spotifyAlbumId = pathname.match(/\/album\/([A-Za-z0-9]+)/)?.[1];
        const spotifyTrackId = pathname.match(/\/track\/([A-Za-z0-9]+)/)?.[1];

        const isSpotifyHost = host.includes('spotify.com') || host.includes('spotify.link') || host.includes('spotify.app.link');
        if (isSpotifyHost) {
            if (spotifyPlaylistId) {
                return {
                    valid: true,
                    normalizedUrl,
                    source: 'spotify',
                    sourceLabel: 'Spotify',
                    title: t('music_title_spotify_playlist'),
                    subtitle: host,
                    typeLabel: 'Playlist',
                    host,
                    thumbnailUrl: '',
                    embedUrl: `https://open.spotify.com/embed/playlist/${spotifyPlaylistId}?utm_source=generator&theme=0`,
                    videoId: '',
                    listId: ''
                };
            }
            if (spotifyAlbumId) {
                return {
                    valid: true,
                    normalizedUrl,
                    source: 'spotify',
                    sourceLabel: 'Spotify',
                    title: t('music_title_spotify_album'),
                    subtitle: host,
                    typeLabel: 'Album',
                    host,
                    thumbnailUrl: '',
                    embedUrl: `https://open.spotify.com/embed/album/${spotifyAlbumId}?utm_source=generator&theme=0`,
                    videoId: '',
                    listId: ''
                };
            }
            if (spotifyTrackId) {
                return {
                    valid: true,
                    normalizedUrl,
                    source: 'spotify',
                    sourceLabel: 'Spotify',
                    title: t('music_title_spotify_track'),
                    subtitle: host,
                    typeLabel: 'Track',
                    host,
                    thumbnailUrl: '',
                    embedUrl: `https://open.spotify.com/embed/track/${spotifyTrackId}?utm_source=generator&theme=0`,
                    videoId: '',
                    listId: ''
                };
            }

            return {
                valid: true,
                normalizedUrl,
                source: 'spotify',
                sourceLabel: 'Spotify',
                title: t('music_title_spotify_link'),
                subtitle: host,
                typeLabel: 'Link',
                host,
                thumbnailUrl: '',
                embedUrl: `https://open.spotify.com/embed?uri=${encodeURIComponent(normalizedUrl)}&utm_source=generator&theme=0`,
                videoId: '',
                listId: ''
            };
        }

        if (host.includes('soundcloud.com')) {
            const pathParts = pathname.split('/').filter(Boolean);
            const lastPart = pathParts[pathParts.length - 1] || 'soundcloud';
            const isPlaylist = pathParts.includes('sets') || pathParts.includes('playlists');
            return {
                valid: true,
                normalizedUrl,
                source: 'soundcloud',
                sourceLabel: 'SoundCloud',
                title: prettifyMusicSlug(lastPart) || t('music_title_soundcloud_mix'),
                subtitle: host,
                typeLabel: isPlaylist ? 'Playlist' : 'Track',
                host,
                thumbnailUrl: '',
                embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(normalizedUrl)}&color=%23ff5500&auto_play=true&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true`,
                videoId: '',
                listId: ''
            };
        }

        const isYouTubeHost = host.includes('youtube.com') || host === 'youtu.be' || host.includes('youtube-nocookie.com');
        if (isYouTubeHost) {
            const listId = parsedUrl.searchParams.get('list');
            const watchVideoId = parsedUrl.searchParams.get('v');
            const shortVideoId = host === 'youtu.be' ? pathname.split('/').filter(Boolean)[0] : '';
            const shortsVideoId = pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/)?.[1] || '';
            const liveVideoId = pathname.match(/\/live\/([A-Za-z0-9_-]+)/)?.[1] || '';
            const embedVideoId = pathname.match(/\/embed\/([A-Za-z0-9_-]+)/)?.[1] || '';
            const videoId = watchVideoId || shortVideoId || shortsVideoId || liveVideoId || embedVideoId;
            const canonicalUrl = listId
                ? (videoId
                    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`
                    : `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`)
                : (videoId
                    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
                    : normalizedUrl);

            if (listId) {
                const embedBase = 'https://www.youtube.com/embed';
                return {
                    valid: true,
                    normalizedUrl: canonicalUrl,
                    source: 'youtube',
                    sourceLabel: 'YouTube',
                    title: videoId ? t('music_title_youtube_playlist_mix') : t('music_title_youtube_playlist'),
                    subtitle: host,
                    typeLabel: 'Playlist',
                    host,
                    thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '',
                    embedUrl: `${embedBase}?listType=playlist&list=${encodeURIComponent(listId)}&autoplay=1&controls=1&rel=0&playsinline=1`,
                    videoId,
                    listId
                };
            }

            if (videoId) {
                const isLiveUrl = !!liveVideoId;
                const embedBase = 'https://www.youtube.com/embed';
                return {
                    valid: true,
                    normalizedUrl: canonicalUrl,
                    source: 'youtube',
                    sourceLabel: 'YouTube',
                    title: isLiveUrl ? t('music_title_youtube_live') : t('music_title_youtube_video'),
                    subtitle: host,
                    typeLabel: isLiveUrl ? 'Live' : 'Video',
                    host,
                    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    embedUrl: `${embedBase}/${encodeURIComponent(videoId)}?autoplay=1&controls=1&rel=0&playsinline=1`,
                    videoId,
                    listId: ''
                };
            }
        }

        return {
            valid: false,
            normalizedUrl,
            source: '',
            sourceLabel: '',
            title: '',
            subtitle: host,
            typeLabel: '',
            host,
            thumbnailUrl: '',
            embedUrl: '',
            videoId: '',
            listId: ''
        };
    } catch (error) {
        return {
            valid: false,
            normalizedUrl: '',
            source: '',
            sourceLabel: '',
            title: '',
            subtitle: '',
            typeLabel: '',
            host: '',
            thumbnailUrl: '',
            embedUrl: '',
            videoId: '',
            listId: ''
        };
    }
}

function buildYouTubeBridgeUrl(preview) {
    const defaultBridgeBase = 'https://up.wallsflow.com/youtube-bridge.html';
    const configuredBase = safeGet('wf_youtube_bridge_base') || defaultBridgeBase;
    if (!configuredBase || !preview?.valid || preview.source !== 'youtube') return '';

    // Number(null) is 0, not NaN — so reading the key directly made the `: 55`
    // fallback unreachable and handed the bridge volume=0 on a fresh install.
    // Masked (the iframe's load handler pushes the real volume three times),
    // but it left a window of silence and depended on the bridge being ready.
    const rawSavedVolume = safeGet('wf_youtube_bridge_volume');
    const savedVolume = (rawSavedVolume === null || rawSavedVolume === '')
        ? NaN
        : Number(rawSavedVolume);
    const safeVolume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(100, savedVolume)) : 55;
    const isMuted = safeGet('wf_youtube_bridge_muted') === 'true';
    let bridgeUrl;
    try {
        bridgeUrl = new URL(configuredBase);
    } catch (error) {
        bridgeUrl = new URL(defaultBridgeBase);
    }
    if (preview.videoId) bridgeUrl.searchParams.set('video', preview.videoId);
    if (preview.listId) bridgeUrl.searchParams.set('list', preview.listId);
    bridgeUrl.searchParams.set('title', preview.title || '');
    bridgeUrl.searchParams.set('thumb', preview.thumbnailUrl || '');
    bridgeUrl.searchParams.set('sourceUrl', preview.normalizedUrl || '');
    bridgeUrl.searchParams.set('volume', String(safeVolume));
    bridgeUrl.searchParams.set('muted', isMuted ? '1' : '0');
    bridgeUrl.searchParams.set('loop', safeGet('wf_youtube_loop') !== 'false' ? '1' : '0');
    // Force lowest video quality — we only care about audio, so decoding 144p
    // instead of 720p/1080p saves significant CPU/GPU. If the bridge doesn't
    // support this param it's simply ignored.
    bridgeUrl.searchParams.set('quality', 'tiny');

    // Resume from saved position if available
    try {
        const savedPos = safeGet('wf_music_position');
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            // For playlists: resume the specific video that was playing (not the first one)
            if (pos.videoId && preview.listId) {
                bridgeUrl.searchParams.set('video', pos.videoId);
            }
            if (typeof pos.time === 'number' && pos.time > 5) {
                bridgeUrl.searchParams.set('start', String(Math.floor(pos.time)));
            }
        }
    } catch (_) { /* ignore parse errors */ }

    return bridgeUrl.toString();
}

// Cache for oEmbed metadata responses. Each saved playlist hits
// fetchMusicPreviewMetadata once per render of the music modal — without this
// cache, opening the library 5x in a session = 5×N network requests for the
// same N playlists.
//
// - Bounded to OEMBED_CACHE_MAX entries with LRU eviction (Map preserves
//   insertion order; re-insert on hit, shift out oldest on overflow).
// - Persisted to localStorage so the cache survives tab refresh / browser
//   restart. A long-lived browser session was previously paying full
//   network round-trips after every restart; this trims that cold-start.
// - Entries expire after OEMBED_CACHE_TTL_MS so titles/thumbnails that
//   change upstream eventually refresh.
const _oembedCache = new Map(); // normalizedUrl -> { data, ts }
const OEMBED_CACHE_TTL_MS = 60 * 60 * 1000;
const OEMBED_CACHE_MAX = 80;
const OEMBED_CACHE_STORAGE_KEY = STORAGE_KEYS.MUSIC_OEMBED_CACHE;
let _oembedCachePersistPending = false;

(function _hydrateOembedCache() {
    try {
        const raw = safeGet(OEMBED_CACHE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const now = Date.now();
        // Skip stale entries during hydrate so the in-memory map only holds
        // fresh data; saves a TTL check on every subsequent get.
        for (const item of parsed) {
            if (!item || typeof item.key !== 'string' || !item.entry) continue;
            if ((now - (item.entry.ts || 0)) >= OEMBED_CACHE_TTL_MS) continue;
            _oembedCache.set(item.key, item.entry);
            if (_oembedCache.size >= OEMBED_CACHE_MAX) break;
        }
    } catch (_) { /* corrupt cache — start fresh */ }
})();

function _persistOembedCacheSoon() {
    if (_oembedCachePersistPending) return;
    _oembedCachePersistPending = true;
    // Debounce writes via rAF + microtask so a burst of inserts during
    // modal open results in a single localStorage stringify.
    const flush = () => {
        _oembedCachePersistPending = false;
        try {
            const arr = [];
            _oembedCache.forEach((entry, key) => arr.push({ key, entry }));
            safeSet(OEMBED_CACHE_STORAGE_KEY, JSON.stringify(arr));
        } catch (_) { /* quota exceeded — drop persist silently */ }
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(flush, { timeout: 1500 });
    } else {
        setTimeout(flush, 250);
    }
}

// Failures get their own record, and only in memory. Without this, a playlist
// that was deleted upstream is re-requested on EVERY library render: the browser
// logs each attempt, and because error responses don't carry
// Access-Control-Allow-Origin, a plain 404 surfaces in the console as a CORS
// failure — which reads like a configuration bug rather than a dead link.
//
// Persisted, but on a much shorter TTL than the success cache. A dead entry is
// retried once per TTL instead of once per new tab: enrichment only skips a
// playlist that already HAS a thumbnail, so one that can never get one is
// otherwise attempted on every single page load, forever.
//
// 10 minutes is the compromise. Long enough to stop the spam, short enough that
// a failure caused by a brief network drop — indistinguishable from a dead link
// at this layer — heals on its own without the user doing anything.
const OEMBED_FAILURE_TTL_MS = 10 * 60 * 1000;
const OEMBED_FAILURE_STORAGE_KEY = 'wf_oembed_failures_v1';
const _oembedFailures = new Map(); // normalizedUrl -> timestamp

(function _hydrateOembedFailures() {
    try {
        const parsed = JSON.parse(safeGet(OEMBED_FAILURE_STORAGE_KEY) || 'null');
        if (!Array.isArray(parsed)) return;
        const now = Date.now();
        for (const item of parsed) {
            if (!item || typeof item.key !== 'string') continue;
            const at = Number(item.at) || 0;
            // Drop anything already expired instead of carrying it into memory.
            if ((now - at) >= OEMBED_FAILURE_TTL_MS) continue;
            _oembedFailures.set(item.key, at);
        }
    } catch (_) { /* corrupt entry — start clean */ }
})();

function _persistOembedFailures() {
    try {
        const arr = [];
        _oembedFailures.forEach((at, key) => arr.push({ key, at }));
        safeSet(OEMBED_FAILURE_STORAGE_KEY, JSON.stringify(arr));
    } catch (_) { /* quota — losing this only costs an extra retry */ }
}

function _oembedRecentlyFailed(key) {
    const at = _oembedFailures.get(key);
    if (!at) return false;
    if ((Date.now() - at) >= OEMBED_FAILURE_TTL_MS) {
        _oembedFailures.delete(key);
        _persistOembedFailures();
        return false;
    }
    return true;
}

// A saved entry counts as unavailable when its oEmbed lookup failed recently.
// Only claimed while the browser reports a connection — see the note at the call
// site in renderSavedPlaylistMarkup().
function isPreviewUnavailable(preview) {
    if (!preview || !preview.normalizedUrl) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return _oembedRecentlyFailed(preview.normalizedUrl);
}

function _oembedNoteFailure(key) {
    _oembedFailures.set(key, Date.now());
    // Same bound as the success cache, so a long session with many broken links
    // can't grow this without limit.
    if (_oembedFailures.size > OEMBED_CACHE_MAX) {
        const oldest = _oembedFailures.keys().next().value;
        if (oldest !== undefined) _oembedFailures.delete(oldest);
    }
    _persistOembedFailures();
}

function _oembedCacheGet(key) {
    const entry = _oembedCache.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.ts) >= OEMBED_CACHE_TTL_MS) {
        _oembedCache.delete(key);
        _persistOembedCacheSoon();
        return null;
    }
    // Promote to most-recently-used position.
    _oembedCache.delete(key);
    _oembedCache.set(key, entry);
    return entry;
}

function _oembedCacheSet(key, data) {
    if (_oembedCache.has(key)) _oembedCache.delete(key);
    _oembedCache.set(key, { data, ts: Date.now() });
    if (_oembedCache.size > OEMBED_CACHE_MAX) {
        const oldestKey = _oembedCache.keys().next().value;
        if (oldestKey !== undefined) _oembedCache.delete(oldestKey);
    }
    _persistOembedCacheSoon();
}

async function fetchMusicPreviewMetadata(preview) {
    if (!preview || !preview.valid) return preview;

    let endpoint = '';
    if (preview.source === 'spotify') {
        endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(preview.normalizedUrl)}`;
    } else if (preview.source === 'soundcloud') {
        endpoint = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(preview.normalizedUrl)}`;
    } else if (preview.source === 'youtube' && (preview.typeLabel === 'Video' || (preview.typeLabel === 'Playlist' && preview.videoId))) {
        endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(preview.normalizedUrl)}`;
    }

    if (!endpoint) return preview;

    const cacheKey = preview.normalizedUrl;
    const cached = _oembedCacheGet(cacheKey);
    if (cached) return mergeOembedData(preview, cached.data);
    // Asked recently and it failed — don't re-run the request just to fail the
    // same way and log the same console error again.
    if (_oembedRecentlyFailed(cacheKey)) return preview;

    try {
        const response = await fetch(endpoint);
        if (!response.ok) {
            _oembedNoteFailure(cacheKey);
            return preview;
        }
        const data = await response.json();
        _oembedCacheSet(cacheKey, data);
        return mergeOembedData(preview, data);
    } catch (error) {
        // Includes the CORS-shaped failure a 404 produces, and genuine network
        // errors. Either way the caller degrades to the base preview.
        _oembedNoteFailure(cacheKey);
        return preview;
    }
}

function mergeOembedData(preview, data) {
    return {
        ...preview,
        title: data.title || preview.title,
        subtitle: data.author_name ? `${data.author_name} • ${preview.host}` : preview.subtitle,
        thumbnailUrl: data.thumbnail_url || preview.thumbnailUrl,
        authorName: data.author_name || preview.authorName || '',
        authorUrl: data.author_url || preview.authorUrl || ''
    };
}


/* --- music-library.js --- */
const MAX_SAVED_SOURCES = 12;
const FEATURED_SAVED_PLAYLISTS_COUNT = 4;
const DEFAULT_YOUTUBE_LIBRARY_PLAYLISTS = [
    {
        id: 'yt-default-1',
        name: 'Lofi Vibes Radio',
        url: 'https://www.youtube.com/watch?v=1Tl2FtV06qo',
        source: 'youtube',
        sourceLabel: 'YouTube',
        typeLabel: 'Live',
        subtitle: 'asian beats to relax/study to',
        thumbnailUrl: 'https://i.ytimg.com/vi/1Tl2FtV06qo/hqdefault.jpg'
    },
    {
        id: 'yt-default-2',
        name: 'Lofi Girl Live',
        url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A',
        source: 'youtube',
        sourceLabel: 'YouTube',
        typeLabel: 'Live',
        subtitle: 'beats to relax/study to',
        thumbnailUrl: 'https://i.ytimg.com/vi/rFZHOHl-L8A/hqdefault.jpg'
    },
    {
        id: 'yt-default-3',
        name: 'Jazz Hop Cafe',
        url: 'https://www.youtube.com/watch?v=E2vONfzoyRI',
        source: 'youtube',
        sourceLabel: 'YouTube',
        typeLabel: 'Live',
        subtitle: 'jazz beats to chill/study to',
        thumbnailUrl: 'https://i.ytimg.com/vi/E2vONfzoyRI/hqdefault.jpg'
    },
    {
        id: 'yt-default-4',
        name: 'Sleep & Chill',
        url: 'https://www.youtube.com/watch?v=xORCbIptqcc',
        source: 'youtube',
        sourceLabel: 'YouTube',
        typeLabel: 'Live',
        subtitle: 'ambient music to fall asleep to',
        thumbnailUrl: 'https://i.ytimg.com/vi/xORCbIptqcc/hqdefault.jpg'
    }
];

function syncMyLibraryComposerLayout(savedCount) {
    const quickAddBtn = document.getElementById('my-library-quick-add');

    if (quickAddBtn) {
        const isLimitReached = savedCount >= MAX_SAVED_SOURCES;
        quickAddBtn.disabled = isLimitReached;
        quickAddBtn.title = isLimitReached
            ? t('music_library_limit_title', { max: MAX_SAVED_SOURCES })
            : t('music_open_add_playlist_title');
    }
}

function bindMyLibraryQuickAddButton() {
    const quickAddBtn = document.getElementById('my-library-quick-add');
    if (!quickAddBtn || quickAddBtn.dataset.bound === 'true') return;
    quickAddBtn.dataset.bound = 'true';
    quickAddBtn.addEventListener('click', () => {
        if (quickAddBtn.disabled) return;
        document.dispatchEvent(new CustomEvent('wf:music-open-add-source'));
    });
}

function normalizeFeaturedPlaylistEntry(raw) {
    if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) return null;
    const preview = getMusicPreviewData(raw.url);
    const normalizedUrl = preview.valid ? preview.normalizedUrl : raw.url;
    return {
        id: raw.id || Date.now(),
        name: raw.name || preview.title || t('music_untitled_playlist'),
        url: normalizedUrl,
        source: raw.source || preview.source || 'neutral',
        sourceLabel: raw.sourceLabel || preview.sourceLabel || t('music_source_platform'),
        typeLabel: raw.typeLabel || preview.typeLabel || 'Playlist',
        subtitle: raw.subtitle || preview.subtitle || '',
        thumbnailUrl: raw.thumbnailUrl || preview.thumbnailUrl || '',
        authorName: raw.authorName || preview.authorName || '',
        authorUrl: raw.authorUrl || preview.authorUrl || ''
    };
}

function getLockedLibraryPlaylists() {
    return DEFAULT_YOUTUBE_LIBRARY_PLAYLISTS
        .map((item) => normalizeFeaturedPlaylistEntry(item))
        .filter(Boolean)
        .slice(0, FEATURED_SAVED_PLAYLISTS_COUNT);
}

// CSP style-src is 'self' (no 'unsafe-inline'), so we can't render the cover
// art via an inline style="background-image:url(...)" attribute. Templates emit
// data-bg-url="..." instead; after innerHTML assignment, applyDataBgUrl walks
// the subtree and sets `el.style.backgroundImage` via the property setter
// (which is NOT blocked by style-src). JSON.stringify on the URL gives us a
// double-quoted, escape-safe CSS string, so quotes in the URL can't break out.
function applyDataBgUrl(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const targets = root.querySelectorAll('[data-bg-url]');
    for (const el of targets) {
        const url = el.getAttribute('data-bg-url');
        if (url) el.style.backgroundImage = `url(${JSON.stringify(url)})`;
        el.removeAttribute('data-bg-url');
    }
}

// typeLabel stays an English identifier: saved playlists store it and the
// playback code compares it. Only what is drawn goes through the catalogue.
function displayTypeLabel(typeLabel) {
    switch (String(typeLabel || '')) {
        case 'Playlist': return t('music_type_playlist');
        case 'Album': return t('music_type_album');
        case 'Track': return t('music_type_track');
        case 'Song': return t('music_type_song');
        case 'Video': return t('music_type_video');
        case 'Live': return t('music_type_live');
        case 'Link': return t('music_type_link');
        case 'Mix': return t('music_type_mix');
        default: return String(typeLabel || '');
    }
}

function renderSavedPlaylistMarkup(playlist, preview) {
    const safeName = escapeHtml(playlist.name || preview.title || t('music_untitled'));
    const safeSource = escapeHtml(playlist.sourceLabel || preview.sourceLabel || t('music_source_platform'));
    const safeSubtitle = escapeHtml(getPlaylistSubtitle(preview));
    const sourceClass = escapeHtml(preview.source || 'neutral');
    const safeArtUrl = safeUrlForCss(preview.thumbnailUrl);
    const artBgAttr = safeArtUrl
        ? ` data-bg-url="${escapeHtml(safeArtUrl)}"`
        : '';
    const artClass = safeArtUrl ? 'saved-playlist-icon has-image' : 'saved-playlist-icon';
    // When real cover art is present, render the icon as an image-only
    // tile (no overlaid "SP"/"SC"/"YT" placeholder text). Without this
    // the source initials sat on top of the album cover and competed
    // visually with the artwork. Falls back to the source initials only
    // when the oEmbed thumbnail isn't available yet.
    const artContent = safeArtUrl
        ? ''
        : escapeHtml((MUSIC_SOURCE_CONFIG[preview.source]?.art || 'WF'));

    // Type badge (Playlist, Song, Album, Live, Mix) — replaced by an
    // "Unavailable" badge when the source has gone away upstream. Without this
    // a deleted playlist just sits there with no cover and does nothing when
    // clicked, and the user has no way to tell it from one that simply hasn't
    // loaded its artwork yet.
    //
    // Guarded on navigator.onLine: at this layer a network drop is
    // indistinguishable from a dead link, and labelling someone's whole library
    // as broken because their Wi-Fi blinked would be worse than saying nothing.
    const isUnavailable = isPreviewUnavailable(preview);

    let rawType = preview.typeLabel || 'Song';
    if (rawType === 'Video' || rawType === 'Track') rawType = 'Song';
    let safeType = escapeHtml(displayTypeLabel(rawType));
    const typeLower = rawType.toLowerCase();
    let typeClass = typeLower === 'playlist' ? 'type-playlist'
                    : typeLower === 'live' ? 'type-live'
                    : '';
    if (isUnavailable) {
        safeType = escapeHtml(t('music_type_unavailable'));
        typeClass = 'type-unavailable';
    }

    return `
        <div class="saved-playlist-menu">
            <button class="saved-playlist-menu-btn" type="button" aria-label="${escapeHtml(t('music_more_options_aria'))}" aria-expanded="false">⋮</button>
            <div class="saved-playlist-menu-dropdown" aria-hidden="true">
                <button class="saved-playlist-edit" type="button">${escapeHtml(t('music_rename'))}</button>
                <button class="saved-playlist-delete" type="button">${escapeHtml(t('common_delete'))}</button>
            </div>
        </div>
        <div class="${artClass}"${artBgAttr}>${artContent}</div>
        <div class="saved-playlist-info">
            <div class="saved-playlist-meta">
                <span class="saved-playlist-source ${sourceClass}">${safeSource}</span>
                <span class="saved-playlist-type ${typeClass}">${safeType}</span>
            </div>
            <div class="saved-playlist-name">${safeName}</div>
            <div class="saved-playlist-url">${safeSubtitle}</div>
        </div>
    `;
}

function getPlaylistSubtitle(preview) {
    if (preview.source === 'youtube') {
        const channelName = String(
            preview.authorName
            || extractMusicAuthor(preview.subtitle, preview.host)
            || ''
        ).trim();
        if (channelName && channelName !== preview.host) return channelName;
        return t('music_youtube_channel');
    }
    return preview.subtitle || preview.host || t('music_ready_to_play');
}

function playSavedPlaylist(card, playlist, preview) {
    // Click on an already-playing card = stop it (parity with sound cards
    // and built-in playlist cards). Single click both starts and stops.
    if (card.classList.contains('playing')) {
        card.classList.remove('playing');
        if (typeof window.stopMusic === 'function') {
            window.stopMusic();
        }
        return;
    }

    // See bindPlaylistCardPlayback: playMusic owns the `.playing` class and the
    // now-playing metadata, because it's the only place that knows whether
    // playback actually started.
    if (globalPlayMusic) {
        globalPlayMusic(
            preview.valid ? preview.normalizedUrl : playlist.url,
            preview,
            { displayName: playlist.name || preview.title || t('music_saved_playlist_default') }
        );
    } else {
        showPush(t('music_toast_player_not_ready'), 'default');
    }
}

function getComparableMusicUrl(rawUrl) {
    if (!rawUrl) return '';
    const preview = getMusicPreviewData(rawUrl);
    return preview.valid ? preview.normalizedUrl : normalizeMusicUrl(rawUrl);
}

function syncActiveLibraryPlaybackCard(activeUrl = null) {
    // A card is "playing" only while something actually is — in this tab or a
    // mirrored one. Matching on the stored URL alone left the last-played card
    // highlighted forever: wf_music_url outlives the session that wrote it, so
    // a tab opened long after the music stopped still showed it as active.
    // An explicit URL argument still wins, because playMusic passes it at the
    // moment it mounts a player.
    const resolvedUrl = activeUrl !== null
        ? activeUrl
        : (isAnythingPlaying() ? safeGet('wf_music_url') : '');
    const comparableActiveUrl = getComparableMusicUrl(resolvedUrl);
    const allCards = document.querySelectorAll('.playlist-card, .saved-playlist-card');

    // Single pass: each card's `playing` class is set to whether its url
    // matches the active one. classList.toggle with a forced boolean is a
    // no-op when the class is already in the desired state, so we avoid
    // the double-iteration (remove all, then re-add matches) the previous
    // version did on every render.
    allCards.forEach((card) => {
        if (!comparableActiveUrl) {
            card.classList.remove('playing');
            return;
        }
        const cardUrl = card.getAttribute('data-url');
        const comparableCardUrl = cardUrl ? getComparableMusicUrl(cardUrl) : null;
        const isActive = !!comparableCardUrl && comparableCardUrl === comparableActiveUrl;
        card.classList.toggle('playing', isActive);
    });
}

function openRenameModal(currentName, onSave) {
    const backdrop = document.getElementById('library-rename-backdrop');
    const input = document.getElementById('library-rename-input');
    const cancelBtn = document.getElementById('library-rename-cancel');
    const saveBtn = document.getElementById('library-rename-save');
    const closeBtn = document.getElementById('library-rename-close');
    if (!backdrop || !input || !cancelBtn || !saveBtn || !closeBtn) return;

    const closeModal = () => {
        backdrop.classList.remove('show');
        backdrop.setAttribute('aria-hidden', 'true');
        cancelBtn.onclick = null;
        saveBtn.onclick = null;
        closeBtn.onclick = null;
        backdrop.onclick = null;
        input.onkeydown = null;
    };

    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
    input.value = currentName || 'Untitled';
    input.focus();
    input.select();

    cancelBtn.onclick = closeModal;
    closeBtn.onclick = closeModal;
    backdrop.onclick = (event) => {
        if (event.target === backdrop) closeModal();
    };
    input.onkeydown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            saveBtn.click();
        }
    };
    saveBtn.onclick = async () => {
        const nextName = input.value.trim();
        if (!nextName) {
            showPush(t('music_toast_name_empty'), 'default');
            input.focus();
            return;
        }
        await onSave(nextName.slice(0, 80));
        closeModal();
    };
}

async function renamePlaylist(index, currentName) {
    openRenameModal(currentName, async (nextName) => {
        const playlists = await getSavedPlaylists();
        if (!playlists[index]) return;
        playlists[index].name = nextName;
        await savePlaylists(playlists);
        await refreshSavedPlaylists();
        showPush(t('music_toast_name_updated'), 'success');
    });
}

// Pulls cover art / channel name / subtitle from the source's oEmbed
// endpoint and persists them onto the saved playlist record so the
// next render can paint the artwork without another network round-trip.
// Replaces the older `maybeEnrichYouTubePreview`, which had the same
// behavior but only triggered for YouTube — Spotify and SoundCloud
// cards were left with the "SP" / "SC" placeholder text because nothing
// fetched their thumbnails. All three platforms expose oEmbed with a
// `thumbnail_url` field, so the same code path now serves them.
//
// Returns `{ preview, mutated }` so the caller can tell whether the
// playlist record changed (and therefore whether to persist the
// updated array back to localStorage). The previous implementation
// only signalled changes via authorName which didn't fire when oEmbed
// added a thumbnail without an author, leaving freshly-fetched cover
// art lost on the next page load.
async function maybeEnrichSavedPlaylistPreview(playlist, preview) {
    const ENRICHABLE = ['youtube', 'spotify', 'soundcloud'];
    if (!preview.source || !ENRICHABLE.includes(preview.source)) {
        return { preview, mutated: false };
    }
    // If we already have both the thumbnail and the author name, the
    // oEmbed call would just return cached data — skip the fetch.
    const hasThumb = !!preview.thumbnailUrl;
    const hasChannelName = !!String(preview.authorName || '').trim();
    if (hasThumb && hasChannelName) return { preview, mutated: false };

    const enriched = await fetchMusicPreviewMetadata(preview);
    if (!enriched || !enriched.valid) return { preview, mutated: false };

    let mutated = false;
    if (enriched.thumbnailUrl && enriched.thumbnailUrl !== playlist.thumbnailUrl) {
        playlist.thumbnailUrl = enriched.thumbnailUrl;
        mutated = true;
    }
    if (enriched.authorName && enriched.authorName !== playlist.authorName) {
        playlist.authorName = enriched.authorName;
        mutated = true;
    }
    if (enriched.authorUrl && enriched.authorUrl !== playlist.authorUrl) {
        playlist.authorUrl = enriched.authorUrl;
        mutated = true;
    }
    if (enriched.subtitle && enriched.subtitle !== playlist.subtitle) {
        playlist.subtitle = enriched.subtitle;
        mutated = true;
    }

    const merged = {
        ...enriched,
        source: playlist.source || enriched.source,
        sourceLabel: playlist.sourceLabel || enriched.sourceLabel,
        typeLabel: playlist.typeLabel || enriched.typeLabel
    };
    return { preview: merged, mutated };
}

async function deletePlaylist(index, playlistName) {
    openDeleteModal(playlistName || '', async () => {
        const playlists = await getSavedPlaylists();
        if (!playlists[index]) return;
        playlists.splice(index, 1);
        await savePlaylists(playlists);
        await refreshSavedPlaylists();
        showPush(t('music_toast_source_deleted'), 'success');
    });
}

function openDeleteModal(playlistName, onConfirm) {
    const backdrop = document.getElementById('library-delete-backdrop');
    const closeBtn = document.getElementById('library-delete-close');
    const cancelBtn = document.getElementById('library-delete-cancel');
    const confirmBtn = document.getElementById('library-delete-confirm');
    const text = document.getElementById('library-delete-text');
    if (!backdrop || !closeBtn || !cancelBtn || !confirmBtn || !text) return;

    const closeModal = () => {
        backdrop.classList.remove('show');
        backdrop.setAttribute('aria-hidden', 'true');
        closeBtn.onclick = null;
        cancelBtn.onclick = null;
        confirmBtn.onclick = null;
        backdrop.onclick = null;
    };

    text.textContent = playlistName
        ? t('modal_playlist_delete_text_named', { name: playlistName })
        : t('modal_playlist_delete_delete_this_playlist_from_my');
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');

    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    backdrop.onclick = (event) => {
        if (event.target === backdrop) closeModal();
    };
    confirmBtn.onclick = async () => {
        await onConfirm();
        closeModal();
    };
}

// Shown when the user starts playback in a tab while a different tab already
// owns the session. The old behaviour was a silent hijack: the new tab claimed
// ownership, the storage listener fired in the old tab, and its music just
// stopped mid-track with no explanation.
function openTakeoverModal({ sourceLabel, trackName }, onConfirm) {
    const backdrop = document.getElementById('music-takeover-backdrop');
    const closeBtn = document.getElementById('music-takeover-close');
    const cancelBtn = document.getElementById('music-takeover-cancel');
    const confirmBtn = document.getElementById('music-takeover-confirm');
    const text = document.getElementById('music-takeover-text');
    // No markup (older cached page) — fall back to taking over rather than
    // leaving the click dead.
    if (!backdrop || !closeBtn || !cancelBtn || !confirmBtn || !text) {
        onConfirm();
        return;
    }

    const closeModal = () => {
        backdrop.classList.remove('show');
        backdrop.setAttribute('aria-hidden', 'true');
        closeBtn.onclick = null;
        cancelBtn.onclick = null;
        confirmBtn.onclick = null;
        backdrop.onclick = null;
    };

    text.textContent = trackName
        ? t('modal_takeover_text_named', { name: trackName })
        : t('modal_takeover_text_source', { source: sourceLabel || t('music_source_generic') });

    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');

    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    backdrop.onclick = (event) => {
        if (event.target === backdrop) closeModal();
    };
    confirmBtn.onclick = () => {
        closeModal();
        onConfirm();
    };
}

function bindPlaylistCardPlayback(card) {
    if (!card || card.dataset.playlistBound === 'true') return;
    card.dataset.playlistBound = 'true';

    card.addEventListener('click', () => {
        const url = card.getAttribute('data-url');
        const name = card.getAttribute('data-name');
        if (!url) return;

        // Click on a card that's already playing = stop it (mirrors the
        // sound-card toggle behaviour where the same click both starts and
        // stops a sound).
        if (card.classList.contains('playing')) {
            card.classList.remove('playing');
            if (typeof window.stopMusic === 'function') {
                window.stopMusic();
            }
            return;
        }

        // No optimistic `.playing` class and no wf_music_url/name writes here:
        // playMusic may decline to start (another tab owns the session and the
        // user chose to keep it there). Marking the card first left it stuck in
        // a false playing state, so the user's NEXT click hit the stop branch
        // above instead of playing. playMusic owns both — it calls
        // syncActiveLibraryPlaybackCard() once playback actually begins.
        const preview = getMusicPreviewData(url);
        if (globalPlayMusic) {
            globalPlayMusic(
                preview.valid ? preview.normalizedUrl : url,
                preview.valid ? preview : null,
                name ? { displayName: name } : {}
            );
        } else {
            showPush(t('music_toast_player_not_ready'), 'default');
        }
    });
}

function renderFeaturedLibraryCard(playlist, preview) {
    const safeName = escapeHtml(playlist.name || preview.title || t('music_untitled_playlist'));
    const safeSource = escapeHtml(playlist.sourceLabel || preview.sourceLabel || t('music_source_platform'));
    const safeSubtitle = escapeHtml(playlist.subtitle || preview.subtitle || getPlaylistSubtitle(preview));
    const sourceCover = {
        spotify: '🎵',
        soundcloud: '☁️',
        youtube: '📺'
    };
    const cover = sourceCover[preview.source] || '🎧';
    const safeCoverUrl = safeUrlForCss(preview.thumbnailUrl);
    // Cover-art bg styling (size/position/transparent text) lives in
    // .playlist-cover.has-image (style.css). Inline style attribute removed
    // for CSP — applyDataBgUrl reads data-bg-url after render and sets
    // backgroundImage via the property setter.
    const coverBgAttr = safeCoverUrl ? ` data-bg-url="${escapeHtml(safeCoverUrl)}"` : '';
    const coverClass = safeCoverUrl ? 'playlist-cover has-image' : 'playlist-cover';

    // Type badge (Playlist, Song, Live, Mix)
    let rawType = playlist.typeLabel || preview.typeLabel || 'Playlist';
    if (rawType === 'Video' || rawType === 'Track') rawType = 'Song';
    const safeType = escapeHtml(displayTypeLabel(rawType));
    const typeLower = rawType.toLowerCase();
    const typeClass = typeLower === 'playlist' ? 'type-playlist'
                    : typeLower === 'live' ? 'type-live'
                    : '';

    return `
        <div class="${coverClass}"${coverBgAttr}>${cover}</div>
        <div class="playlist-info">
            <div class="playlist-meta">
                <span class="playlist-source">${safeSource}</span>
                <span class="playlist-type ${typeClass}">${safeType}</span>
            </div>
            <div class="playlist-name">${safeName}</div>
            <div class="playlist-desc">${safeSubtitle}</div>
        </div>
    `;
}

function syncFeaturedLibraryCards(entries) {
    const libraryGrid = document.querySelector('#library-tab .playlist-grid');
    if (!libraryGrid) return;

    libraryGrid.querySelectorAll('.playlist-card[data-from-saved="true"]').forEach((node) => node.remove());
    libraryGrid.querySelectorAll('[data-library-section="true"]').forEach((node) => node.remove());

    if (!entries || !entries.length) return;

    const spotifyCards = libraryGrid.querySelectorAll('.playlist-card:not([data-from-saved="true"])');
    const spotifyAnchor = spotifyCards.length ? spotifyCards[0] : null;

    const myLibraryDivider = document.createElement('div');
    myLibraryDivider.className = 'playlist-section-divider';
    myLibraryDivider.dataset.librarySection = 'true';
    myLibraryDivider.textContent = MUSIC_SOURCE_CONFIG.youtube.label;

    const spotifyDivider = document.createElement('div');
    spotifyDivider.className = 'playlist-section-divider';
    spotifyDivider.dataset.librarySection = 'true';
    spotifyDivider.textContent = MUSIC_SOURCE_CONFIG.spotify.label;

    if (spotifyAnchor) {
        libraryGrid.insertBefore(spotifyDivider, spotifyAnchor);
    } else {
        libraryGrid.appendChild(spotifyDivider);
    }
    libraryGrid.insertBefore(myLibraryDivider, spotifyDivider);

    const fragment = document.createDocumentFragment();
    entries.slice(0, FEATURED_SAVED_PLAYLISTS_COUNT).forEach((entry) => {
        const basePreview = getMusicPreviewData(entry.url);
        const preview = {
            ...basePreview,
            source: entry.source || basePreview.source,
            sourceLabel: entry.sourceLabel || basePreview.sourceLabel,
            typeLabel: entry.typeLabel || basePreview.typeLabel,
            subtitle: entry.subtitle || basePreview.subtitle,
            thumbnailUrl: entry.thumbnailUrl || basePreview.thumbnailUrl,
            authorName: entry.authorName || basePreview.authorName || '',
            authorUrl: entry.authorUrl || basePreview.authorUrl || ''
        };
        const card = document.createElement('article');
        card.className = 'playlist-card';
        card.dataset.fromSaved = 'true';
        card.dataset.url = preview.valid ? preview.normalizedUrl : entry.url;
        card.dataset.name = entry.name || preview.title || t('music_saved_playlist_default');
        card.innerHTML = renderFeaturedLibraryCard({
            name: entry.name,
            sourceLabel: entry.sourceLabel
        }, preview);
        applyDataBgUrl(card);
        bindPlaylistCardPlayback(card);
        fragment.appendChild(card);
    });

    libraryGrid.insertBefore(fragment, spotifyDivider);
}

// Each render gets a number; a render that finds a newer number after one
// of its awaits stops, because a save during the loop already started the
// render that will show the right cards. Without this the two loops appended
// into the same grid and left duplicate cards with stale indices.
let _savedPlaylistsRenderGen = 0;
async function refreshSavedPlaylists() {
    const grid = document.getElementById('user-playlist-grid');
    const title = document.getElementById('my-playlists-title');
    const libraryCount = document.getElementById('my-library-count');
    const emptyState = document.getElementById('user-playlist-empty');
    if (!grid) return;

    const gen = ++_savedPlaylistsRenderGen;
    const playlists = await getSavedPlaylists();
    if (gen !== _savedPlaylistsRenderGen) return;
    bindMyLibraryQuickAddButton();
    syncMyLibraryComposerLayout(playlists.length);
    grid.innerHTML = '';

    const featuredPlaylists = getLockedLibraryPlaylists();
    syncFeaturedLibraryCards(featuredPlaylists);

    if (title) title.classList.remove('is-hidden');
    if (libraryCount) libraryCount.textContent = `${playlists.length} / ${MAX_SAVED_SOURCES}`;
    if (emptyState) emptyState.classList.toggle('hidden', playlists.length > 0);
    if (!playlists.length) {
        // Library empty → the inline Add Playlist panel becomes the
        // primary affordance (CSS forces it visible via :has). Sync JS
        // state — class + aria-hidden — so isAddSourcePanelOpen() and
        // screen readers agree with the visual state. Without this,
        // the panel's HTML default `hidden` + `aria-hidden="true"`
        // would leave assistive tech announcing the form as hidden
        // even though it's the only thing on screen.
        const inlinePanel = document.getElementById('my-library-inline-add');
        if (inlinePanel) {
            inlinePanel.classList.remove('hidden');
            inlinePanel.setAttribute('aria-hidden', 'false');
        }
        syncActiveLibraryPlaybackCard();
        return;
    }

    let hasMetadataUpdates = false;

    for (let index = 0; index < playlists.length; index += 1) {
        const playlist = playlists[index];
        const card = document.createElement('article');
        card.className = 'saved-playlist-card';
        card.dataset.playlistId = playlist.id;
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', playlist.name ? t('music_play_named_aria', { name: playlist.name }) : t('music_play_saved_aria'));

        const basePreview = getMusicPreviewData(playlist.url);
        const preview = {
            ...basePreview,
            source: playlist.source || basePreview.source,
            sourceLabel: playlist.sourceLabel || basePreview.sourceLabel,
            typeLabel: playlist.typeLabel || basePreview.typeLabel,
            thumbnailUrl: playlist.thumbnailUrl || basePreview.thumbnailUrl,
            subtitle: playlist.subtitle || basePreview.subtitle,
            authorName: playlist.authorName || basePreview.authorName || '',
            authorUrl: playlist.authorUrl || basePreview.authorUrl || ''
        };
        const enrichment = await maybeEnrichSavedPlaylistPreview(playlist, preview);
        if (gen !== _savedPlaylistsRenderGen) return;
        const finalPreview = enrichment.preview;
        card.dataset.url = finalPreview.valid ? finalPreview.normalizedUrl : playlist.url;
        if (enrichment.mutated) hasMetadataUpdates = true;
        card.innerHTML = renderSavedPlaylistMarkup(playlist, finalPreview);
        // Drives the dimmed cover in CSS; the badge alone is easy to miss on a
        // card whose artwork never loaded anyway.
        card.classList.toggle('is-unavailable', isPreviewUnavailable(finalPreview));
        applyDataBgUrl(card);

        card.addEventListener('click', (e) => {
            if (e.target.closest('.saved-playlist-menu')) return;
            playSavedPlaylist(card, playlist, finalPreview);
        });

        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                playSavedPlaylist(card, playlist, finalPreview);
            }
        });

        const menuBtn = card.querySelector('.saved-playlist-menu-btn');
        const menuDropdown = card.querySelector('.saved-playlist-menu-dropdown');
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const shouldShow = !menuDropdown.classList.contains('show');
            document.querySelectorAll('.saved-playlist-menu-dropdown.show').forEach((menu) => {
                menu.classList.remove('show');
                menu.setAttribute('aria-hidden', 'true');
                const ownerCard = menu.closest('.saved-playlist-card');
                if (ownerCard) ownerCard.classList.remove('menu-open');
                const trigger = menu.parentElement?.querySelector('.saved-playlist-menu-btn');
                if (trigger) trigger.setAttribute('aria-expanded', 'false');
            });
            if (shouldShow) {
                card.classList.add('menu-open');
                menuDropdown.classList.add('show');
                menuDropdown.setAttribute('aria-hidden', 'false');
                menuBtn.setAttribute('aria-expanded', 'true');
            } else {
                card.classList.remove('menu-open');
                menuDropdown.classList.remove('show');
                menuDropdown.setAttribute('aria-hidden', 'true');
                menuBtn.setAttribute('aria-expanded', 'false');
            }
        });

        card.querySelector('.saved-playlist-edit').addEventListener('click', (e) => {
            e.stopPropagation();
            card.classList.remove('menu-open');
            menuDropdown.classList.remove('show');
            menuDropdown.setAttribute('aria-hidden', 'true');
            menuBtn.setAttribute('aria-expanded', 'false');
            renamePlaylist(index, playlist.name || finalPreview.title || 'Untitled');
        });

        card.querySelector('.saved-playlist-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            card.classList.remove('menu-open');
            menuDropdown.classList.remove('show');
            menuDropdown.setAttribute('aria-hidden', 'true');
            menuBtn.setAttribute('aria-expanded', 'false');
            deletePlaylist(index, playlist.name || finalPreview.title || 'Untitled');
        });

        grid.appendChild(card);
    }

    if (hasMetadataUpdates) {
        await savePlaylists(playlists);
    }

    syncActiveLibraryPlaybackCard();
}

document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.saved-playlist-menu')) return;
    document.querySelectorAll('.saved-playlist-menu-dropdown.show').forEach((menu) => {
        menu.classList.remove('show');
        menu.setAttribute('aria-hidden', 'true');
        const ownerCard = menu.closest('.saved-playlist-card');
        if (ownerCard) ownerCard.classList.remove('menu-open');
        const trigger = menu.parentElement?.querySelector('.saved-playlist-menu-btn');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
}, true);



/* --- music-main.js --- */
function stopMusic(options = {}) {
    const { clearResume = true } = options;
    // The resume keys describe the session, and the session belongs to whoever
    // holds the lock. A tab stopping because another tab took over has already
    // been superseded: the keys now describe the new owner's track, and
    // clearing them here would erase what that tab just wrote.
    const ownsResumeState = clearResume && !isAnotherTabMusicOwner();
    if (ownsResumeState) {
        safeSet('wf_music_was_playing', 'false');
        safeRemove('wf_music_url');
        safeRemove('wf_music_name');
    }
    if (currentPlayer) {
        // Clear saved position when manually stopping
        if (ownsResumeState) safeRemove('wf_music_position');

        if (playerContainer) {
            playerContainer.innerHTML = '';
            playerContainer.classList.remove('active', 'youtube-audio-mode', 'youtube-video-mode', 'youtube-meta-mode', 'native-embed');
        }
        if (modalPlayerContainer) {
            modalPlayerContainer.innerHTML = '';
            modalPlayerContainer.classList.remove('active', 'native-embed');
        }
        currentPlayer = null;
        currentPlayerHost = null;
        
        // Reset playlist visual states
        document.querySelectorAll('.playlist-card.playing, .saved-playlist-card.playing')
            .forEach((card) => card.classList.remove('playing'));
        if (clearResume) {
            syncActiveLibraryPlaybackCard('');
        }
        
        isMusicPaused = false;
        _lastKnownPosition = null;
        _positionIsLive = false;
        _liveTypeUpdateDone = false;
        _positionLastCurrentTime = 0;
        _positionDuration = 0;
        stopProgressInterpolation();
        syncPauseButtonsUI();

        // Check if we should remove music button animation
        checkMusicButtonAnimation();
        syncMusicPlayerPlacement();
    }

    // Outside the `if (currentPlayer)` block on purpose: an ambient-only session
    // ends here too, and remote tabs still need to hear about it. With ambient
    // layers still running the session goes on and only its state changes;
    // otherwise this tab is done being the owner, and how it says so decides
    // whether another tab may pick the session up.
    if (activeSounds.size === 0) {
        releaseMusicOwnership(clearResume ? 'stopped' : 'lock-lost');
    } else {
        broadcastMusicState();
    }
}

function syncPauseButtonsUI() {
    const dockPauseBtn = document.getElementById('music-dock-pause');
    const modalPauseBtn = document.getElementById('music-modal-pause');
    const isYT = !!(currentPlayer && currentPlayer.id === 'youtube-player');
    const showPauseBtn = isYT && !!currentPlayer;

    if (dockPauseBtn) {
        dockPauseBtn.classList.toggle('is-hidden', !(showPauseBtn));
        dockPauseBtn.innerHTML = isMusicPaused
            ? '<span class="material-symbols-outlined">play_arrow</span>'
            : '<span class="material-symbols-outlined">pause</span>';
        dockPauseBtn.title = isMusicPaused ? t('dock_resume_music_title') : t('dock_pause_music_title');
        dockPauseBtn.classList.toggle('paused', isMusicPaused);
    }
    if (modalPauseBtn) {
        modalPauseBtn.classList.toggle('is-hidden', !(showPauseBtn));
        modalPauseBtn.textContent = isMusicPaused ? t('common_resume') : t('common_pause');
        modalPauseBtn.classList.toggle('paused', isMusicPaused);
    }

    // Equalizer pause state
    document.querySelectorAll('.music-dock-eq, .music-modal-eq').forEach(eq => {
        eq.classList.toggle('paused', isMusicPaused);
    });
}

function pauseMusic() {
    if (!currentPlayer || currentPlayer.id !== 'youtube-player' || isMusicPaused) return;
    sendYouTubeBridgeCommand('pause');
    isMusicPaused = true;
    // Freeze progress interpolation at current computed position
    _positionLastCurrentTime += (Date.now() - _positionLastBridgeTime) / 1000;
    _positionLastBridgeTime = Date.now();
    syncPauseButtonsUI();
    broadcastMusicState();
}

function resumeMusic() {
    if (!currentPlayer || currentPlayer.id !== 'youtube-player' || !isMusicPaused) return;
    sendYouTubeBridgeCommand('resume');
    isMusicPaused = false;
    _positionLastBridgeTime = Date.now();
    syncPauseButtonsUI();
    broadcastMusicState();
}

function togglePauseResume() {
    if (isMusicPaused) resumeMusic();
    else pauseMusic();
}

// Global references set by initMusicPlayer
let globalPlayMusic = null;
let sendYouTubeBridgeCommand = () => {};
// Assigned by initMusicPlayer. Lives here because stopMusic/pauseMusic/
// resumeMusic are module-level and must be able to tell other tabs what
// changed the moment it changes.
let broadcastMusicState = () => {};
// Same arrangement: stopMusic has to leave ownership behind and has to know
// whether the resume keys are still its own to clear.
let releaseMusicOwnership = () => {};
let isAnotherTabMusicOwner = () => false;
// Assigned by initMusicPlayer. Needed at module level because
// syncActiveLibraryPlaybackCard lives outside that closure but has to know
// whether anything is actually playing — here or in another tab.
let isAnythingPlaying = () => false;

function initMusicPlayer() {
    const musicWidget = document.getElementById('music-widget');
    const musicWidgetBtn = document.getElementById('music-widget-btn');
    const musicPanel = document.getElementById('music-widget-panel');
    const musicModalBackdrop = document.getElementById('music-modal-backdrop');
    const musicPanelClose = document.getElementById('music-panel-close');
    const playerDock = document.getElementById('music-player-dock');
    // (#music-dock-toggle and #music-dock-theme used to be exposed in HTML —
    // the manual collapse + theme-cycle buttons were retired when the dock
    // became hover-reveal. The element lookups + their click handlers below
    // returned null and ran no code.)
    const dockOpenBtn = document.getElementById('music-dock-open');
    const dockPauseBtn = document.getElementById('music-dock-pause');
    const dockStopBtn = document.getElementById('music-dock-stop');
    const dockLabel = document.getElementById('music-dock-label');
    const dockSource = document.getElementById('music-dock-source');
    const dockRemoteNote = document.getElementById('music-dock-remote-note');
    const dockYoutubeControls = document.getElementById('music-dock-youtube-controls');
    const dockYoutubePrevBtn = document.getElementById('music-dock-youtube-prev');
    const dockYoutubeNextBtn = document.getElementById('music-dock-youtube-next');
    const dockYoutubeVolume = document.getElementById('music-dock-youtube-volume');
    const dockYoutubeMuteBtn = document.getElementById('music-dock-youtube-mute');
    const dockYoutubeLoopBtn = document.getElementById('music-dock-youtube-loop');
    const dockYoutubeMeta = document.getElementById('music-dock-youtube-meta');
    const dockYoutubeThumb = document.getElementById('music-dock-youtube-thumb');
    const dockYoutubeTitle = document.getElementById('music-dock-youtube-title');
    const dockYoutubeAuthor = document.getElementById('music-dock-youtube-author');
    const dockProgressRow = document.getElementById('music-dock-progress-row');
    const dockProgressFill = document.getElementById('music-dock-progress-fill');
    const dockTimeCurrent = document.getElementById('music-dock-time-current');
    const dockTimeDuration = document.getElementById('music-dock-time-duration');
    const visualizerStrip = document.getElementById('music-visualizer-strip');
    const musicUrlInput = document.getElementById('music-url-input');
    const musicUrlPaste = document.getElementById('music-url-paste');
    const musicUrlClear = document.getElementById('music-url-clear');
    const playBtn = document.getElementById('music-play-btn');
    // (#music-stop-btn — id removed from HTML; lookup + handler were dead.)
    const saveBtn = document.getElementById('music-save-btn');
    const addSourceInlinePanel = document.getElementById('my-library-inline-add');
    const addSourceInlineCloseBtn = document.getElementById('my-library-inline-close');
    const linkFeedback = document.getElementById('music-link-feedback');
    const previewCard = document.getElementById('music-preview-card');
    const previewArt = document.getElementById('music-preview-art');
    const previewSource = document.getElementById('music-preview-source');
    const previewKind = document.getElementById('music-preview-kind');
    const previewTitle = document.getElementById('music-preview-title');
    const previewSubtitle = document.getElementById('music-preview-subtitle');
    playerContainer = document.getElementById('music-player-container');
    modalPlayerContainer = document.getElementById('music-modal-player-container');
    const modalStreamStage = document.getElementById('music-modal-stream-stage');
    const modalYoutubeControls = document.getElementById('music-modal-youtube-controls');
    const modalStreamSource = document.getElementById('music-modal-stream-source');
    const modalStreamTitle = document.getElementById('music-modal-stream-title');
    const modalStreamSubtitle = document.querySelector('.music-modal-stream-subtitle');
    const modalStreamControls = document.querySelector('.music-modal-stream-controls');
    const modalYoutubeVolume = document.getElementById('music-modal-youtube-volume');
    const modalYoutubeMuteBtn = document.getElementById('music-modal-youtube-mute');
    const modalYoutubePrevBtn = document.getElementById('music-modal-youtube-prev');
    const modalYoutubeNextBtn = document.getElementById('music-modal-youtube-next');
    const modalPauseBtn = document.getElementById('music-modal-pause');
    const modalStopBtn = document.getElementById('music-modal-stop');
    // (#custom-music-section is referenced by HTML class hooks for layout but
    // the JS reference was never read — captured a DOM node into a variable
    // that nothing consumed.)

    let isPanelOpen = false;
    let isDockExpanded = false;
    let dockIsHovered = false;
    let visualizerRaf = null;
    let visualizerBars = [];
    let visualizerAudioContext = null;
    const visualizerNodes = new WeakMap();
    let _visualizerLastFrameTs = 0;
    const VISUALIZER_TARGET_FPS = 30;
    const VISUALIZER_FRAME_MS = 1000 / VISUALIZER_TARGET_FPS;
    let kickPulse = 0;
    let lastAmbientKickAt = 0;
    let ambientLowAvg = 0;
    let ambientEnergyAvg = 0;
    let syntheticBeatMs = 720;
    let syntheticBeatStart = 0;
    let syntheticLastStep = -1;
    // Holds a setInterval ID (was a requestAnimationFrame ID until the
    // dock-progress loop was downshifted from 60fps to 1Hz — see
    // startProgressInterpolation below).
    let _positionInterpolateRaf = null;
    let youtubeBridgeLoop = safeGet('wf_youtube_loop') !== 'false';
    let currentMusicPreview = null;
    let previewRequestToken = 0;
    let activeMusicTab = 'sounds';
    let modalCloseCleanupTimer = null;
    let restoreAmbientMixOnOpen = () => {};
    let youtubeBridgeVolume = Math.max(0, Math.min(100, Number(safeGet('wf_youtube_bridge_volume') || 55)));
    let youtubeBridgeMuted = safeGet('wf_youtube_bridge_muted') === 'true';
    const SMART_RESUME_ENABLED_KEY = STORAGE_KEYS.MUSIC_SMART_RESUME;
    const SMART_RESUME_WAS_PLAYING_KEY = STORAGE_KEYS.MUSIC_WAS_PLAYING;
    const getOrCreateMusicTabId = () => {
        const existing = sessionStorage.getItem(MUSIC_TAB_ID_SESSION_KEY);
        if (existing) return existing;
        const newId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem(MUSIC_TAB_ID_SESSION_KEY, newId);
        return newId;
    };
    const musicTabId = getOrCreateMusicTabId();
    let heartbeatInterval = null;
    let musicBus = null;
    try {
        musicBus = new BroadcastChannel('wf_music_bus');
    } catch (_) {
        // Unavailable on very old engines. Everything below degrades to the
        // pre-existing storage-event behaviour; nothing throws.
        musicBus = null;
    }

    const postBus = (message) => {
        if (!musicBus) return;
        try { musicBus.postMessage(message); } catch (_) { /* channel closed */ }
    };

    const getMusicActiveTabId = () => safeGet(MUSIC_ACTIVE_TAB_KEY) || '';
    const isOwnerHeartbeatStale = () => {
        const ts = Number(safeGet(MUSIC_HEARTBEAT_KEY) || '0');
        return (Date.now() - ts) > MUSIC_HEARTBEAT_STALE_MS;
    };
    // A pure question. It used to clear a lock it judged dead as a side
    // effect, which meant a tab merely asking "may I play?" could pull the
    // lock from under a live owner whose heartbeat was late.
    isAnotherTabMusicOwner = () => {
        const activeTabId = getMusicActiveTabId();
        if (!activeTabId || activeTabId === musicTabId) return false;
        return !isLockOrphaned();
    };
    const sendHeartbeat = () => {
        // Only the lock holder writes the heartbeat. A timer left running in a
        // tab that gave the lock up kept a later, dead owner looking alive.
        if (!isMusicOwner()) { stopHeartbeat(); return; }
        safeSet(MUSIC_HEARTBEAT_KEY, String(Date.now()));
        // Piggyback the state broadcast on the heartbeat: one timer, and any
        // remote tab that missed an event self-heals within 4s.
        broadcastMusicState();
    };
    const startHeartbeat = () => {
        sendHeartbeat();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(sendHeartbeat, 4000);
    };
    // Stops the timer only. The key is left alone: by the time this runs the
    // lock may already belong to another tab, and that tab's heartbeat is not
    // ours to delete.
    const stopHeartbeat = () => {
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };
    const claimMusicOwnership = () => {
        safeSet(MUSIC_ACTIVE_TAB_KEY, musicTabId);
        startHeartbeat();
    };
    // The one way out of being the owner. The reason is the whole protocol:
    //   'stopped'   the user ended the session here; nothing may adopt it.
    //   'unload'    this tab is going away; a surviving tab may adopt.
    //   'lock-lost' another tab holds the lock now; nothing in storage is ours
    //               any more, so nothing is written and no goodbye is sent.
    // The lock is removed only when it still names this tab, and only ever
    // removed, never overwritten: a claimer overwrites, a leaver clears.
    releaseMusicOwnership = (reason) => {
        stopHeartbeat();
        if (reason === 'lock-lost') return;
        if (getMusicActiveTabId() !== musicTabId) return;
        safeRemove(MUSIC_ACTIVE_TAB_KEY);
        postBus({ type: 'wf-music-bye', tabId: musicTabId, reason });
    };

    // ==============================
    // CROSS-TAB SESSION BUS
    // ==============================
    // Audio lives inside an <iframe> in exactly one tab's document — a second
    // tab physically cannot adopt it. So instead of pretending playback is
    // shared, every other tab becomes a remote control: it mirrors what the
    // owner reports and asks the owner to act on its behalf.
    //
    // BroadcastChannel is the transport (same-origin, reaches every extension
    // page); the existing localStorage lock + heartbeat stay as the source of
    // truth for *who* owns the session, since they survive a tab that never
    // got to say goodbye.
    const isMusicOwner = () => getMusicActiveTabId() === musicTabId;

    // The localStorage lock plus a 4 s heartbeat is a 10-second-granularity
    // liveness proxy, and that granularity is a real hole: a tab closed without
    // running beforeunload (crash, window close, renderer kill) leaves a
    // heartbeat that still looks fresh, so any tab opened in that window is told
    // a session is playing when nothing is.
    //
    // The bus settles it exactly instead of approximately — a dead tab cannot
    // answer. Owners broadcast on every heartbeat and reply to `hello`, so
    // hearing from one within the staleness budget is positive proof it lives.
    let _lastLiveOwnerId = '';
    let _lastLiveOwnerAt = 0;

    const noteLiveOwner = (tabId) => {
        if (!tabId || tabId === musicTabId) return;
        _lastLiveOwnerId = tabId;
        _lastLiveOwnerAt = Date.now();
    };

    // Positive evidence that the tab named in the lock is gone. Deliberately
    // conservative: wrongly deciding "orphaned" would hijack a live session and
    // cut someone's music off without asking, which is worse than wrongly
    // showing the confirm dialog.
    //
    // Two pieces of evidence, both positive. The heartbeat is written only by
    // the lock holder, every 4 s, and a tab making sound is exempt from timer
    // throttling, so a stale heartbeat means the holder is gone. A state
    // message heard on the bus inside the same budget means it is here, even
    // if its last write has not reached this tab's copy of storage yet.
    const isLockOrphaned = () => {
        const activeTabId = getMusicActiveTabId();
        if (!activeTabId) return true;
        if (_lastLiveOwnerId === activeTabId
            && (Date.now() - _lastLiveOwnerAt) < MUSIC_HEARTBEAT_STALE_MS) {
            return false;
        }
        return isOwnerHeartbeatStale();
    };

    // What the owner publishes about itself. `canPause`/`canSkip` are computed
    // here rather than guessed by the receiver, because only the owner knows
    // which provider is mounted — and only YouTube (via the bridge) accepts
    // programmatic transport commands. Spotify and SoundCloud embeds expose no
    // such API, so a remote tab is honestly limited to Stop for those.
    const buildOwnerState = () => {
        const streaming = hasStreamingPlayer();
        const ambient = hasAmbientPlayer();
        if (!streaming && !ambient) return { active: false, tabId: musicTabId };

        const isYouTube = streaming && isYouTubePlayer(currentPlayer);
        let source = 'Ambient';
        if (streaming) {
            source = isYouTube ? 'YouTube'
                : isSoundCloudPlayer(currentPlayer) ? 'SoundCloud'
                : isSpotifyPlayer(currentPlayer) ? 'Spotify'
                : t('music_source_generic');
        }

        return {
            active: true,
            tabId: musicTabId,
            streaming,
            ambient,
            source,
            name: streaming
                ? (safeGet('wf_music_name') || t('music_source_is_playing', { source }))
                : t('music_ambient_sounds_active'),
            url: streaming ? (safeGet('wf_music_url') || '') : '',
            paused: streaming ? isMusicPaused : false,
            isYouTube,
            canPause: isYouTube,
            canSkip: isYouTube && isYouTubePlaylist(currentPlayer),
            // Bridge preferences. They already live in shared localStorage, but
            // sending them keeps a remote in step the moment they change rather
            // than only on its next page load.
            volume: youtubeBridgeVolume,
            muted: youtubeBridgeMuted,
            loop: youtubeBridgeLoop,
            // Position, extrapolated to *now* the same way renderDockProgress
            // does locally. The remote stamps its arrival time and interpolates
            // from there, so a 4s heartbeat still yields a smooth 1Hz bar.
            position: isYouTube ? {
                currentTime: isMusicPaused
                    ? _positionLastCurrentTime
                    : _positionLastCurrentTime + (Date.now() - _positionLastBridgeTime) / 1000,
                duration: _positionDuration,
                isLive: _positionIsLive,
            } : null,
        };
    };

    isAnythingPlaying = () => hasStreamingPlayer() || hasRemoteSession();

    broadcastMusicState = () => {
        if (!isMusicOwner()) return;
        postBus({ type: 'wf-music-state', payload: buildOwnerState() });
    };

    // The three bridge preferences are persisted to localStorage by whichever
    // tab changed them, which makes localStorage the cross-tab source of truth.
    // The owner holds them in memory too, so it has to re-read after a remote
    // edit.
    const refreshYouTubeBridgePrefsFromStorage = () => {
        const rawVolume = Number(safeGet('wf_youtube_bridge_volume'));
        if (Number.isFinite(rawVolume)) {
            youtubeBridgeVolume = Math.max(0, Math.min(100, rawVolume));
        }
        youtubeBridgeMuted = safeGet('wf_youtube_bridge_muted') === 'true';
        youtubeBridgeLoop = safeGet('wf_youtube_loop') !== 'false';
        syncYouTubeVolumeUi();
        if (dockYoutubeLoopBtn) {
            dockYoutubeLoopBtn.classList.toggle('active', youtubeBridgeLoop);
            dockYoutubeLoopBtn.title = youtubeBridgeLoop ? t('dock_loop_on_title') : t('dock_loop_off_title');
        }
    };

    // Mirror of the owner's last report. Null when we ARE the owner, or when
    // nothing is playing anywhere.
    let remoteSession = null;
    let remoteSessionAt = 0;

    const hasRemoteSession = () => !!(remoteSession && remoteSession.active);

    // True when the dock in THIS tab stands in for a session owned elsewhere.
    // Everything that gates dock/visualizer behaviour on "is something playing
    // here" has to accept this too, otherwise the remote dock can't reuse the
    // hide-until-hover treatment local playback gets.
    const isRemoteDockActive = () => hasRemoteSession() && !hasAnyActiveAudio();

    const clearRemoteSession = () => {
        if (!remoteSession) return;
        remoteSession = null;
        remoteSessionAt = 0;
        // Full placement pass, not just the remote renderer: the dock's `show`
        // class, the launcher's visibility and the transport buttons are all
        // owned by syncMusicPlayerPlacement(). Calling only syncRemoteSessionUI()
        // here left the dock on screen after Stop, with the launcher still hidden.
        syncMusicPlayerPlacement();
    };

    const applyRemoteState = (payload) => {
        if (!payload || payload.tabId === musicTabId) return;
        // Our own audio always wins the UI — if this tab is playing, another
        // tab's report is not something we should render over it.
        if (hasAnyActiveAudio()) return;
        remoteSession = payload.active ? payload : null;
        remoteSessionAt = Date.now();
        // Someone is playing again — either the original owner never really left
        // or another tab won the election. Either way, drop our pending claim.
        if (remoteSession) cancelPendingHandoff();

        if (remoteSession && remoteSession.isYouTube) {
            // Feed the SAME module-level position state the local player writes,
            // so renderDockProgress() and the interpolation timer work here
            // unchanged instead of needing a parallel implementation.
            const pos = remoteSession.position || {};
            _positionLastCurrentTime = Number(pos.currentTime) || 0;
            _positionLastBridgeTime = Date.now();
            _positionDuration = Number(pos.duration) || 0;
            _positionIsLive = !!pos.isLive;
            isMusicPaused = !!remoteSession.paused;

            if (typeof remoteSession.volume === 'number') {
                youtubeBridgeVolume = remoteSession.volume;
                safeSet('wf_youtube_bridge_volume', String(youtubeBridgeVolume));
            }
            youtubeBridgeMuted = !!remoteSession.muted;
            youtubeBridgeLoop = !!remoteSession.loop;
            // Persisted as well as mirrored: if this tab ends up adopting the
            // session, buildYouTubeBridgeUrl() reads these from localStorage.
            safeSet('wf_youtube_bridge_muted', youtubeBridgeMuted ? 'true' : 'false');
            safeSet('wf_youtube_loop', youtubeBridgeLoop ? 'true' : 'false');
            syncYouTubeVolumeUi();

            if (!isMusicPaused && !_positionIsLive) startProgressInterpolation();
            else stopProgressInterpolation();
        } else if (!remoteSession) {
            stopProgressInterpolation();
        }

        syncMusicPlayerPlacement();
    };

    // ==============================
    // SESSION HANDOFF
    // ==============================
    // When the owner tab disappears, one of the surviving tabs picks the session
    // up so playback doesn't just die with the tab that happened to host it.
    //
    // Election: whoever the user is actually LOOKING at should win, so a visible
    // tab waits ~80ms and a background one ~600ms before reaching for the lock.
    // Jitter breaks ties between two visible tabs (possible across windows). The
    // localStorage lock is the real arbiter — a late claimer's write fires the
    // storage event that already stops playback in the loser.
    const HANDOFF_DELAY_VISIBLE_MS = 80;
    const HANDOFF_DELAY_HIDDEN_MS = 600;
    let handoffTimer = null;
    // Which tab's session the pending handoff would adopt. The storage
    // listener uses it to tell "someone else claimed the lock" from "the dead
    // owner's own lock reached this tab late", which is no reason to give up.
    let handoffFromTabId = '';

    const cancelPendingHandoff = () => {
        if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null; }
        handoffFromTabId = '';
    };

    // `proven` says how we know the owner is gone. A goodbye with reason
    // 'unload' is proof. Silence is only suspicion, so the adopter asks once
    // more and gives a live owner time to answer before reaching for the lock;
    // an answer re-populates the mirrored session and cancels the timer.
    const HANDOFF_PROBE_MS = 400;
    const adoptOrphanedSession = (snapshot, { proven = false } = {}) => {
        if (!snapshot || !snapshot.active) return;
        // Gated on Smart Resume: it is the existing "bring my music back by
        // itself" preference, and someone who turned it off does not want audio
        // starting in a tab they never touched.
        if (safeGet(SMART_RESUME_ENABLED_KEY) === 'false') return;
        if (hasAnyActiveAudio()) return;

        cancelPendingHandoff();
        if (!proven) postBus({ type: 'wf-music-hello', tabId: musicTabId });
        const isVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
        const delay = (proven ? 0 : HANDOFF_PROBE_MS)
            + (isVisible ? HANDOFF_DELAY_VISIBLE_MS : HANDOFF_DELAY_HIDDEN_MS)
            + Math.floor(Math.random() * (isVisible ? 40 : 300));

        handoffFromTabId = snapshot.tabId || '';
        handoffTimer = setTimeout(() => {
            handoffTimer = null;
            handoffFromTabId = '';
            if (hasAnyActiveAudio()) return;
            // The owner answered the probe, or a third tab got there first and
            // its claim already re-populated our remote session.
            if (isAnotherTabMusicOwner()) return;
            // Only an empty lock or the dead owner's own may be taken.
            const lock = getMusicActiveTabId();
            if (lock && lock !== snapshot.tabId && lock !== musicTabId) return;

            const url = snapshot.url || safeGet('wf_music_url') || '';
            // Only YouTube can actually be resumed: its bridge accepts a start
            // position and begins on its own. Spotify and SoundCloud embeds need
            // a click inside the iframe, which nothing here can supply.
            const canReallyResume = !!(snapshot.isYouTube || snapshot.source === 'YouTube');

            if (snapshot.streaming && url && canReallyResume) {
                // The tab inheriting the session may never have been clicked
                // in. Claim the session either way; audio starts once the
                // browser permits it. playMusic() re-reads wf_music_position
                // when building the bridge URL, and the departing tab flushes
                // that on unload, so YouTube picks up close to where it left.
                const deferred = runWhenAudioAllowed(() => {
                    playMusic(url, null, { allowTakeover: true, displayName: snapshot.name });
                });
                showPush(deferred ? t('music_toast_moved_here_click') : t('music_toast_moved_here'), deferred ? 'warning' : 'default');
            }
            // Streaming we cannot resume is deliberately NOT adopted. Mounting a
            // silent Spotify player and claiming ownership anyway made this tab
            // broadcast `streaming: true`, so every other tab showed "Playing in
            // another tab" while no sound was coming out anywhere — a phantom
            // session outliving the audio it described. Letting it end matches
            // what the user actually heard when the owning tab closed.

            if (snapshot.ambient) {
                // Re-read rather than trusting the copy captured at page load —
                // the owner may have changed the mix since.
                try {
                    const raw = safeGet(AMBIENT_MIX_STATE_KEY);
                    if (raw) pendingAmbientMixState = JSON.parse(raw);
                } catch (_) { /* keep whatever we had */ }
                ambientMixAutoRestored = true;
                claimMusicOwnership();
                // Same gate as the streaming branch: a refused autoplay would
                // degrade quietly to cards that say playing with no sound.
                const ambientDeferred = runWhenAudioAllowed(() => applyPendingAmbientState({ autoplay: true }));
                if (!snapshot.streaming) showPush(ambientDeferred ? t('music_toast_ambient_moved_here_click') : t('music_toast_ambient_moved_here'), ambientDeferred ? 'warning' : 'default');
            }
        }, delay);
    };

    const sendRemoteCommand = (command, extra = {}) => {
        if (!hasRemoteSession()) return false;
        postBus({ type: 'wf-music-command', target: remoteSession.tabId, command, ...extra });
        return true;
    };

    if (musicBus) {
        musicBus.onmessage = (event) => {
            const message = event?.data;
            if (!message || typeof message !== 'object') return;

            if (message.type === 'wf-music-state') {
                // Any state message proves the sender exists, including one with
                // active:false ("I'm here, just not playing").
                noteLiveOwner(message.payload?.tabId);
                applyRemoteState(message.payload);
                return;
            }

            // A tab that just loaded asks whoever owns the session to identify
            // itself, so a new tab shows the right state immediately instead of
            // waiting up to 4s for the next heartbeat.
            if (message.type === 'wf-music-hello') {
                // Answering refreshes the heartbeat key as well as the state,
                // which is what an adopter probing for us is waiting on.
                if (isMusicOwner()) sendHeartbeat();
                return;
            }

            if (message.type === 'wf-music-bye') {
                if (_lastLiveOwnerId === message.tabId) {
                    _lastLiveOwnerId = '';
                    _lastLiveOwnerAt = 0;
                }
                if (remoteSession && remoteSession.tabId === message.tabId) {
                    // Snapshot first: clearRemoteSession() nulls the very state
                    // the handoff needs to know what to resume.
                    const orphaned = remoteSession;
                    clearRemoteSession();
                    // Only a tab that went away leaves something to pick up. A
                    // goodbye without a reason comes from an older build and is
                    // read as a stop: never start audio on ambiguous evidence.
                    if (message.reason === 'unload') adoptOrphanedSession(orphaned, { proven: true });
                }
                return;
            }

            if (message.type === 'wf-music-command') {
                if (message.target !== musicTabId) return;
                // A takeover's stop can arrive before this tab's copy of the
                // lock shows the new owner; what matters is that the audio is
                // here, not what the lock says.
                if (!isMusicOwner() && !hasAnyActiveAudio()) return;
                if (message.command === 'stop') {
                    const takeover = message.reason === 'takeover';
                    stopMusic({ clearResume: !takeover });
                    if (activeSounds.size > 0) {
                        stopAllAmbientSounds({ releaseReason: takeover ? 'lock-lost' : 'stopped' });
                    }
                }
                else if (message.command === 'pause') pauseMusic();
                else if (message.command === 'resume') resumeMusic();
                else if (message.command === 'next') sendYouTubePlaylistNavCommand('next');
                else if (message.command === 'prev') sendYouTubePlaylistNavCommand('prev');
                else if (message.command === 'bridge') {
                    // The remote already wrote the new volume/mute/loop to shared
                    // localStorage before sending. Re-read them so this tab's own
                    // controls agree — otherwise the next broadcast would ship
                    // stale values back and snap the remote's slider around.
                    refreshYouTubeBridgePrefsFromStorage();
                    sendYouTubeBridgeCommand(message.bridgeCommand, message.bridgePayload || {});
                }
                // Report the new state right away rather than waiting for the
                // next heartbeat, so the remote's button flips immediately.
                setTimeout(broadcastMusicState, 60);
                return;
            }
        };
    }

    // A crashed owner never sends 'bye'. Expire the mirrored session on the
    // same staleness budget the ownership lock already uses.
    setInterval(() => {
        if (!hasRemoteSession()) return;
        if (Date.now() - remoteSessionAt <= MUSIC_HEARTBEAT_STALE_MS) return;
        // A crashed or force-killed owner never sends 'bye', but the session is
        // just as orphaned. Silence is not proof, though: the adopter probes
        // first, and an owner that answers gets its session back on the dock.
        const orphaned = remoteSession;
        clearRemoteSession();
        adoptOrphanedSession(orphaned, { proven: false });
    }, 3000);

    // Paints the dock as a remote control. Deliberately reuses the same dock
    // nodes as local playback — a second surface would drift out of sync and
    // double the CSS. `remote-mode` on the dock is what tells the transport
    // handlers to send a command instead of acting locally.
    // Paints the dock as a remote control. Deliberately reuses the same dock
    // nodes as local playback — a second surface would drift out of sync and
    // double the CSS. `remote-mode` on the dock is what tells the transport
    // handlers to send a command instead of acting locally.
    //
    // Leaving remote mode is NOT handled here: callers go through
    // syncMusicPlayerPlacement(), which restores every local-owned class and
    // then calls this last. Trying to hand-restore here is how the dock ended
    // up stuck on screen after a remote Stop.
    function syncRemoteSessionUI() {
        const remote = hasRemoteSession() && !hasAnyActiveAudio();

        if (playerDock) {
            playerDock.classList.toggle('remote-mode', remote);
            // `show` is only the visibility gate; updateDockIdlePreview() layers
            // `idle-preview` on top so the remote dock behaves exactly like the
            // local one — invisible until you hover the visualizer strip, then
            // revealed glassy. Both classes coexist during local playback too.
            if (remote) playerDock.classList.add('show');
        }

        if (dockRemoteNote) dockRemoteNote.hidden = !remote;

        // Unconditional: the launcher's pulse tracks remote sessions too, so it
        // has to be recomputed when one ENDS, not only when one starts.
        if (typeof checkMusicButtonAnimation === 'function') checkMusicButtonAnimation();

        if (!remote) {
            if (dockPauseBtn) dockPauseBtn.title = t('dock_pause_music_title');
            if (dockStopBtn) dockStopBtn.title = t('dock_stop_music_title');
            return;
        }

        if (dockSource) dockSource.textContent = remoteSession.source || t('music_source_generic');
        if (dockLabel) dockLabel.textContent = remoteSession.name || t('music_playing');

        // The launcher would sit on top of a dock already showing the same
        // session; hide it exactly as local playback does.
        if (musicWidget && safeGet('musicHidden') !== 'true') {
            musicWidget.classList.add('hide');
        }

        if (dockPauseBtn) {
            // Spotify and SoundCloud embeds have no control API — offering a
            // dead Pause button would be worse than not offering one.
            dockPauseBtn.classList.toggle('is-hidden', !remoteSession.canPause);
            dockPauseBtn.title = remoteSession.paused ? t('dock_resume_music_title') : t('dock_pause_music_title');
            const icon = dockPauseBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = remoteSession.paused ? 'play_arrow' : 'pause';
        }

        if (dockStopBtn) dockStopBtn.title = t('dock_stop_music_other_tab_title');

        // Full YouTube transport: every control routes through
        // sendYouTubeBridgeCommand(), which relays over the bus in remote mode,
        // so volume / mute / loop / seek all work from here. Classes match
        // syncDockYouTubeControls() exactly so it can take the state back when
        // remote mode ends.
        const isYouTube = !!remoteSession.isYouTube;
        const canSkip = !!remoteSession.canSkip;

        if (dockYoutubeControls) {
            dockYoutubeControls.classList.toggle('show', isYouTube);
            dockYoutubeControls.classList.toggle('playlist-mode', canSkip);
            dockYoutubeControls.setAttribute('aria-hidden', isYouTube ? 'false' : 'true');
        }
        if (dockYoutubePrevBtn) {
            dockYoutubePrevBtn.disabled = !canSkip;
            dockYoutubePrevBtn.setAttribute('aria-hidden', canSkip ? 'false' : 'true');
        }
        if (dockYoutubeNextBtn) {
            dockYoutubeNextBtn.disabled = !canSkip;
            dockYoutubeNextBtn.setAttribute('aria-hidden', canSkip ? 'false' : 'true');
        }
        if (dockYoutubeLoopBtn) {
            // syncDockYouTubeControls() hides this whenever there's no LOCAL
            // player, which is always true here.
            dockYoutubeLoopBtn.classList.toggle('is-hidden', !isYouTube);
        }

        // Position mirrors the owner's, so let the normal renderer draw it
        // rather than blanking the row.
        renderDockProgress();
    }

    // Streaming players live either in modal or dock depending on provider and UI state.
    const hasDockStreamingPlayer = () => !!(currentPlayer && currentPlayerHost === 'dock' && playerContainer && playerContainer.classList.contains('active'));
    const hasModalStreamingPlayer = () => !!(currentPlayer && currentPlayerHost === 'modal' && modalPlayerContainer && modalPlayerContainer.classList.contains('active'));
    const hasStreamingPlayer = () => hasDockStreamingPlayer() || hasModalStreamingPlayer();
    const hasAmbientPlayer = () => activeSounds.size > 0;
    const hasAnyActiveAudio = () => hasStreamingPlayer() || hasAmbientPlayer();
    const isSpotifyPlayer = (player = currentPlayer) => !!(player && player.id === 'spotify-player');
    const isSoundCloudPlayer = (player = currentPlayer) => !!(player && player.id === 'soundcloud-widget');
    const isYouTubePlayer = (player = currentPlayer) => !!(player && player.id === 'youtube-player');
    const isYouTubePlaylist = (player = currentPlayer) => !!(isYouTubePlayer(player) && player?.dataset?.youtubePlaylist === 'true');
    const isNativeEmbedPlayer = (player = currentPlayer) => isSpotifyPlayer(player) || isSoundCloudPlayer(player);
    const moveStreamingPlayerToHost = (nextHost) => {
        if (!currentPlayer) return;
        const targetHost = nextHost === 'modal' ? 'modal' : 'dock';
        if (isYouTubePlayer(currentPlayer) && targetHost !== 'dock') return;

        const targetContainer = targetHost === 'modal' ? modalPlayerContainer : playerContainer;
        const sourceContainer = currentPlayerHost === 'modal' ? modalPlayerContainer : playerContainer;
        if (!targetContainer || !sourceContainer || targetContainer === sourceContainer) return;

        if (playerContainer) {
            playerContainer.classList.remove('active', 'youtube-audio-mode', 'youtube-video-mode', 'youtube-meta-mode', 'native-embed');
        }
        if (modalPlayerContainer) {
            modalPlayerContainer.classList.remove('active', 'youtube-audio-mode', 'youtube-video-mode', 'youtube-meta-mode', 'native-embed');
        }

        targetContainer.replaceChildren(currentPlayer);
        targetContainer.classList.add('active');
        targetContainer.classList.toggle('native-embed', targetHost === 'modal' && isNativeEmbedPlayer(currentPlayer));
        currentPlayerHost = targetHost;
    };
    const resetDockFloatingPlacement = () => {
        if (!playerDock) return;
        playerDock.classList.remove('modal-inline', 'spotify-inline', 'soundcloud-inline');
        playerDock.style.left = '';
        playerDock.style.top = '';
        playerDock.style.bottom = '';
        playerDock.style.width = '';
        playerDock.style.transform = '';
        playerDock.style.zIndex = '';
        playerDock.style.opacity = '';
        playerDock.style.visibility = '';
        playerDock.style.pointerEvents = '';
    };
    const placeDockInModalSlot = () => {
        if (!playerDock || !modalPlayerContainer) return;
        const rect = modalPlayerContainer.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 20) return;
        const isNativeProjected = !!(currentPlayer && (isSpotifyPlayer(currentPlayer) || isSoundCloudPlayer(currentPlayer)));
        const verticalNudge = isNativeProjected ? 15 : 0;
        playerDock.classList.add('modal-inline');
        playerDock.style.left = `${rect.left + (rect.width / 2)}px`;
        playerDock.style.top = `${rect.top + verticalNudge}px`;
        playerDock.style.bottom = 'auto';
        playerDock.style.width = `${rect.width}px`;
        playerDock.style.transform = 'translateX(-50%)';
        playerDock.style.zIndex = '100010';
        playerDock.style.opacity = '1';
        playerDock.style.visibility = 'visible';
        playerDock.style.pointerEvents = 'auto';
    };
    const persistSmartResumeState = () => {
        // If Pomodoro focus is running and smart-resume was suppressed on boot,
        // no streaming iframe exists right now — but the user DID have music
        // playing before focus. Don't clobber was_playing=true in that case, or
        // the music is lost across refreshes.
        try {
            const pomoStateRaw = safeGet('wf_pomo_state');
            if (pomoStateRaw) {
                const pomoState = JSON.parse(pomoStateRaw);
                const pomoFocusRunning = !!(pomoState &&
                    pomoState.status === 'running' &&
                    pomoState.phase === 'focus');
                const streamingSuppressed = safeGet('wf_pomo_focus_streaming_pending') === 'true';
                if (pomoFocusRunning && streamingSuppressed && !hasStreamingPlayer()) {
                    return; // keep was_playing=true so next reload still suppresses + flags
                }
            }
        } catch (_) {}

        // SMART_RESUME_WAS_PLAYING_KEY is global, but this function answers a
        // purely local question ("does THIS tab have a player?"). A tab that
        // isn't the session owner must stay out of it — otherwise merely
        // closing an unrelated new tab wrote 'false' and silently destroyed the
        // playing tab's resume state, so the next Chrome start resumed nothing.
        if (isAnotherTabMusicOwner()) return;

        safeSet(SMART_RESUME_WAS_PLAYING_KEY, hasStreamingPlayer() ? 'true' : 'false');
    };

    const computeSeedFromUrl = (url) => {
        const source = (url || safeGet('wf_music_url') || 'default').toLowerCase();
        let hash = 0;
        for (let i = 0; i < source.length; i++) {
            hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    };

    const configureSyntheticBeat = (url) => {
        const seed = computeSeedFromUrl(url);
        const bpm = 76 + (seed % 20); // 76-95 lofi-ish
        syntheticBeatMs = 60000 / bpm;
        syntheticBeatStart = performance.now();
        syntheticLastStep = -1;
    };

    // Ceiling for the ambient volume sliders. HTMLMediaElement.volume caps at
    // 1.0, so anything above 100% has to go through a Web Audio GainNode.
    const AMBIENT_MAX_VOLUME_PCT = 200;

    // Routing an <audio> element through createMediaElementSource() takes it
    // off the direct output path — from then on it is only audible through the
    // graph. Everything that touches visualizerAudioContext has to respect
    // that; see the visibilitychange handler.
    const ensureAudioAnalyser = (audioEl) => {
        if (!audioEl) return null;
        if (visualizerNodes.has(audioEl)) {
            return visualizerNodes.get(audioEl);
        }

        try {
            if (!visualizerAudioContext) {
                visualizerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            const source = visualizerAudioContext.createMediaElementSource(audioEl);
            const gain = visualizerAudioContext.createGain();
            const analyser = visualizerAudioContext.createAnalyser();
            analyser.fftSize = 128;
            // source -> gain -> analyser -> master limiter -> destination. The
            // gain sits ahead of the analyser so the visualizer reacts to what
            // you actually hear.
            source.connect(gain);
            gain.connect(analyser);
            analyser.connect(ensureAmbientMasterNode());
            const data = new Uint8Array(analyser.frequencyBinCount);
            const nodePack = { analyser, data, gain };
            visualizerNodes.set(audioEl, nodePack);
            return nodePack;
        } catch (error) {
            return null;
        }
    };

    // Shared output stage for every boosted ambient layer. Individual gains can
    // reach 2x, and several sounds at once sum at the destination — without a
    // limiter that clips into audible distortion exactly when someone uses the
    // top of the new slider range. A compressor with a high ratio and a ceiling
    // just under unity acts as a soft limiter: inaudible until the sum would
    // have clipped anyway.
    let ambientMasterNode = null;
    const ensureAmbientMasterNode = () => {
        if (!visualizerAudioContext) return null;
        if (ambientMasterNode) return ambientMasterNode;
        try {
            const limiter = visualizerAudioContext.createDynamicsCompressor();
            limiter.threshold.value = -2;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.25;
            limiter.connect(visualizerAudioContext.destination);
            ambientMasterNode = limiter;
        } catch (_) {
            // Compressor unavailable — go straight out rather than lose audio.
            ambientMasterNode = visualizerAudioContext.destination;
        }
        return ambientMasterNode;
    };

    // An AudioContext can be created suspended (autoplay policy) and we also
    // suspend it ourselves while backgrounded. Either way, a suspended context
    // means silence for anything routed through it.
    const resumeAudioContextIfSuspended = () => {
        if (!visualizerAudioContext) return;
        if (visualizerAudioContext.state !== 'suspended') return;
        try { visualizerAudioContext.resume().catch(() => {}); } catch (_) {}
    };

    // Single place that turns a slider percentage into actual loudness.
    //   <= 100%: plain element volume, no Web Audio involved — the common case
    //            stays on the simple path.
    //    > 100%: element at full scale and the surplus applied as gain, which
    //            requires the element to be routed through the graph.
    // Falls back to unboosted full volume if the graph can't be built, so a
    // blocked AudioContext degrades to "as loud as before", never to silence.
    const applyAmbientVolume = (audioEl, rawPct) => {
        if (!audioEl) return;
        const pct = Math.max(0, Math.min(AMBIENT_MAX_VOLUME_PCT, Number(rawPct) || 0));

        if (pct <= 100) {
            audioEl.volume = pct / 100;
            const existing = visualizerNodes.get(audioEl);
            if (existing?.gain) existing.gain.gain.value = 1;
            return;
        }

        const pack = ensureAudioAnalyser(audioEl);
        if (pack?.gain) {
            audioEl.volume = 1;
            pack.gain.gain.value = pct / 100;
            resumeAudioContextIfSuspended();
        } else {
            audioEl.volume = 1;
        }
    };

    const initVisualizerBars = () => {
        if (!visualizerStrip || visualizerStrip.dataset.ready === 'true') return;
        // 32 bars is visually indistinguishable from 64 at the rendered width
        // but halves the per-frame DOM writes during playback.
        const barCount = 32;
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < barCount; i++) {
            const bar = document.createElement('span');
            bar.className = 'music-visualizer-bar';
            fragment.appendChild(bar);
            visualizerBars.push(bar);
        }
        visualizerStrip.appendChild(fragment);
        visualizerStrip.dataset.ready = 'true';
    };

    const getAmbientAnalysis = () => {
        if (!hasAmbientPlayer()) return { energy: 0, kick: false };
        let total = 0;
        let totalLow = 0;
        let count = 0;
        activeSounds.forEach((audioEl) => {
            const pack = ensureAudioAnalyser(audioEl);
            if (!pack) return;
            pack.analyser.getByteFrequencyData(pack.data);
            let sum = 0;
            let lowSum = 0;
            for (let i = 0; i < pack.data.length; i++) {
                sum += pack.data[i];
                if (i < 8) lowSum += pack.data[i];
            }
            const avg = sum / pack.data.length;
            const lowAvg = lowSum / 8;
            total += avg / 255;
            totalLow += lowAvg / 255;
            count += 1;
        });

        if (!count) return { energy: 0, kick: false };

        const energyRaw = Math.min(1, total / count);
        const lowRaw = Math.min(1, totalLow / count);
        ambientEnergyAvg = ambientEnergyAvg * 0.86 + energyRaw * 0.14;
        ambientLowAvg = ambientLowAvg * 0.88 + lowRaw * 0.12;
        const lowOnset = lowRaw - ambientLowAvg;
        const now = performance.now();
        const kick = lowOnset > 0.085 && (now - lastAmbientKickAt) > 145;
        if (kick) lastAmbientKickAt = now;

        return { energy: Math.max(0.04, ambientEnergyAvg), kick };
    };

    const getSyntheticStreamingAnalysis = () => {
        const now = performance.now();
        if (!syntheticBeatStart) {
            configureSyntheticBeat(safeGet('wf_music_url'));
        }

        let kick = false;
        const halfBeat = syntheticBeatMs / 2;
        const step = Math.floor((now - syntheticBeatStart) / halfBeat);
        if (step !== syntheticLastStep) {
            syntheticLastStep = step;
            const pattern = [1, 0, 0.76, 0, 1, 0, 0.54, 0];
            const hit = pattern[step % pattern.length];
            if (hit > 0.72) {
                kick = true;
                kickPulse = Math.max(kickPulse, hit);
            }
        }

        const time = now * 0.001;
        const phase = ((now - syntheticBeatStart) % syntheticBeatMs) / syntheticBeatMs;
        const envelope = Math.exp(-phase * 5.5);
        const drift = (Math.sin(time * 0.38) + 1) * 0.5;
        const shimmer = (Math.sin(time * 1.35 + 1.2) + 1) * 0.5;
        const noise = Math.random() * 0.05;
        const energy = Math.min(1, 0.2 + drift * 0.18 + shimmer * 0.1 + envelope * 0.16 + noise);
        return { energy, kick };
    };

    const renderVisualizerFrame = (timestamp) => {
        if (!visualizerBars.length || (!hasAnyActiveAudio() && !isRemoteDockActive())) {
            visualizerRaf = null;
            return;
        }

        // Throttle to 30fps — indistinguishable from 60fps for the visualizer, half the CPU cost
        const ts = typeof timestamp === 'number' ? timestamp : performance.now();
        if (ts - _visualizerLastFrameTs < VISUALIZER_FRAME_MS) {
            visualizerRaf = requestAnimationFrame(renderVisualizerFrame);
            return;
        }
        _visualizerLastFrameTs = ts;

        const analysis = hasAmbientPlayer() ? getAmbientAnalysis() : getSyntheticStreamingAnalysis();
        const energy = analysis.energy;
        if (analysis.kick) {
            kickPulse = 1;
        } else {
            kickPulse *= 0.9;
        }

        const center = (visualizerBars.length - 1) / 2;
        const kickLaneOffsets = new Set([0, 4, 8, 12, 16]);
        const time = performance.now() * 0.001;

        visualizerBars.forEach((bar, index) => {
            const dist = Math.abs(index - center) / center;
            const wave = (Math.sin(time * 1.1 + index * 0.48) + 1) * 0.5;
            const baseline = 1.8 + wave * 1.3;
            const drift = (0.28 + Math.random() * 0.36) * (0.18 + energy * 0.72);
            const roundedOffset = Math.round(Math.abs(index - center));
            const isKickLane = kickLaneOffsets.has(roundedOffset) || (index % 16 === 0);
            const centerWeight = 1 - Math.min(1, dist * 1.1);
            const kickBoost = isKickLane ? kickPulse * (12 + centerWeight * 22) : kickPulse * (0.9 + centerWeight * 1.6);
            const amplitude = baseline + drift * 4.2 + kickBoost;
            const height = Math.max(2, Math.min(40, Math.round(amplitude)));
            const opacity = Math.max(0.08, Math.min(0.78, 0.1 + energy * 0.16 + (isKickLane ? kickPulse * 0.44 : kickPulse * 0.04)));
            bar.style.height = `${height}px`;
            bar.style.opacity = opacity.toFixed(2);
        });

        visualizerRaf = requestAnimationFrame(renderVisualizerFrame);
    };

    sendYouTubeBridgeCommand = (command, payload = {}) => {
        // Every YouTube control in the UI funnels through here, so making this
        // one function remote-aware is what gives the remote dock the full
        // transport — volume, mute, loop and seek included — without touching
        // any of the individual handlers.
        if (isRemoteDockActive()) {
            postBus({
                type: 'wf-music-command',
                target: remoteSession.tabId,
                command: 'bridge',
                bridgeCommand: command,
                bridgePayload: payload,
            });
            return;
        }
        if (!currentPlayer || currentPlayerHost !== 'dock' || currentPlayer.id !== 'youtube-player') return;
        try {
            // Addressed to the bridge's own origin, not to whatever the frame
            // may have navigated to.
            let targetOrigin = '*';
            try { targetOrigin = new URL(currentPlayer.src).origin; } catch (_) { /* keep '*' */ }
            currentPlayer.contentWindow.postMessage({
                type: 'WF_BRIDGE_COMMAND',
                command,
                payload
            }, targetOrigin);
        } catch (error) {
            // Ignore messaging errors caused by frame lifecycle changes.
        }
    };

    const sendYouTubePlaylistNavCommand = (direction) => {
        const isNext = direction === 'next';
        const commandVariants = isNext
            ? ['nextTrack', 'nextVideo', 'playlistNext', 'next']
            : ['previousTrack', 'previousVideo', 'playlistPrev', 'prev'];
        commandVariants.forEach((cmd, index) => {
            window.setTimeout(() => sendYouTubeBridgeCommand(cmd), index * 55);
        });
        ['requestState', 'getState', 'syncState'].forEach((cmd, index) => {
            window.setTimeout(() => sendYouTubeBridgeCommand(cmd), 260 + (index * 90));
        });
    };

    const normalizeBridgeMessage = (raw) => {
        if (!raw) return null;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch (error) {
                return null;
            }
        }
        if (typeof raw === 'object') return raw;
        return null;
    };

    const applyYouTubeBridgeTrackUpdate = (payload = {}) => {
        if (!currentPlayer || currentPlayer.id !== 'youtube-player') return;
        const nextTitle = String(
            payload.title
            || payload.trackTitle
            || payload.videoTitle
            || payload.name
            || ''
        ).trim();
        const nextAuthor = String(
            payload.author
            || payload.trackAuthor
            || payload.channel
            || payload.owner
            || ''
        ).trim();
        const nextAuthorUrl = String(payload.authorUrl || payload.trackAuthorUrl || '').trim();
        const nextThumb = String(payload.thumbnailUrl || payload.trackThumb || payload.thumb || '').trim();

        if (nextTitle) {
            currentPlayer.dataset.trackTitle = nextTitle;
            safeSet('wf_music_name', nextTitle);
        }
        if (nextAuthor) currentPlayer.dataset.trackAuthor = nextAuthor;
        if (nextAuthorUrl) currentPlayer.dataset.trackAuthorUrl = nextAuthorUrl;
        if (nextThumb) currentPlayer.dataset.trackThumb = nextThumb;

        syncDockYouTubeMeta({
            title: currentPlayer.dataset.trackTitle,
            author: currentPlayer.dataset.trackAuthor,
            authorUrl: currentPlayer.dataset.trackAuthorUrl,
            thumbnailUrl: currentPlayer.dataset.trackThumb
        });
        updateMusicDockLabel();
        syncModalNowPlayingState();
    };

    const syncYouTubeVolumeUi = () => {
        if (modalYoutubeVolume) {
            modalYoutubeVolume.value = String(youtubeBridgeVolume);
            modalYoutubeVolume.style.setProperty('--volume-pct', `${youtubeBridgeVolume}%`);
        }
        if (modalYoutubeMuteBtn) {
            modalYoutubeMuteBtn.classList.toggle('active', youtubeBridgeMuted);
            modalYoutubeMuteBtn.textContent = youtubeBridgeMuted ? t('common_unmute') : t('common_mute');
        }
        if (dockYoutubeVolume) {
            dockYoutubeVolume.value = String(youtubeBridgeVolume);
            dockYoutubeVolume.style.setProperty('--volume-pct', `${youtubeBridgeVolume}%`);
        }
        if (dockYoutubeMuteBtn) {
            dockYoutubeMuteBtn.classList.toggle('active', youtubeBridgeMuted);
            dockYoutubeMuteBtn.innerHTML = youtubeBridgeMuted
                ? '<span class="material-symbols-outlined">volume_off</span>'
                : '<span class="material-symbols-outlined">volume_up</span>';
            dockYoutubeMuteBtn.title = youtubeBridgeMuted ? t('common_unmute') : t('common_mute');
        }
    };

    const syncDockYouTubeControls = () => {
        if (!dockYoutubeControls) return;
        const show = hasDockStreamingPlayer() && currentPlayer && currentPlayer.id === 'youtube-player';
        const showPlaylistControls = show && isYouTubePlaylist(currentPlayer);
        const showPlaylistInModal = showPlaylistControls && isPanelOpen;
        dockYoutubeControls.classList.toggle('show', show);
        dockYoutubeControls.classList.toggle('playlist-mode', showPlaylistControls);
        dockYoutubeControls.setAttribute('aria-hidden', show ? 'false' : 'true');
        if (modalYoutubeControls) {
            const showInModal = show && isPanelOpen;
            modalYoutubeControls.classList.toggle('show', showInModal);
            modalYoutubeControls.classList.toggle('playlist-mode', showPlaylistInModal);
            modalYoutubeControls.setAttribute('aria-hidden', showInModal ? 'false' : 'true');
        }
        if (modalYoutubePrevBtn) {
            modalYoutubePrevBtn.disabled = !showPlaylistInModal;
            modalYoutubePrevBtn.setAttribute('aria-hidden', showPlaylistInModal ? 'false' : 'true');
        }
        if (modalYoutubeNextBtn) {
            modalYoutubeNextBtn.disabled = !showPlaylistInModal;
            modalYoutubeNextBtn.setAttribute('aria-hidden', showPlaylistInModal ? 'false' : 'true');
        }
        if (dockYoutubePrevBtn) {
            dockYoutubePrevBtn.disabled = !showPlaylistControls;
            dockYoutubePrevBtn.setAttribute('aria-hidden', showPlaylistControls ? 'false' : 'true');
        }
        if (dockYoutubeNextBtn) {
            dockYoutubeNextBtn.disabled = !showPlaylistControls;
            dockYoutubeNextBtn.setAttribute('aria-hidden', showPlaylistControls ? 'false' : 'true');
        }
        if (playerDock) {
            playerDock.classList.toggle('youtube-meta-active', show);
            playerDock.classList.toggle('youtube-playlist-controls', showPlaylistControls);
        }
        if (dockYoutubeMeta) {
            dockYoutubeMeta.classList.toggle('show', show);
            dockYoutubeMeta.setAttribute('aria-hidden', show ? 'false' : 'true');
        }
        if (show) {
            syncDockYouTubeMeta();
        }

        // Loop button visible for all YouTube (not just playlists)
        if (dockYoutubeLoopBtn) {
            dockYoutubeLoopBtn.classList.toggle('is-hidden', !(show));
            dockYoutubeLoopBtn.classList.toggle('active', youtubeBridgeLoop);
            dockYoutubeLoopBtn.title = youtubeBridgeLoop ? t('dock_loop_on_title') : t('dock_loop_off_title');
        }
    };

    const syncDockYouTubeMeta = (preview = null) => {
        if (!dockYoutubeTitle || !dockYoutubeAuthor || !dockYoutubeThumb) return;

        const title =
            preview?.title
            || currentPlayer?.dataset.trackTitle
            || safeGet('wf_music_name')
            || t('music_youtube_mix');

        const author =
            preview?.author
            || extractMusicAuthor(preview?.subtitle || '', preview?.host || '')
            || currentPlayer?.dataset.trackAuthor
            || 'YouTube';

        const thumb = preview?.thumbnailUrl || currentPlayer?.dataset.trackThumb || '';
        const authorUrl = preview?.authorUrl || currentPlayer?.dataset.trackAuthorUrl || '';
        const cleanTitle = String(title || t('music_youtube_mix')).replace(/\s+/g, ' ').trim();
        const cleanAuthor = String(author || 'YouTube').replace(/\s+/g, ' ').trim();

        dockYoutubeTitle.textContent = cleanTitle || t('music_youtube_mix');
        dockYoutubeAuthor.textContent = cleanAuthor || 'YouTube';
        dockYoutubeAuthor.dataset.authorUrl = authorUrl || '';
        dockYoutubeAuthor.classList.toggle('is-link', !!authorUrl);
        if (authorUrl) {
            dockYoutubeAuthor.setAttribute('aria-label', t('dock_open_author_page_aria', { author: cleanAuthor || 'YouTube' }));
        } else {
            dockYoutubeAuthor.setAttribute('aria-label', t('dock_author_page_unavailable_aria'));
        }
        const safeThumbUrl = safeUrlForCss(thumb);
        dockYoutubeThumb.style.backgroundImage = safeThumbUrl ? `url("${safeThumbUrl}")` : '';
        dockYoutubeThumb.classList.toggle('has-image', !!safeThumbUrl);
    };

    const syncModalNowPlayingState = () => {
        if (!modalStreamStage || !modalStreamSource || !modalStreamTitle) return;
        const hasDockStreaming = hasDockStreamingPlayer();
        const hasModalStreaming = hasModalStreamingPlayer();
        const isNativeEmbedActive = !!(currentPlayer && isNativeEmbedPlayer(currentPlayer));
        const isYouTubeActive = !!(currentPlayer && currentPlayer.id === 'youtube-player');
        const shouldShow = isPanelOpen && !isNativeEmbedActive && (hasDockStreaming || hasModalStreaming);
        modalStreamStage.classList.toggle('show', shouldShow);
        modalStreamStage.classList.toggle('youtube-active', shouldShow && isYouTubeActive);
        if (!shouldShow || !currentPlayer) {
            if (modalStreamControls) {
                modalStreamControls.classList.add('hidden');
            }
            return;
        }

        const sourceFromId = currentPlayer.id === 'soundcloud-widget'
            ? 'SoundCloud'
            : currentPlayer.id === 'youtube-player'
                ? 'YouTube'
                : 'Spotify';
        const rawSourceLabel = (currentPlayer.dataset.sourceLabel || '').trim();
        const source = rawSourceLabel && !/wallsflow/i.test(rawSourceLabel) ? rawSourceLabel : sourceFromId;
        const savedName = safeGet('wf_music_name');
        modalStreamSource.textContent = source;
        modalStreamTitle.textContent = savedName || t('music_source_is_playing', { source });

        if (modalStreamSubtitle) {
            modalStreamSubtitle.textContent = isYouTubeActive
                ? t('music_stream_subtitle_youtube')
                : t('music_stream_subtitle_generic');
        }

        if (modalStreamControls) {
            modalStreamControls.classList.remove('hidden');
        }
    };

    const syncVisualizerPlayback = () => {
        initVisualizerBars();
        if (!visualizerStrip) return;
        // Remote sessions animate off getSyntheticStreamingAnalysis(), which is
        // purely procedural — no audio access needed, and it seeds from
        // wf_music_url, which the owner tab writes to shared localStorage. So a
        // remote tab draws the same pattern as the tab actually playing.
        const shouldShow = (hasStreamingPlayer() || isRemoteDockActive()) && !isPanelOpen && !dockIsHovered;
        visualizerStrip.classList.toggle('show', shouldShow);

        // Drive the RAF off `shouldShow`, not just `hasStreamingPlayer()`. Previously
        // the loop kept rendering 30fps × 64 bars even when the strip was hidden
        // behind the modal or under a hovered dock — pure CPU/GPU waste.
        if (shouldShow) {
            if (!visualizerRaf) {
                visualizerRaf = requestAnimationFrame(renderVisualizerFrame);
            }
        } else if (visualizerRaf) {
            cancelAnimationFrame(visualizerRaf);
            visualizerRaf = null;
            kickPulse = 0;
            visualizerBars.forEach((bar) => {
                bar.style.height = '4px';
                bar.style.opacity = '0.16';
            });
        }

        // Close the visualizer AudioContext when nothing is playing — it holds
        // system audio subsystem resources and analyser graph memory.
        if (!hasAnyActiveAudio() && visualizerAudioContext) {
            try {
                if (typeof visualizerAudioContext.close === 'function' && visualizerAudioContext.state !== 'closed') {
                    visualizerAudioContext.close().catch(() => {});
                }
            } catch (_) {}
            visualizerAudioContext = null;
            // Belongs to the context we just closed; a stale reference would be
            // reconnected into a fresh context on the next play and stay silent.
            ambientMasterNode = null;
        }
    };

    const setModalMotionEnabled = (enabled) => {
        const duration = enabled ? '' : '0s';
        if (musicPanel) {
            musicPanel.style.setProperty('--music-modal-motion-duration', duration);
        }
        if (musicModalBackdrop) {
            musicModalBackdrop.style.setProperty('--music-modal-motion-duration', duration);
        }
    };

    setMusicDockExpanded = (expanded) => {
        isDockExpanded = !!expanded;
        if (playerDock) {
            playerDock.classList.toggle('compact', !isDockExpanded);
        }
    };

    const syncDockRevealState = () => {
        if (!playerDock) return;
        const shouldHoverReveal = dockIsHovered && !isPanelOpen && (isYouTubePlayer() || isRemoteDockActive());
        playerDock.classList.toggle('hover-reveal', shouldHoverReveal);
    };

    const updateDockIdlePreview = () => {
        if (!playerDock || !playerContainer) return;
        const hasActivePlayer = hasDockStreamingPlayer() || isRemoteDockActive();
        const shouldShowIdlePreview = hasActivePlayer && !isPanelOpen && !dockIsHovered;
        playerDock.classList.toggle('idle-preview', shouldShowIdlePreview);
        syncDockRevealState();
        syncVisualizerPlayback();
    };

	    updateMusicDockLabel = () => {
	        if (!dockLabel) return;
	
	        if (hasDockStreamingPlayer()) {
                let source = currentPlayer.id === 'soundcloud-widget'
                    ? 'SoundCloud'
                    : currentPlayer.id === 'youtube-player'
                        ? 'YouTube'
                        : 'Spotify';

                const rawSourceLabel = (currentPlayer.dataset.sourceLabel || '').trim();
                if (rawSourceLabel && !/wallsflow/i.test(rawSourceLabel)) source = rawSourceLabel;
	            const savedName = safeGet('wf_music_name');
	            dockLabel.textContent = savedName || t('music_source_is_playing', { source });
                if (dockSource) dockSource.textContent = source;
	            return;
	        }

        if (activeSounds.size > 0) {
            dockLabel.textContent = t('music_ambient_sounds_active');
            if (dockSource) dockSource.textContent = t('music_source_ambient');
            return;
        }

	        dockLabel.textContent = t('common_no_playlist_playing');
            if (dockSource) dockSource.textContent = t('dock_idle');
	    };

    renderDockProgress = () => {
        if (!dockProgressRow || !dockProgressFill || !dockTimeCurrent || !dockTimeDuration) return;

        // A mirrored YouTube session carries the same position state a local
        // one does, so the bar is drawn identically — the only difference is
        // where the numbers came from.
        const hasPlayer = (hasDockStreamingPlayer() && currentPlayer && currentPlayer.id === 'youtube-player')
            || (isRemoteDockActive() && !!remoteSession.isYouTube);

        dockProgressRow.classList.toggle('show', hasPlayer);
        dockProgressRow.setAttribute('aria-hidden', hasPlayer ? 'false' : 'true');

        if (!hasPlayer) {
            stopProgressInterpolation();
            return;
        }

        dockProgressRow.classList.toggle('is-live', _positionIsLive);

        if (_positionIsLive) {
            const elapsed = _positionLastCurrentTime + (isMusicPaused ? 0 : (Date.now() - _positionLastBridgeTime) / 1000);
            dockTimeCurrent.textContent = formatTime(elapsed);
            dockTimeDuration.textContent = '';
        } else if (_positionDuration > 0) {
            const elapsed = isMusicPaused
                ? _positionLastCurrentTime
                : _positionLastCurrentTime + (Date.now() - _positionLastBridgeTime) / 1000;
            const clamped = Math.min(elapsed, _positionDuration);
            const pct = (clamped / _positionDuration) * 100;

            dockTimeCurrent.textContent = formatTime(clamped);
            dockTimeDuration.textContent = formatTime(_positionDuration);
            dockProgressFill.style.width = pct.toFixed(2) + '%';
        } else {
            dockTimeCurrent.textContent = '0:00';
            dockTimeDuration.textContent = '0:00';
            dockProgressFill.style.width = '0%';
        }
    };

    startProgressInterpolation = () => {
        if (_positionInterpolateRaf) return;
        // Was a 60fps RAF that only repainted on every 15th frame (~4fps) —
        // 60 RAF callbacks/sec for free even though the displayed text only
        // changes once per second. Replaced with a 1Hz setInterval that also
        // self-skips when the audio is paused or the tab is hidden.
        renderDockProgress(); // immediate paint so the bar doesn't lag the first second
        _positionInterpolateRaf = setInterval(() => {
            if (isMusicPaused) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            renderDockProgress();
        }, 1000);
    };

    stopProgressInterpolation = () => {
        if (_positionInterpolateRaf) {
            clearInterval(_positionInterpolateRaf);
            _positionInterpolateRaf = null;
        }
    };

    const applyMusicPreview = (preview, options = {}) => {
        const safePreview = preview && preview.valid ? preview : null;
        currentMusicPreview = safePreview;

        if (previewCard) {
            previewCard.classList.remove('spotify', 'soundcloud', 'youtube', 'empty');
            previewCard.classList.add(safePreview ? safePreview.source : 'empty');
        }

        if (previewSource) {
            previewSource.className = `music-preview-source ${safePreview ? safePreview.source : 'neutral'}`;
            previewSource.textContent = safePreview ? safePreview.sourceLabel : t('music_preview');
        }

        if (previewKind) {
            previewKind.textContent = safePreview ? displayTypeLabel(safePreview.typeLabel) : t('music_waiting_for_a_link');
        }

        if (previewTitle) {
            previewTitle.textContent = safePreview
                ? safePreview.title
                : t('music_paste_a_playlist_or_track');
        }

        if (previewSubtitle) {
            previewSubtitle.textContent = safePreview
                ? (safePreview.subtitle || safePreview.host || t('music_ready_to_save_or_play'))
                : t('music_we_auto_detect_the_platform');
        }

        if (previewArt) {
            const artText = safePreview ? (MUSIC_SOURCE_CONFIG[safePreview.source]?.art || 'WF') : 'WF';
            previewArt.textContent = artText;
            const safeArtUrl = safePreview ? safeUrlForCss(safePreview.thumbnailUrl) : '';
            previewArt.style.backgroundImage = safeArtUrl ? `url("${safeArtUrl}")` : '';
            previewArt.classList.toggle('has-image', !!safeArtUrl);
        }

        if (linkFeedback) {
            linkFeedback.classList.remove('is-valid', 'is-invalid');
            if (!musicUrlInput || !musicUrlInput.value.trim()) {
                linkFeedback.textContent = t('music_tip_use_paste_preview_with');
            } else if (safePreview) {
                // The kind of link is already on the preview card above. A
                // sentence built around a lower-cased label cannot be translated.
                linkFeedback.textContent = safePreview.source === 'youtube'
                    ? t('music_feedback_youtube_detected')
                    : t('music_feedback_detected', { source: safePreview.sourceLabel });
                linkFeedback.classList.add('is-valid');
            } else {
                linkFeedback.textContent = t('music_feedback_invalid');
                linkFeedback.classList.add('is-invalid');
            }
        }

        const shouldEnable = !!safePreview;
        if (playBtn) playBtn.disabled = !shouldEnable;
        if (saveBtn) saveBtn.disabled = !shouldEnable;

        if (options.persistName && safePreview?.title) {
            safeSet('wf_music_name', safePreview.title);
        }
    };

    const isAddSourcePanelOpen = () => !!(addSourceInlinePanel && !addSourceInlinePanel.classList.contains('hidden'));

    const openAddSourcePanel = (options = {}) => {
        if (!addSourceInlinePanel) return;
        const { focusInput = false } = options;
        addSourceInlinePanel.classList.remove('hidden');
        addSourceInlinePanel.setAttribute('aria-hidden', 'false');
        addSourceInlinePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (focusInput && musicUrlInput) {
            setTimeout(() => musicUrlInput.focus(), 60);
        }
    };

    const closeAddSourcePanel = () => {
        if (!addSourceInlinePanel) return;
        // While the library is empty the panel is the primary
        // affordance — CSS forces it visible via :has() and there's
        // no fallback view (no saved playlists) to close back to.
        // Skip the close so click-outside / X handlers can't desync
        // aria-hidden from the actual visual state.
        const emptyState = document.getElementById('user-playlist-empty');
        if (emptyState && !emptyState.classList.contains('hidden')) return;
        addSourceInlinePanel.classList.add('hidden');
        addSourceInlinePanel.setAttribute('aria-hidden', 'true');
    };

    if (addSourceInlinePanel) {
        document.addEventListener('wf:music-open-add-source', () => {
            if (isAddSourcePanelOpen()) {
                closeAddSourcePanel();
            } else {
                openAddSourcePanel({ focusInput: true });
            }
        });

        if (addSourceInlineCloseBtn) {
            addSourceInlineCloseBtn.addEventListener('click', () => closeAddSourcePanel());
        }

        document.addEventListener('pointerdown', (event) => {
            if (!isAddSourcePanelOpen()) return;
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (addSourceInlinePanel.contains(target)) return;
            if (target instanceof Element && target.closest('#my-library-quick-add')) return;
            closeAddSourcePanel();
        }, true);
    }

    const updateMusicPreviewFromInput = async () => {
        if (!musicUrlInput) return;
        const rawUrl = musicUrlInput.value.trim();
        const localToken = ++previewRequestToken;
        const basePreview = getMusicPreviewData(rawUrl);

        if (!basePreview.valid) {
            applyMusicPreview(null);
            return;
        }

        applyMusicPreview(basePreview);

        const enrichedPreview = await fetchMusicPreviewMetadata(basePreview);
        if (localToken !== previewRequestToken) return;
        applyMusicPreview(enrichedPreview);
    };

    const openMusicModal = () => {
        if (modalCloseCleanupTimer) {
            clearTimeout(modalCloseCleanupTimer);
            modalCloseCleanupTimer = null;
        }
        if (isPanelOpen) return;
        dockIsHovered = false;
        const hasNativePlayingInDock = hasDockStreamingPlayer() && currentPlayer && isNativeEmbedPlayer(currentPlayer);
        setModalMotionEnabled(!hasNativePlayingInDock);
        isPanelOpen = true;
        musicModalBackdrop.classList.add('show');
        musicPanel.classList.add('show');
        document.body.classList.add('music-modal-open');
        restoreAmbientMixOnOpen();
        if (hasModalStreamingPlayer() && activeMusicTab !== 'my-library') {
            const myLibraryBtn = document.querySelector('.music-tab-btn[data-tab="my-library"]');
            if (myLibraryBtn) myLibraryBtn.click();
        }
        setMusicDockExpanded(false);
        syncMusicPlayerPlacement();
        document.body.classList.add('modal-open');
    };

    const closeMusicModal = () => {
        if (modalCloseCleanupTimer) {
            clearTimeout(modalCloseCleanupTimer);
            modalCloseCleanupTimer = null;
        }
        closeAddSourcePanel();
        isPanelOpen = false;
        musicModalBackdrop.classList.remove('show');
        musicPanel.classList.remove('show');
        syncMusicPlayerPlacement();
        modalCloseCleanupTimer = setTimeout(() => {
            document.body.classList.remove('music-modal-open');
            document.body.classList.remove('modal-open');
            setModalMotionEnabled(true);
            syncMusicPlayerPlacement();
            modalCloseCleanupTimer = null;
        }, 260);

        if ((hasDockStreamingPlayer() || hasModalStreamingPlayer()) && playerDock) {
            playerDock.classList.add('attention-pulse');
            setTimeout(() => {
                if (playerDock) playerDock.classList.remove('attention-pulse');
            }, 1500);

            if (!safeGet('wf_music_dock_hint_seen')) {
                showPush(t('music_toast_dock_hint'), 'default');
                safeSet('wf_music_dock_hint_seen', 'true');
            }
        }
    };

    syncMusicPlayerPlacement = () => {
        if (!playerContainer || !playerDock) return;

        if (currentPlayer) {
            if (isYouTubePlayer(currentPlayer) && currentPlayerHost !== 'dock') {
                moveStreamingPlayerToHost('dock');
            } else if (isNativeEmbedPlayer(currentPlayer)) {
                // Keep native embeds mounted in dock to preserve uninterrupted playback.
                if (currentPlayerHost !== 'dock') {
                    moveStreamingPlayerToHost('dock');
                }
            }
        }

        const hasDockStreaming = hasDockStreamingPlayer();
        const isMusicWidgetDisabled = safeGet('musicHidden') === 'true';
        const hasDockNativeEmbed = hasDockStreaming && isNativeEmbedPlayer(currentPlayer);
        const shouldProjectNativeInModal = isPanelOpen && hasDockNativeEmbed && !!modalPlayerContainer;
        const isSpotifyProjected = shouldProjectNativeInModal && isSpotifyPlayer(currentPlayer);
        const isSoundCloudProjected = shouldProjectNativeInModal && isSoundCloudPlayer(currentPlayer);

        if (musicWidget) {
            // Hide the launcher only when the bottom dock is the active control surface.
            musicWidget.classList.toggle('hide', hasStreamingPlayer() || isMusicWidgetDisabled);
        }

        if (modalPlayerContainer) {
            modalPlayerContainer.classList.toggle('active', shouldProjectNativeInModal);
            modalPlayerContainer.classList.toggle('native-embed-proxy', shouldProjectNativeInModal);
            modalPlayerContainer.classList.toggle('spotify-proxy', isSpotifyProjected);
            modalPlayerContainer.classList.toggle('soundcloud-proxy', isSoundCloudProjected);
        }

        if (shouldProjectNativeInModal) {
            playerDock.classList.add('show');
            playerDock.classList.toggle('spotify-inline', isSpotifyProjected);
            playerDock.classList.toggle('soundcloud-inline', isSoundCloudProjected);
            setMusicDockExpanded(true);
        } else {
            resetDockFloatingPlacement();
            playerDock.classList.remove('spotify-inline', 'soundcloud-inline');
            playerDock.classList.toggle('show', hasDockStreaming);
            if (!hasDockStreaming) {
                setMusicDockExpanded(false);
            } else if (hasDockNativeEmbed) {
                setMusicDockExpanded(true);
            }
        }
        syncDockYouTubeControls();
        syncModalNowPlayingState();
        if (shouldProjectNativeInModal) {
            placeDockInModalSlot();
        }
        updateDockIdlePreview();
        updateMusicDockLabel();
        syncPauseButtonsUI();
        renderDockProgress();
        // Runs last: when a remote session is mirrored here it overrides the
        // idle labels the calls above just wrote.
        syncRemoteSessionUI();
    };

    // (~25 lines of `.music-preset-btn` handler + presetUrls/isPresetUrl
    //  branch lived here. The element class no longer exists in HTML —
    //  the side-menu preset row was retired in favor of .ambient-preset-btn,
    //  which uses its own renderer. The querySelectorAll returned an empty
    //  NodeList; the presetUrls.includes(savedUrl) check always returned
    //  false; the visual-feedback forEach iterated nothing. Smart-resume is
    //  unaffected — it doesn't depend on preset detection.)

    // Load saved URL but DON'T auto-play on page load
    const savedUrl = safeGet('wf_music_url');
    const smartResumeEnabled = safeGet(SMART_RESUME_ENABLED_KEY) !== 'false';
    const shouldSmartResume = smartResumeEnabled && safeGet(SMART_RESUME_WAS_PLAYING_KEY) === 'true';
    const canSmartResumeInThisTab = !isAnotherTabMusicOwner();
    if (savedUrl) {
        if (shouldSmartResume && canSmartResumeInThisTab) {
            // If Pomodoro Focus mode is currently running, skip smart resume —
            // the user chose ambient-only mode; focus mode will decide what plays.
            // We DON'T clear was_playing so the music resumes correctly when
            // focus mode ends (that path goes through pomodoro.exitFocusMode).
            let pomoFocusIsRunning = false;
            try {
                const pomoStateRaw = safeGet('wf_pomo_state');
                if (pomoStateRaw) {
                    const pomoState = JSON.parse(pomoStateRaw);
                    pomoFocusIsRunning = !!(pomoState &&
                        pomoState.status === 'running' &&
                        pomoState.phase === 'focus');
                }
            } catch (_) {}

            // Extract the resume action so it can also be triggered on-demand
            // (e.g. pomodoro.exitFocusMode when focus mode ends after a page reload
            // that suppressed smart resume initially)
            const performSmartResume = async (showToast) => {
                const basePreview = getMusicPreviewData(savedUrl);
                if (!basePreview.valid) return;
                if (basePreview.source !== 'youtube') {
                    safeSet(SMART_RESUME_WAS_PLAYING_KEY, 'false');
                    return;
                }
                const enrichedPreview = await fetchMusicPreviewMetadata(basePreview);
                const resumePreview = enrichedPreview?.valid ? enrichedPreview : basePreview;
                if (resumePreview.source !== 'youtube') {
                    safeSet(SMART_RESUME_WAS_PLAYING_KEY, 'false');
                    return;
                }
                const deferred = runWhenAudioAllowed(() => {
                    playMusic(savedUrl, resumePreview, { silentSkip: true });
                });
                if (deferred) {
                    // Say what is true, and what fixes it.
                    showPush(t('music_toast_paused_by_browser'), 'warning');
                } else if (showToast) {
                    showPush(t('music_toast_smart_resume'), 'default');
                }
            };

            // Expose so pomodoro.exitFocusMode can trigger resume when the iframe
            // wasn't created at initial boot (focus was active).
            window.wfTriggerSmartResume = function() { performSmartResume(false); };

            if (pomoFocusIsRunning) {
                // Leave was_playing=true; pomodoro will handle resume via the exposed
                // function when focus ends. Flag that streaming WAS active so pomodoro
                // knows to resume it.
                safeSet('wf_pomo_focus_streaming_pending', 'true');
            } else {
                setTimeout(function() { performSmartResume(true); }, 420);
            }
        }
        // (An `else if (shouldSmartResume && !canSmartResumeInThisTab)` branch
        //  used to clear SMART_RESUME_WAS_PLAYING_KEY here. That flag is global,
        //  not per-tab: merely opening a second tab while the first one was
        //  playing wiped the owner's "I was playing" state, so closing and
        //  reopening Chrome resumed nothing. Not resuming in THIS tab is
        //  already handled by not entering the branch above — there was never
        //  anything to clear.)
    }
    
    // Toggle modal
    const toggleModal = () => {
        if (isPanelOpen) {
            closeMusicModal();
        } else {
            openMusicModal();
        }
    };
    
    if (musicWidgetBtn) musicWidgetBtn.onclick = toggleModal;
    if (dockOpenBtn) dockOpenBtn.onclick = openMusicModal;

    // In remote mode these buttons drive the owner tab, not this one. The
    // remote branch is checked first because hasAnyActiveAudio() is false here
    // by definition — falling through would silently no-op.
    if (dockPauseBtn) dockPauseBtn.onclick = () => {
        if (hasRemoteSession() && !hasAnyActiveAudio()) {
            if (!remoteSession.canPause) {
                showPush(t('music_toast_remote_cannot_pause', { source: remoteSession.source }), 'warning');
                return;
            }
            sendRemoteCommand(remoteSession.paused ? 'resume' : 'pause');
            return;
        }
        togglePauseResume();
    };

    if (dockStopBtn) dockStopBtn.onclick = () => {
        if (hasRemoteSession() && !hasAnyActiveAudio()) {
            sendRemoteCommand('stop');
            clearRemoteSession();
            showPush(t('music_toast_remote_stopped'), 'default');
            return;
        }
        stopMusic();
    };

    // Click-to-seek on progress bar
    if (dockProgressRow) {
        const progressTrack = dockProgressRow.querySelector('.music-dock-progress-track');
        if (progressTrack) {
            progressTrack.addEventListener('click', (e) => {
                if (_positionIsLive || _positionDuration <= 0) return;
                const rect = progressTrack.getBoundingClientRect();
                // A zero-width rect (hidden/unlaid-out track) makes the division
                // NaN, which used to travel all the way to the bridge as a seek
                // to nowhere. Now it's a no-op.
                if (!(rect.width > 0)) return;
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const seekTime = pct * _positionDuration;
                if (!Number.isFinite(seekTime)) return;
                sendYouTubeBridgeCommand('seekTo', { time: seekTime });
                // Optimistic update
                _positionLastCurrentTime = seekTime;
                _positionLastBridgeTime = Date.now();
                renderDockProgress();
            });
        }
    }
    // (#music-dock-toggle and #music-dock-theme handlers were dead — see
    //  the matching comment on the missing element lookups above.)
    syncYouTubeVolumeUi();

    // Shared handler for both modal and dock YouTube volume sliders
    const handleYouTubeVolumeInput = (inputEl) => {
        youtubeBridgeVolume = Math.max(0, Math.min(100, Number(inputEl.value)));
        safeSet('wf_youtube_bridge_volume', String(youtubeBridgeVolume));
        syncYouTubeVolumeUi();
        sendYouTubeBridgeCommand('setVolume', { value: youtubeBridgeVolume });
        if (youtubeBridgeVolume > 0 && youtubeBridgeMuted) {
            youtubeBridgeMuted = false;
            safeSet('wf_youtube_bridge_muted', 'false');
            syncYouTubeVolumeUi();
            sendYouTubeBridgeCommand('setMuted', { value: false });
        }
    };

    if (modalYoutubeVolume) {
        modalYoutubeVolume.addEventListener('input', () => handleYouTubeVolumeInput(modalYoutubeVolume));
    }
    if (dockYoutubeVolume) {
        dockYoutubeVolume.addEventListener('input', () => handleYouTubeVolumeInput(dockYoutubeVolume));
    }
    if (modalYoutubeMuteBtn) {
        modalYoutubeMuteBtn.addEventListener('click', () => {
            youtubeBridgeMuted = !youtubeBridgeMuted;
            safeSet('wf_youtube_bridge_muted', youtubeBridgeMuted ? 'true' : 'false');
            syncYouTubeVolumeUi();
            sendYouTubeBridgeCommand('setMuted', { value: youtubeBridgeMuted });
        });
    }
    if (modalYoutubePrevBtn) {
        modalYoutubePrevBtn.addEventListener('click', () => {
            sendYouTubePlaylistNavCommand('prev');
        });
    }
    if (modalYoutubeNextBtn) {
        modalYoutubeNextBtn.addEventListener('click', () => {
            sendYouTubePlaylistNavCommand('next');
        });
    }
    if (dockYoutubePrevBtn) {
        dockYoutubePrevBtn.addEventListener('click', () => {
            if (hasRemoteSession() && !hasAnyActiveAudio()) return void sendRemoteCommand('prev');
            sendYouTubePlaylistNavCommand('prev');
        });
    }
    if (dockYoutubeNextBtn) {
        dockYoutubeNextBtn.addEventListener('click', () => {
            if (hasRemoteSession() && !hasAnyActiveAudio()) return void sendRemoteCommand('next');
            sendYouTubePlaylistNavCommand('next');
        });
    }
    if (modalPauseBtn) {
        modalPauseBtn.addEventListener('click', togglePauseResume);
    }
    if (modalStopBtn) {
        modalStopBtn.addEventListener('click', () => {
            stopMusic();
            syncModalNowPlayingState();
        });
    }
    if (dockYoutubeMuteBtn) {
        dockYoutubeMuteBtn.addEventListener('click', () => {
            youtubeBridgeMuted = !youtubeBridgeMuted;
            safeSet('wf_youtube_bridge_muted', youtubeBridgeMuted ? 'true' : 'false');
            syncYouTubeVolumeUi();
            sendYouTubeBridgeCommand('setMuted', { value: youtubeBridgeMuted });
        });
    }

    // Loop toggle
    if (dockYoutubeLoopBtn) {
        dockYoutubeLoopBtn.addEventListener('click', () => {
            youtubeBridgeLoop = !youtubeBridgeLoop;
            safeSet('wf_youtube_loop', youtubeBridgeLoop ? 'true' : 'false');
            sendYouTubeBridgeCommand('setLoop', { value: youtubeBridgeLoop });
            dockYoutubeLoopBtn.classList.toggle('active', youtubeBridgeLoop);
            dockYoutubeLoopBtn.title = youtubeBridgeLoop ? t('dock_loop_on_title') : t('dock_loop_off_title');
        });
    }

    // Empty state CTA — open add source panel
    const emptyStateCta = document.getElementById('user-playlist-empty-add');
    if (emptyStateCta) {
        emptyStateCta.addEventListener('click', () => {
            openAddSourcePanel({ focusInput: true });
        });
    }

    if (dockYoutubeAuthor) {
        dockYoutubeAuthor.addEventListener('click', () => {
            const authorUrl = dockYoutubeAuthor.dataset.authorUrl || '';
            if (!authorUrl) return;
            window.open(authorUrl, '_blank', 'noopener,noreferrer');
        });
    }
    if (playerDock) {
        playerDock.addEventListener('mouseenter', () => {
            dockIsHovered = true;
            updateDockIdlePreview();
        });

        playerDock.addEventListener('mouseleave', () => {
            dockIsHovered = false;
            updateDockIdlePreview();
        });
    }
    if (visualizerStrip) {
        visualizerStrip.addEventListener('mouseenter', () => {
            dockIsHovered = true;
            updateDockIdlePreview();
        });
        visualizerStrip.addEventListener('mouseleave', () => {
            dockIsHovered = false;
            updateDockIdlePreview();
        });
    }
    // Guard: prevent stacking duplicate global listeners if init runs more than once
    if (!window._wfMusicListenersInitialized) {
        window._wfMusicListenersInitialized = true;

        window.addEventListener('beforeunload', () => {
            persistSmartResumeState();
            // Persist last known position for timestamp resume — flush
            // immediately on unload so we never lose state across throttle.
            if (_lastKnownPosition && hasStreamingPlayer()) {
                writeMusicPositionImmediate();
            }
        });
        window.addEventListener('message', (event) => {
            if (!currentPlayer || currentPlayer.id !== 'youtube-player') return;
            if (!currentPlayer.contentWindow || event.source !== currentPlayer.contentWindow) return;
            const data = normalizeBridgeMessage(event.data);
            if (!data || typeof data !== 'object') return;
            const type = String(data.type || data.event || '').toUpperCase();
            if (!type) return;

            // Handle position updates from bridge
            if (type === 'WF_BRIDGE_POSITION') {
                const pos = data.payload || data;

                // End-of-track detection: state 0 = ended
                // For single videos (not playlists) when loop is OFF,
                // the bridge handles auto-replay when loop is ON.
                // When loop is OFF and track ends, stop progress interpolation.
                if (pos.state === 0 && !isYouTubePlaylist(currentPlayer)) {
                    // Single song with loop off → stop progress
                    if (!youtubeBridgeLoop) {
                        stopProgressInterpolation();
                        _positionLastCurrentTime = _positionDuration;
                        _positionLastBridgeTime = Date.now();
                        renderDockProgress();
                    }
                }

                // Update interpolation state for progress bar
                _positionIsLive = !!pos.isLive;
                _positionLastBridgeTime = Date.now();
                _positionLastCurrentTime = typeof pos.currentTime === 'number' ? pos.currentTime : 0;
                _positionDuration = pos.duration || 0;
                if (pos.state !== 0 && hasDockStreamingPlayer()) startProgressInterpolation();

                // Skip position persistence for live streams
                if (pos.isLive) {
                    _lastKnownPosition = null;
                    safeRemove('wf_music_position');

                    // Auto-update saved library entry to typeLabel 'Live' (once per playback)
                    if (!_liveTypeUpdateDone) {
                        _liveTypeUpdateDone = true;
                        const currentUrl = safeGet('wf_music_url');
                        if (currentUrl) {
                            const comparableUrl = getComparableMusicUrl(currentUrl);
                            const saved = getSavedPlaylists();
                            const match = saved.find(item => {
                                const itemUrl = getComparableMusicUrl(item.url);
                                return itemUrl === comparableUrl;
                            });
                            if (match && match.typeLabel !== 'Live') {
                                match.typeLabel = 'Live';
                                savePlaylists(saved);
                                refreshSavedPlaylists();
                            }
                        }
                    }

                    return;
                }
                if (typeof pos.currentTime === 'number') {
                    _lastKnownPosition = { time: pos.currentTime, duration: pos.duration || 0 };
                    // For playlists, also save the current videoId so we can resume the right track
                    if (pos.videoId) {
                        _lastKnownPosition.videoId = pos.videoId;
                    }
                    // Throttled — bridge fires ~1/sec while playing.
                    writeMusicPositionThrottled();
                }

                // Update dock meta when playlist auto-advances to a new track
                if (pos.videoId && pos.videoTitle && isYouTubePlaylist(currentPlayer)) {
                    const prevVideoId = currentPlayer.dataset.currentVideoId || '';
                    if (pos.videoId !== prevVideoId) {
                        currentPlayer.dataset.currentVideoId = pos.videoId;
                        applyYouTubeBridgeTrackUpdate({
                            title: pos.videoTitle,
                            videoId: pos.videoId
                        });
                    }
                }
                return;
            }

            const isTrackEvent =
                type.includes('TRACK')
                || type.includes('NOW_PLAYING')
                || type.includes('BRIDGE_STATE')
                || type.includes('PLAYER_STATE');
            if (!isTrackEvent) return;
            const payload = data.payload && typeof data.payload === 'object' ? data.payload : data;
            applyYouTubeBridgeTrackUpdate(payload);
        });
        // Debounce resize — fires 100+ times during window drag; we only need the final layout
        let _resizeDebounceTimer = null;
        window.addEventListener('resize', () => {
            if (!isPanelOpen) return;
            if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
            _resizeDebounceTimer = setTimeout(() => {
                syncMusicPlayerPlacement();
                _resizeDebounceTimer = null;
            }, 180);
        });
        if (typeof window.wfOnVisibilityChange === 'function') {
            window.wfOnVisibilityChange((hidden) => {
                if (hidden) {
                    persistSmartResumeState();
                    // Tab going hidden — flush immediately so that the next
                    // tab/window activation sees fresh resume state.
                    if (_lastKnownPosition && hasStreamingPlayer()) {
                        writeMusicPositionImmediate();
                    }
                    // Suspend the WebAudio analyser context while the tab is
                    // backgrounded — the graph idles ~1-3% CPU even with no
                    // frame being drawn, and suspend() drops that to 0.
                    //
                    // BUT only when no ambient sound is routed through it. An
                    // element passed to createMediaElementSource() is no longer
                    // on the direct output path, so suspending the context
                    // silences it outright. That produced a bug that only
                    // appeared with BOTH layers running: the visualizer loop is
                    // driven by hasStreamingPlayer(), and it calls
                    // getAmbientAnalysis(), which routes every ambient element
                    // into the graph. Ambient alone was never routed and kept
                    // playing; a playlist alone lives in an iframe outside the
                    // graph and kept playing; the two together went half-silent
                    // on every tab switch.
                    if (!hasAmbientPlayer() &&
                        visualizerAudioContext &&
                        typeof visualizerAudioContext.suspend === 'function' &&
                        visualizerAudioContext.state === 'running') {
                        visualizerAudioContext.suspend().catch(() => {});
                    }
                } else {
                    // Tab visible again — wake the analyser context if it
                    // was suspended above. Resume returns a Promise; we
                    // ignore failures (state may be 'closed' if all audio
                    // stopped while we were hidden).
                    if (visualizerAudioContext &&
                        typeof visualizerAudioContext.resume === 'function' &&
                        visualizerAudioContext.state === 'suspended') {
                        visualizerAudioContext.resume().catch(() => {});
                    }
                }
            });
        }
    }
    
    // Close modal
    musicPanelClose.onclick = closeMusicModal;
    
    // Click outside to close - using backdrop
    if (musicModalBackdrop) {
        musicModalBackdrop.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === musicModalBackdrop) {
                closeMusicModal();
            }
        });
    }
    
    // Play music
    playBtn.onclick = () => {
        const rawUrl = musicUrlInput.value.trim();
        const preview = currentMusicPreview || getMusicPreviewData(rawUrl);
        if (!preview.valid) {
            showPush(t('music_toast_paste_valid_link'), 'default');
            return;
        }

        safeSet('wf_music_name', preview.title);
        safeSet('wf_music_url', preview.normalizedUrl);
        playMusic(preview.normalizedUrl, preview);
    };
    
    // Enter key to play music
    if (musicUrlInput) {
        musicUrlInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                playBtn.click();
            }
        });

        musicUrlInput.addEventListener('input', () => {
            updateMusicPreviewFromInput();
        });
    }

    if (musicUrlClear && musicUrlInput) {
        musicUrlClear.addEventListener('click', () => {
            musicUrlInput.value = '';
            previewRequestToken += 1;
            applyMusicPreview(null);
            musicUrlInput.focus();
        });
    }

    if (musicUrlPaste && musicUrlInput) {
        if (!navigator.clipboard?.readText) {
            musicUrlPaste.classList.add('is-hidden');
        } else {
            musicUrlPaste.addEventListener('click', async () => {
                try {
                    const text = (await navigator.clipboard.readText()).trim();
                    if (!text) {
                        showPush(t('music_toast_clipboard_empty'), 'default');
                        return;
                    }
                    musicUrlInput.value = text;
                    musicUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
                    musicUrlInput.focus();
                } catch (error) {
                    showPush(t('music_toast_clipboard_blocked'), 'default');
                }
            });
        }
    }

    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isAddSourcePanelOpen()) {
            closeAddSourcePanel();
            return;
        }
        if (e.key === 'Escape' && isPanelOpen) {
            closeMusicModal();
        }
    });
    
    // (#music-stop-btn handler removed — id no longer in HTML.)

    // Save playlist button
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const preview = currentMusicPreview || getMusicPreviewData(musicUrlInput.value.trim());
            
            if (!preview.valid) {
                showPush(t('music_toast_paste_valid_first'), 'default');
                return;
            }
            
            // Get saved playlists
            const savedPlaylists = await getSavedPlaylists();
            if (savedPlaylists.length >= MAX_SAVED_SOURCES) {
                showPush(t('music_toast_library_full', { count: MAX_SAVED_SOURCES }), 'warning');
                return;
            }
            const alreadySaved = savedPlaylists.some((item) => {
                const existingPreview = getMusicPreviewData(item.url);
                const existingNormalized = existingPreview.valid ? existingPreview.normalizedUrl : normalizeMusicUrl(item.url);
                return existingNormalized === preview.normalizedUrl;
            });
            if (alreadySaved) {
                showPush(t('music_toast_already_in_library'), 'warning');

                // Shake the preview card
                const previewCardEl = document.getElementById('music-preview-card');
                if (previewCardEl) {
                    previewCardEl.classList.add('duplicate-shake');
                    setTimeout(() => previewCardEl.classList.remove('duplicate-shake'), 600);
                }

                // Flash the input red
                if (musicUrlInput) {
                    musicUrlInput.classList.add('duplicate-error');
                    setTimeout(() => musicUrlInput.classList.remove('duplicate-error'), 2000);
                }

                // Scroll to and highlight the existing card in the grid
                const grid = document.getElementById('user-playlist-grid');
                if (grid) {
                    const existingCard = Array.from(grid.querySelectorAll('.saved-playlist-card')).find(c => {
                        const cardUrl = c.dataset.url || '';
                        return getComparableMusicUrl(cardUrl) === preview.normalizedUrl;
                    });
                    if (existingCard) {
                        existingCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        existingCard.classList.add('duplicate-flash');
                        setTimeout(() => existingCard.classList.remove('duplicate-flash'), 2500);
                    }
                }

                return;
            }
            
            // Save new playlist
            const newPlaylist = {
                id: Date.now(),
                name: preview.title || t('music_untitled_playlist'),
                url: preview.normalizedUrl,
                source: preview.source,
                sourceLabel: preview.sourceLabel,
                typeLabel: preview.typeLabel,
                subtitle: preview.subtitle || '',
                authorName: preview.authorName || '',
                authorUrl: preview.authorUrl || '',
                thumbnailUrl: preview.thumbnailUrl
            };
            
            savedPlaylists.unshift(newPlaylist);
            const stored = await savePlaylists(savedPlaylists);
            if (!stored) {
                showPush(t('music_toast_save_failed'), 'warning');
                return;
            }
            
            // Clear input
            musicUrlInput.value = '';
            previewRequestToken += 1;
            applyMusicPreview(null);
            closeAddSourcePanel();
            
            // Refresh list
            refreshSavedPlaylists();
            showPush(t('music_toast_saved'), 'success');
        };
    }
    
    // Load saved playlists on init
    refreshSavedPlaylists();
    applyMusicPreview(null);
    
    const mountStreamingPlayer = (config) => {
        if (!playerContainer) return false;

        const preferredHost = config.host === 'modal' ? 'modal' : 'dock';
        const targetHost = preferredHost === 'modal' && modalPlayerContainer ? 'modal' : 'dock';
        const targetContainer = targetHost === 'modal' ? modalPlayerContainer : playerContainer;
        if (!targetContainer) return false;

        resetStreamingContainer();
        const iframe = document.createElement('iframe');
        iframe.id = config.id;
        iframe.src = config.src;
        iframe.width = '100%';
        iframe.height = String(config.height || 152);
        iframe.frameBorder = '0';
        iframe.allow = config.allow || 'autoplay; encrypted-media; picture-in-picture';
        iframe.loading = 'eager';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.title = config.title || t('music_player_frame_title');
        iframe.dataset.sourceLabel = config.sourceLabel || t('music_source_generic');
        iframe.dataset.trackTitle = config.trackTitle || '';
        iframe.dataset.trackAuthor = config.trackAuthor || '';
        iframe.dataset.trackAuthorUrl = config.trackAuthorUrl || '';
        iframe.dataset.trackThumb = config.trackThumb || '';
        if (config.sandbox) {
            iframe.sandbox = config.sandbox;
        }

        targetContainer.appendChild(iframe);
        targetContainer.classList.add('active');
        if (config.containerModeClass && targetHost === 'dock') {
            targetContainer.classList.add(config.containerModeClass);
        }

        currentPlayer = iframe;
        currentPlayerHost = targetHost;
        syncMusicPlayerPlacement();

        // For YouTube, force lowest video quality after the bridge loads to minimize
        // CPU/GPU cost. Retry a few times because the YouTube player inside the
        // bridge may not be ready immediately. Harmless if bridge doesn't implement it.
        if (config.id === 'youtube-player') {
            const forceLowQuality = () => {
                try {
                    if (typeof sendYouTubeBridgeCommand === 'function') {
                        sendYouTubeBridgeCommand('setPlaybackQuality', { value: 'tiny' });
                    }
                } catch (_) {}
            };
            iframe.addEventListener('load', () => {
                forceLowQuality();
                setTimeout(forceLowQuality, 1500);
                setTimeout(forceLowQuality, 4000);
            }, { once: true });
        }

        return true;
    };

    const extractSpotifyEntity = (value) => {
        const url = String(value || '').trim();
        if (!url) return { type: '', id: '' };

        const uriMatch = url.match(/spotify:(playlist|track|album):([A-Za-z0-9]+)/i);
        if (uriMatch) {
            return {
                type: uriMatch[1].toLowerCase(),
                id: uriMatch[2]
            };
        }

        const pathMatch = url.match(/\/(?:embed\/)?(playlist|track|album)\/([A-Za-z0-9]+)/i);
        if (pathMatch) {
            return {
                type: pathMatch[1].toLowerCase(),
                id: pathMatch[2]
            };
        }

        return { type: '', id: '' };
    };

    const buildSpotifyEmbedUrl = (preview, rawUrl) => {
        if (preview?.embedUrl) {
            return preview.embedUrl;
        }

        const url = String(rawUrl || '').trim();
        const { type, id } = extractSpotifyEntity(url);

        if (type && id) {
            return `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`;
        }

        if (url) {
            return `https://open.spotify.com/embed?uri=${encodeURIComponent(url)}&utm_source=generator&theme=0`;
        }

        return '';
    };

    // options.allowTakeover — the user has already confirmed stopping the other
    //   tab, so skip the prompt (set when re-entering from the modal).
    // options.silentSkip — automated paths (smart resume, pomodoro focus exit)
    //   that must never pop a modal on their own. If another tab owns the
    //   session they simply stand down.
    function playMusic(url, previewOverride = null, options = {}) {
        const preview = previewOverride?.valid ? previewOverride : getMusicPreviewData(url);
        if (!preview.valid) {
            showPush(t('music_toast_unsupported_url'), 'default');
            return;
        }

        if (isAnotherTabMusicOwner() && !options.allowTakeover) {
            if (options.silentSkip) return;
            openTakeoverModal(
                {
                    sourceLabel: remoteSession?.source || preview.sourceLabel,
                    trackName: remoteSession?.name || '',
                },
                () => playMusic(url, previewOverride, { ...options, allowTakeover: true })
            );
            return;
        }

        // Taking over deliberately: tell the previous owner to tear down before
        // we claim the lock, so it stops cleanly instead of being cut off by
        // the storage event mid-write.
        if (hasRemoteSession()) {
            sendRemoteCommand('stop', { reason: 'takeover', from: musicTabId });
            clearRemoteSession();
        }

        // Reset pause state for new playback
        isMusicPaused = false;

        // Keep one playback surface active: when starting streamed content,
        // stop any ambient layers that may already be running.
        if (activeSounds.size > 0) {
            stopAllAmbientSounds();
        }

        claimMusicOwnership();
        const safeUrl = preview.normalizedUrl || url;
        configureSyntheticBeat(safeUrl);

        // Clear saved position if playing a different URL
        const previousUrl = safeGet('wf_music_url');
        if (previousUrl !== safeUrl) {
            safeRemove('wf_music_position');
            _lastKnownPosition = null;
        }

        safeSet('wf_music_url', safeUrl);
        // Only YouTube is allowed to auto-resume.
        safeSet(SMART_RESUME_WAS_PLAYING_KEY, preview.source === 'youtube' ? 'true' : 'false');
        // options.displayName is the library card's own label, which the user
        // may have renamed — prefer it over the provider's title. Written here
        // rather than by the caller so a cancelled takeover can't leave the
        // now-playing metadata pointing at a track that never started.
        const resolvedName = options.displayName || preview.title;
        if (resolvedName) {
            safeSet('wf_music_name', resolvedName);
        }

        if (preview.source === 'spotify') {
            playSpotify(safeUrl, preview);
        } else if (preview.source === 'soundcloud') {
            playSoundCloud(safeUrl, preview);
        } else if (preview.source === 'youtube') {
            playYouTube(safeUrl, preview);
        } else {
            showPush(t('music_toast_unsupported_url'), 'default');
            return;
        }

        const musicBtn = document.querySelector('.music-widget-btn');
        if (musicBtn) {
            musicBtn.classList.add('playing');
        }

        const shouldKeepDockExpanded = preview.source === 'spotify' || preview.source === 'soundcloud';
        setMusicDockExpanded(shouldKeepDockExpanded);
        updateMusicDockLabel();
        syncMusicPlayerPlacement();
        syncActiveLibraryPlaybackCard(safeUrl);
        broadcastMusicState();
    }

    // Set global reference to playMusic for use in saved playlists
    globalPlayMusic = playMusic;

    // (playMusicWithUserGesture lived here — created an AudioContext to
    //  resume it on a user gesture, then forwarded to playMusic. Nothing
    //  ever called this wrapper; the gesture-resume work happens inside
    //  ensureAudioAnalyser() at the actual point of need.)

    function resetStreamingContainer() {
        if (playerContainer) {
            playerContainer.innerHTML = '';
            playerContainer.classList.remove('active', 'youtube-audio-mode', 'youtube-video-mode', 'youtube-meta-mode', 'native-embed');
        }
        if (modalPlayerContainer) {
            modalPlayerContainer.innerHTML = '';
            modalPlayerContainer.classList.remove('active', 'native-embed');
        }
        currentPlayer = null;
        currentPlayerHost = null;
    }

    function playSpotify(url, preview = null) {
        const embedUrl = buildSpotifyEmbedUrl(preview, url);
        if (!embedUrl) {
            showPush(t('music_toast_invalid_spotify'), 'default');
            return;
        }

        const mounted = mountStreamingPlayer({
            id: 'spotify-player',
            src: embedUrl,
            sourceLabel: 'Spotify',
            height: 152,
            // Matches Spotify's own "Copy embed code" output. `autoplay` was
            // missing, and without it the Permissions Policy denies playback
            // start outright — a hard block, separate from the user-gesture
            // heuristics. SoundCloud and YouTube already declare it below.
            allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
            host: 'dock',
            title: preview?.title || t('music_player_spotify_frame_title')
        });

        if (mounted) {
            showPush(isPanelOpen ? t('music_toast_spotify_loaded_panel') : t('music_toast_spotify_ready_dock'), 'success');
        }
    }

    function playSoundCloud(url, preview = null) {
        const embedUrl = preview?.embedUrl
            || `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=true&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true`;

        const mounted = mountStreamingPlayer({
            id: 'soundcloud-widget',
            src: embedUrl,
            sourceLabel: 'SoundCloud',
            height: 166,
            allow: 'autoplay',
            host: 'dock',
            title: preview?.title || t('music_player_soundcloud_frame_title')
        });

        if (mounted) {
            showPush(t('music_toast_soundcloud_ready'), 'success');
        }
    }

    function playYouTube(url, preview = null) {
        const resolvedPreview = preview?.valid ? preview : getMusicPreviewData(url);
        if (!resolvedPreview.valid || resolvedPreview.source !== 'youtube' || !resolvedPreview.embedUrl) {
            showPush(t('music_toast_invalid_youtube'), 'default');
            return;
        }

        const bridgeUrl = buildYouTubeBridgeUrl(resolvedPreview);
        const directUrl = `${resolvedPreview.embedUrl}&mute=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}&widget_referrer=${encodeURIComponent(window.location.href)}&modestbranding=1&iv_load_policy=3`;
        const initialAuthor = extractMusicAuthor(resolvedPreview.subtitle, resolvedPreview.host);
        syncDockYouTubeMeta({
            title: resolvedPreview.title,
            subtitle: resolvedPreview.subtitle,
            host: resolvedPreview.host,
            author: initialAuthor,
            authorUrl: resolvedPreview.authorUrl || '',
            thumbnailUrl: resolvedPreview.thumbnailUrl
        });

        const mounted = mountStreamingPlayer({
            id: 'youtube-player',
            src: bridgeUrl || directUrl,
            sourceLabel: 'YouTube',
            height: 1,
            allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
            containerModeClass: 'youtube-meta-mode',
            title: resolvedPreview.title || t('music_player_youtube_frame_title'),
            trackTitle: resolvedPreview.title || t('music_youtube_mix'),
            trackAuthor: initialAuthor || 'YouTube',
            trackAuthorUrl: resolvedPreview.authorUrl || '',
            trackThumb: resolvedPreview.thumbnailUrl || ''
        });

        if (!mounted || !currentPlayer) {
            showPush(t('music_toast_youtube_container_missing'), 'default');
            return;
        }
        currentPlayer.dataset.youtubePlaylist = resolvedPreview.listId ? 'true' : 'false';
        syncDockYouTubeControls();

        fetchMusicPreviewMetadata(resolvedPreview).then((enriched) => {
            if (!enriched || !enriched.valid || !currentPlayer || currentPlayer.id !== 'youtube-player') return;
            const enrichedAuthor = extractMusicAuthor(enriched.subtitle, enriched.host);
            currentPlayer.dataset.trackTitle = enriched.title || resolvedPreview.title || t('music_youtube_mix');
            currentPlayer.dataset.trackAuthor = enrichedAuthor || initialAuthor || 'YouTube';
            currentPlayer.dataset.trackAuthorUrl = enriched.authorUrl || resolvedPreview.authorUrl || '';
            currentPlayer.dataset.trackThumb = enriched.thumbnailUrl || resolvedPreview.thumbnailUrl || '';
            syncDockYouTubeMeta({
                title: currentPlayer.dataset.trackTitle,
                author: currentPlayer.dataset.trackAuthor,
                authorUrl: currentPlayer.dataset.trackAuthorUrl,
                thumbnailUrl: currentPlayer.dataset.trackThumb
            });
            if (enriched.title) {
                safeSet('wf_music_name', enriched.title);
                updateMusicDockLabel();
            }
        }).catch(() => {
            // Keep base metadata when oEmbed fails.
        });

        syncYouTubeVolumeUi();
        currentPlayer.addEventListener('load', () => {
            const sendInitialBridgeState = () => {
                sendYouTubeBridgeCommand('setVolume', { value: youtubeBridgeVolume });
                sendYouTubeBridgeCommand('setMuted', { value: youtubeBridgeMuted });
            };
            sendInitialBridgeState();
            setTimeout(sendInitialBridgeState, 300);
            setTimeout(sendInitialBridgeState, 800);
        });

        if (bridgeUrl) {
            showPush(resolvedPreview.typeLabel === 'Playlist' ? t('music_toast_youtube_playlist_started') : t('music_toast_youtube_started'), 'success');
        } else {
            showPush(t('music_toast_youtube_direct_embed'), 'default');
        }
    }
    
    // ============= NEW TAB SYSTEM =============
    
    // Tab functionality
    const tabBtns = document.querySelectorAll('.music-tab-btn');
    const tabContents = document.querySelectorAll('.music-tab-content');
    const activeTabBtn = document.querySelector('.music-tab-btn.active');
    if (activeTabBtn) {
        activeMusicTab = activeTabBtn.getAttribute('data-tab') || 'sounds';
    }
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');

            // Update active tab
            tabBtns.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            document.getElementById(targetTab + '-tab').classList.add('active');
            activeMusicTab = targetTab;
            const hasNativeEmbedInModal = isPanelOpen && currentPlayer && isNativeEmbedPlayer(currentPlayer);
            if (!hasNativeEmbedInModal) {
                syncMusicPlayerPlacement();
            }
        });
    });
    
    // Sound cards functionality
    const soundCards = document.querySelectorAll('.sound-card');
    const ambientMixBar = document.getElementById('ambient-mix-bar');
    const ambientMixTitle = document.getElementById('ambient-mix-title');
    const ambientMixSubtitle = document.getElementById('ambient-mix-subtitle');
    const ambientMixChips = document.getElementById('ambient-mix-chips');
    const ambientCategoryRow = document.getElementById('ambient-category-row');
    const ambientPresetRow = document.getElementById('ambient-preset-row');
    const ambientMuteAllBtn = document.getElementById('ambient-mute-all-btn');
    const ambientStopAllBtn = document.getElementById('ambient-stop-all-btn');
    const AMBIENT_MUTED_KEY = STORAGE_KEYS.MUSIC_AMBIENT_MUTED;
    const AMBIENT_MIX_STATE_KEY = STORAGE_KEYS.MUSIC_AMBIENT_MIX_STATE;
    let ambientMuted = safeGet(AMBIENT_MUTED_KEY) === 'true';
    let ambientSelectedCategory = 'all';
    let ambientBulkMode = false;
    let ambientMixAutoRestored = false;
    let pendingAmbientMixState = null;
    // Labels are read when the buttons are drawn, so they follow the language.
    const AMBIENT_CATEGORY_LABELS = {
        all: () => t('music_category_all'),
        nature: () => t('music_category_nature'),
        water: () => t('music_category_water'),
        transport: () => t('music_category_travel'),
        urban: () => t('music_category_city'),
        cozy: () => t('music_category_cozy'),
        night: () => t('music_category_night'),
        focus: () => t('music_category_focus')
    };
    const AMBIENT_SOUND_CATEGORY_MAP = {
        rain: 'water',
        beach: 'water',
        river: 'water',
        waterfall: 'water',
        storm: 'nature',
        birds: 'nature',
        forest: 'nature',
        desert: 'nature',
        swamp: 'nature',
        campfire: 'cozy',
        city: 'urban',
        city_night: 'urban',
        plane: 'transport',
        train: 'transport',
        submarine: 'transport',
        playground: 'urban',
        vinyl: 'cozy',
        night: 'night',
        chimes: 'focus',
        chimes_wav: 'focus',
        white_noise: 'focus',
        bar: 'cozy',
        end_sound_timer: 'focus'
    };
    const AMBIENT_PRESETS = [
        {
            key: 'deep-focus',
            label: () => t('ambient_preset_deep_focus'),
            sounds: [
                { sound: 'rain', volume: 46 },
                { sound: 'white_noise', volume: 36 },
                { sound: 'vinyl', volume: 18 }
            ]
        },
        {
            key: 'night-lofi',
            label: () => t('ambient_preset_night_lofi'),
            sounds: [
                { sound: 'night', volume: 45 },
                { sound: 'city_night', volume: 32 },
                { sound: 'chimes', volume: 24 }
            ]
        },
        {
            key: 'cafe-study',
            label: () => t('ambient_preset_cafe_study'),
            sounds: [
                { sound: 'bar', volume: 46 },
                { sound: 'rain', volume: 28 },
                { sound: 'vinyl', volume: 22 }
            ]
        },
        {
            key: 'nature-calm',
            label: () => t('ambient_preset_nature_calm'),
            sounds: [
                { sound: 'forest', volume: 42 },
                { sound: 'birds', volume: 38 },
                { sound: 'river', volume: 34 }
            ]
        }
    ];

    try {
        const rawAmbientState = safeGet(AMBIENT_MIX_STATE_KEY);
        if (rawAmbientState) {
            pendingAmbientMixState = JSON.parse(rawAmbientState);
        }
    } catch (error) {
        pendingAmbientMixState = null;
    }

    const getSoundCard = (soundType) => document.querySelector(`.sound-card[data-sound="${soundType}"]`);

    const ensureSoundBadge = (card) => {
        if (!card) return null;
        let badge = card.querySelector('.sound-state-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sound-state-badge';
            badge.setAttribute('aria-hidden', 'true');
            card.appendChild(badge);
        }
        return badge;
    };

    const setSoundCardState = (card, state) => {
        if (!card) return;
        const safeState = state || 'off';
        card.dataset.state = safeState;
        const badge = ensureSoundBadge(card);
        if (!badge) return;
        if (safeState === 'loading') {
            badge.textContent = t('music_badge_starting');
            return;
        }
        if (safeState === 'playing') {
            badge.textContent = t('music_badge_playing');
            return;
        }
        if (safeState === 'muted') {
            badge.textContent = t('music_badge_muted');
            return;
        }
        badge.textContent = t('music_badge_off');
    };

    const syncAmbientCardStates = () => {
        soundCards.forEach((card) => {
            const soundType = card.getAttribute('data-sound');
            if (card.classList.contains('loading')) {
                setSoundCardState(card, 'loading');
                return;
            }
            if (activeSounds.has(soundType)) {
                setSoundCardState(card, ambientMuted ? 'muted' : 'playing');
                return;
            }
            setSoundCardState(card, 'off');
        });
    };

    const persistAmbientMixState = () => {
        const sounds = [];
        activeSounds.forEach((_, soundType) => {
            const card = getSoundCard(soundType);
            const slider = card?.querySelector('.sound-volume');
            const rawVolume = Number(slider?.value ?? 50);
            const volume = Number.isFinite(rawVolume)
                ? Math.max(0, Math.min(AMBIENT_MAX_VOLUME_PCT, rawVolume))
                : 50;
            sounds.push({ sound: soundType, volume });
        });
        sounds.sort((a, b) => a.sound.localeCompare(b.sound));
        const snapshot = {
            muted: !!ambientMuted,
            sounds
        };
        if (!safeSet(AMBIENT_MIX_STATE_KEY, JSON.stringify(snapshot)) && !_ambientPersistWarned) {
            // Once per tab: the slider keeps firing and a toast per tick
            // would drown the page.
            _ambientPersistWarned = true;
            showPush(t('music_toast_ambient_save_failed'), 'warning');
        }
    };
    let _ambientPersistWarned = false;

    // Debounced variant for hot paths like slider drag (`input` fires
    // ~60Hz). Card click and start/stop transitions still call the immediate
    // persistAmbientMixState() so state is flushed at every meaningful
    // boundary. The drag-only path now coalesces into a single write 250ms
    // after the user lets go of the slider.
    let _persistMixDebounceTimer = null;
    const persistAmbientMixStateDebounced = () => {
        if (_persistMixDebounceTimer) clearTimeout(_persistMixDebounceTimer);
        _persistMixDebounceTimer = setTimeout(() => {
            _persistMixDebounceTimer = null;
            persistAmbientMixState();
        }, 250);
    };

    const applyPendingAmbientState = ({ autoplay = false } = {}) => {
        if (!pendingAmbientMixState || typeof pendingAmbientMixState !== 'object') return;
        const sounds = Array.isArray(pendingAmbientMixState.sounds) ? pendingAmbientMixState.sounds : [];
        const muted = !!pendingAmbientMixState.muted;

        ambientMuted = muted;
        safeSet(AMBIENT_MUTED_KEY, ambientMuted ? 'true' : 'false');
        updateAmbientMuteButtonState();
        applyAmbientMutedState();

        sounds.forEach((entry) => {
            if (!entry || typeof entry.sound !== 'string') return;
            const card = getSoundCard(entry.sound);
            if (!card) return;
            const slider = card.querySelector('.sound-volume');
            if (!slider) return;
            const rawVolume = Number(entry.volume);
            const volume = Number.isFinite(rawVolume)
                ? Math.max(0, Math.min(AMBIENT_MAX_VOLUME_PCT, rawVolume))
                : 50;
            slider.value = String(volume);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });

        if (!autoplay || sounds.length === 0 || isAnotherTabMusicOwner()) {
            syncAmbientCardStates();
            return;
        }

        ambientBulkMode = true;
        sounds.forEach((entry) => {
            const soundType = entry?.sound;
            if (!soundType || activeSounds.has(soundType)) return;
            const card = getSoundCard(soundType);
            if (card) card.click();
        });
        setTimeout(() => {
            ambientBulkMode = false;
            updateAmbientMixBar();
            persistAmbientMixState();
            syncAmbientCardStates();
        }, 900);
    };

    restoreAmbientMixOnOpen = () => {
        if (ambientMixAutoRestored || !pendingAmbientMixState) return;
        if (isAnotherTabMusicOwner()) return;
        ambientMixAutoRestored = true;
        applyPendingAmbientState({ autoplay: true });
    };

    const assignAmbientSoundCategories = () => {
        soundCards.forEach((card) => {
            const soundType = card.getAttribute('data-sound');
            card.dataset.category = AMBIENT_SOUND_CATEGORY_MAP[soundType] || 'focus';
        });
    };

    const applyAmbientCategoryFilter = (category) => {
        ambientSelectedCategory = category || 'all';
        soundCards.forEach((card) => {
            const cardCategory = card.dataset.category || 'focus';
            const shouldHide = ambientSelectedCategory !== 'all' && cardCategory !== ambientSelectedCategory;
            card.classList.toggle('ambient-hidden', shouldHide);
        });
        if (!ambientCategoryRow) return;
        ambientCategoryRow.querySelectorAll('.ambient-category-btn').forEach((btn) => {
            const isActive = btn.getAttribute('data-category') === ambientSelectedCategory;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    };

    const renderAmbientCategoryButtons = () => {
        if (!ambientCategoryRow) return;
        ambientCategoryRow.innerHTML = '';
        const counts = { all: soundCards.length };
        soundCards.forEach((card) => {
            const category = card.dataset.category || 'focus';
            counts[category] = (counts[category] || 0) + 1;
        });

        Object.entries(AMBIENT_CATEGORY_LABELS).forEach(([key, label]) => {
            if (!counts[key]) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ambient-category-btn';
            button.setAttribute('data-category', key);
            button.setAttribute('aria-pressed', key === ambientSelectedCategory ? 'true' : 'false');
            // Render label + count as a pill badge (mirrors menu wallpapers-filter-btn).
            // Avoids the inline "(N)" parentheses that read as part of the label.
            const labelText = document.createTextNode(label());
            const countSpan = document.createElement('span');
            countSpan.className = 'filter-count';
            countSpan.textContent = String(counts[key]);
            button.appendChild(labelText);
            button.appendChild(countSpan);
            button.addEventListener('click', () => applyAmbientCategoryFilter(key));
            ambientCategoryRow.appendChild(button);
        });
    };

    const applyAmbientPreset = (presetKey) => {
        const preset = AMBIENT_PRESETS.find((entry) => entry.key === presetKey);
        if (!preset) return;

        ambientBulkMode = true;
        stopAllAmbientSounds();

        preset.sounds.forEach(({ sound, volume }) => {
            const card = document.querySelector(`.sound-card[data-sound="${sound}"]`);
            if (!card) return;

            const slider = card.querySelector('.sound-volume');
            if (slider && typeof volume === 'number') {
                slider.value = String(Math.max(0, Math.min(AMBIENT_MAX_VOLUME_PCT, volume)));
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }

            if (!activeSounds.has(sound)) {
                card.click();
            }
        });

        if (ambientPresetRow) {
            ambientPresetRow.querySelectorAll('.ambient-preset-btn').forEach((btn) => {
                const isActive = btn.getAttribute('data-preset') === presetKey;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
        }

        setTimeout(() => {
            ambientBulkMode = false;
            updateAmbientMixBar();
            persistAmbientMixState();
            syncAmbientCardStates();
        }, 1200);
        showPush(t('music_toast_preset_active', { preset: preset.label() }), 'default');
    };

    const renderAmbientPresetButtons = () => {
        if (!ambientPresetRow) return;
        ambientPresetRow.innerHTML = '';
        AMBIENT_PRESETS.forEach((preset) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ambient-preset-btn';
            button.setAttribute('data-preset', preset.key);
            button.setAttribute('aria-pressed', 'false');
            // Mirror category-button structure: label text + count badge.
            // The count is the number of ambient sounds in the preset mix —
            // makes the row visually consistent with the filter chips above.
            const labelText = document.createTextNode(preset.label());
            const countSpan = document.createElement('span');
            countSpan.className = 'filter-count';
            countSpan.textContent = String((preset.sounds && preset.sounds.length) || 0);
            button.appendChild(labelText);
            button.appendChild(countSpan);
            button.addEventListener('click', () => applyAmbientPreset(preset.key));
            ambientPresetRow.appendChild(button);
        });
    };

    function stopAmbientSound(soundType, options = {}) {
        const { silent = false } = options;
        const audio = activeSounds.get(soundType);
        if (!audio) return;

        audio.pause();
        audio.currentTime = 0;
        activeSounds.delete(soundType);

        const card = document.querySelector(`.sound-card[data-sound="${soundType}"]`);
        if (card) {
            card.classList.remove('playing', 'loading');
            card.style.animation = 'none';

            const icon = card.querySelector('.sound-icon');
            if (icon) {
                icon.style.transform = 'scale(1)';
                icon.style.filter = 'none';
            }

            card.offsetHeight;
            setSoundCardState(card, 'off');
        }

        if (activeSounds.size === 0) {
            const musicBtn = document.querySelector('.music-widget-btn');
            if (musicBtn) {
                musicBtn.classList.remove('playing');
            }
            if (!hasStreamingPlayer()) {
                releaseMusicOwnership('stopped');
            }
        }

        syncMusicPlayerPlacement();
        updateAmbientMixBar();
        persistAmbientMixState();
        syncAmbientCardStates();

        if (!silent && card) {
            showPush(t('music_toast_sound_stopped', { sound: card.getAttribute('data-name') }), 'default');
        }
    }

    function updateAmbientMixBar() {
        if (!ambientMixBar || !ambientMixTitle || !ambientMixSubtitle || !ambientMixChips) return;

        const activeSoundKeys = Array.from(activeSounds.keys());
        const activeCount = activeSoundKeys.length;
        ambientMixBar.classList.toggle('active', activeCount > 0);

        if (activeCount === 0) {
            ambientMixTitle.textContent = t('music_no_sounds_active');
            ambientMixSubtitle.textContent = t('music_start_a_sound_to_build');
            ambientMixChips.innerHTML = '';
            return;
        }

        ambientMixTitle.textContent = t('music_ambient_active_count', { count: activeCount });
        ambientMixSubtitle.textContent = ambientMuted
            ? t('music_ambient_muted_subtitle')
            : t('music_ambient_tune_subtitle');

        ambientMixChips.innerHTML = '';
        activeSoundKeys.forEach((soundType) => {
            const card = document.querySelector(`.sound-card[data-sound="${soundType}"]`);
            const label = card?.getAttribute('data-name') || soundType;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ambient-mix-chip';
            chip.textContent = label;
            const stopLabel = t('music_chip_stop_title', { sound: label });
            chip.title = stopLabel;
            chip.setAttribute('aria-label', stopLabel);
            chip.addEventListener('click', () => stopAmbientSound(soundType));
            ambientMixChips.appendChild(chip);
        });
    }

    function applyAmbientMutedState() {
        activeSounds.forEach((audio) => {
            audio.muted = ambientMuted;
        });
        syncAmbientCardStates();
    }

    function updateAmbientMuteButtonState() {
        if (!ambientMuteAllBtn) return;
        ambientMuteAllBtn.textContent = ambientMuted ? t('common_unmute') : t('music_mute_all');
        ambientMuteAllBtn.classList.toggle('active', ambientMuted);
        updateAmbientMixBar();
    }

    updateAmbientMuteButtonState();
    applyAmbientMutedState();
    updateAmbientMixBar();
    syncAmbientCardStates();

    if (ambientMuteAllBtn) {
        ambientMuteAllBtn.addEventListener('click', () => {
            ambientMuted = !ambientMuted;
            safeSet(AMBIENT_MUTED_KEY, ambientMuted ? 'true' : 'false');
            updateAmbientMuteButtonState();
            applyAmbientMutedState();
            persistAmbientMixState();
        });
    }

    if (ambientStopAllBtn) {
        ambientStopAllBtn.addEventListener('click', () => {
            stopAllAmbientSounds();
        });
    }

    assignAmbientSoundCategories();
    renderAmbientCategoryButtons();
    renderAmbientPresetButtons();
    applyAmbientCategoryFilter('all');
    
    soundCards.forEach(card => {
        const soundType = card.getAttribute('data-sound');
        const volumeSlider = card.querySelector('.sound-volume');
        
        if (!volumeSlider) return;
        setSoundCardState(card, 'off');

        const paintVolumeSlider = () => {
            const min = Number(volumeSlider.min || 0);
            const max = Number(volumeSlider.max || 100);
            const value = Number(volumeSlider.value || 0);
            const pct = ((value - min) * 100) / Math.max(1, (max - min));
            volumeSlider.style.setProperty('--volume-pct', `${pct}%`);
        };
        paintVolumeSlider();
        
        // Get the actual audio file from data-file attribute
        const audioFile = card.getAttribute('data-file');
        const soundUrl = audioFile ? `../audio/${audioFile}` : null;
        
        // Click on entire card to play/stop
        card.addEventListener('click', (e) => {
            // Don't trigger if clicking on volume slider
            if (e.target.classList.contains('sound-volume')) return;
            
            if (activeSounds.has(soundType)) {
                stopAmbientSound(soundType);
            } else {
                if (isAnotherTabMusicOwner()) {
                    showPush(t('music_toast_ambient_other_tab'), 'default');
                    return;
                }

                // Play sound
                if (!soundUrl) {
                    showPush(t('music_toast_audio_not_found'), 'default');
                    return;
                }
                
                const audio = new Audio(soundUrl);
                audio.loop = true; // Loop ambient sounds
                applyAmbientVolume(audio, volumeSlider.value);
                audio.muted = ambientMuted;
                
                // Flag to track if this is the first play (not a loop repeat)
                let isFirstPlay = true;
                const isCurrentAudio = () => activeSounds.get(soundType) === audio;
                const markCardPlaying = () => {
                    if (!isCurrentAudio()) return;
                    card.classList.remove('loading');
                    card.classList.add('playing');
                    setSoundCardState(card, ambientMuted ? 'muted' : 'playing');

                    const musicBtn = document.querySelector('.music-widget-btn');
                    if (musicBtn) {
                        musicBtn.classList.add('playing');
                    }

                    if (isFirstPlay) {
                        if (!ambientBulkMode) {
                            showPush(t('music_toast_sound_playing', { sound: card.getAttribute('data-name') }), 'default');
                        }
                        isFirstPlay = false;
                    }
                };
                
                audio.addEventListener('loadstart', () => {
                    // Clear any inline styles before setting loading state
                    card.style.borderColor = '';
                    card.style.background = '';
                    card.style.boxShadow = '';
                    card.style.animation = '';
                    const icon = card.querySelector('.sound-icon');
                    if (icon) {
                        icon.style.transform = '';
                        icon.style.filter = '';
                    }
                    card.classList.add('loading');
                    setSoundCardState(card, 'loading');
                });
                
                audio.addEventListener('playing', markCardPlaying);
                
                audio.addEventListener('error', (err) => {
                    if (!isCurrentAudio()) return;
                    console.error('Audio loading error:', err);
                    activeSounds.delete(soundType);
                    // Restore normal appearance on error
                    card.classList.remove('loading', 'playing');
                    setSoundCardState(card, 'off');
                    showPush(t('music_toast_sound_load_failed', { sound: card.getAttribute('data-name') }), 'default');
                    checkMusicButtonAnimation();
                    syncMusicPlayerPlacement();
                    updateAmbientMixBar();
                    persistAmbientMixState();
                    syncAmbientCardStates();
                });
                
                // Start playing
                activeSounds.set(soundType, audio);
                audio.play().then(() => {
                    if (!isCurrentAudio()) return;
                    claimMusicOwnership();
                    markCardPlaying();
                    syncMusicPlayerPlacement();
                    updateAmbientMixBar();
                    persistAmbientMixState();
                    syncAmbientCardStates();
                }).catch((err) => {
                    if (!isCurrentAudio()) return;
                    console.error('Audio play error:', err);
                    activeSounds.delete(soundType);
                    // Restore normal appearance on play error
                    card.classList.remove('loading', 'playing');
                    setSoundCardState(card, 'off');
                    showPush(t('music_toast_sound_play_failed', { sound: card.getAttribute('data-name') }), 'default');
                    checkMusicButtonAnimation();
                    syncMusicPlayerPlacement();
                    updateAmbientMixBar();
                    persistAmbientMixState();
                    syncAmbientCardStates();
                });
            }
        });
        
        // Volume control
        volumeSlider.addEventListener('input', () => {
            paintVolumeSlider();
            if (activeSounds.has(soundType)) {
                const audio = activeSounds.get(soundType);
                applyAmbientVolume(audio, volumeSlider.value);
                // Debounced — `input` fires ~60Hz during drag.
                persistAmbientMixStateDebounced();
            }
        });
    });

    applyPendingAmbientState({ autoplay: false });
    updateAmbientMixBar();
    syncAmbientCardStates();
    
    // Playlist cards functionality
    const playlistCards = document.querySelectorAll('.playlist-card');
    playlistCards.forEach((card) => bindPlaylistCardPlayback(card));
    
    // `releaseReason` is passed through to releaseMusicOwnership: the user
    // stopping the mix ends the session, another tab taking the lock does not
    // give this tab anything left to end.
    function stopAllAmbientSounds({ releaseReason = 'stopped' } = {}) {
        activeSounds.forEach((audio, soundType) => {
            audio.pause();
            const card = document.querySelector(`[data-sound="${soundType}"]`);
            if (card) {
                card.classList.remove('playing', 'loading');
                card.style.animation = 'none';

                const icon = card.querySelector('.sound-icon');
                if (icon) {
                    icon.style.transform = 'scale(1)';
                    icon.style.filter = 'none';
                }
                setSoundCardState(card, 'off');
            }
        });
        activeSounds.clear();
        ambientBulkMode = false;
        if (ambientPresetRow) {
            ambientPresetRow.querySelectorAll('.ambient-preset-btn').forEach((btn) => {
                btn.classList.remove('active');
                btn.setAttribute('aria-pressed', 'false');
            });
        }
        
        // Check if we should remove music button animation
        checkMusicButtonAnimation();
        syncMusicPlayerPlacement();
        updateAmbientMixBar();
        persistAmbientMixState();
        syncAmbientCardStates();
        if (!hasStreamingPlayer()) {
            releaseMusicOwnership(releaseReason);
        }
    }

    // Expose ambient helpers to pomodoro.js focus mode.
    // (window.wfHasActiveAmbient + window.wfOpenMusicModal used to live
    //  here too — both were assigned but never read by any other module.
    //  Verified across all .js files: zero non-assignment references.)
    window.wfStopAllAmbientSounds = stopAllAmbientSounds;
    window.wfToggleAmbientByKey = function(soundKey) {
        // Delegate to the existing card click handler — keeps single source of truth
        var card = document.querySelector('.sound-card[data-sound="' + soundKey + '"]');
        if (card) card.click();
    };
    window.wfIsAmbientPlaying = function(soundKey) {
        return activeSounds.has(soundKey);
    };
    window.wfGetActiveAmbientKeys = function() {
        var keys = [];
        activeSounds.forEach(function(_, key) { keys.push(key); });
        return keys;
    };

    window.addEventListener('storage', (event) => {
        if (event.key !== MUSIC_ACTIVE_TAB_KEY) return;
        // Re-read rather than trusting event.newValue: several writes can be
        // in flight and the cache already holds the one that won.
        const activeOwner = getMusicActiveTabId();
        if (!activeOwner || activeOwner === musicTabId) return;
        // Another tab holds the lock now. Whatever this tab was doing as the
        // owner, or about to do as an adopter, ends here without touching the
        // new owner's keys.
        if (activeOwner !== handoffFromTabId) cancelPendingHandoff();
        if (hasStreamingPlayer()) {
            stopMusic({ clearResume: false });
        }
        if (activeSounds.size > 0) {
            stopAllAmbientSounds({ releaseReason: 'lock-lost' });
        } else {
            releaseMusicOwnership('lock-lost');
        }
    });
    
    // Helper function to manage music button animation state
    checkMusicButtonAnimation = function() {
        const musicBtn = document.querySelector('.music-widget-btn');
        if (!musicBtn) return;
        
        // Check if any music is playing (either streaming or ambient sounds)
        const hasActiveStreaming = currentPlayer && (
            (playerContainer && playerContainer.classList.contains('active')) ||
            (modalPlayerContainer && modalPlayerContainer.classList.contains('active'))
        );
        const hasActiveSounds = activeSounds.size > 0;
        
        // A session owned by another tab still counts as "music is playing" for
        // anything that keys off this class — notably resolveOpenMode(), which
        // picks the while-music-playing link behaviour.
        if (hasActiveStreaming || hasActiveSounds || hasRemoteSession()) {
            musicBtn.classList.add('playing');
        } else {
            musicBtn.classList.remove('playing');
        }
    };

    syncMusicPlayerPlacement();
    setMusicDockExpanded(false);
    updateMusicDockLabel();
    // Says goodbye with reason 'unload', so remotes stop offering dead controls
    // at once and one of them may pick the session up.
    window.addEventListener('beforeunload', () => {
        releaseMusicOwnership('unload');
    });

    // Ask whoever owns the session to introduce itself, so a freshly opened tab
    // paints the right state now instead of after the owner's next heartbeat.
    if (!hasAnyActiveAudio()) postBus({ type: 'wf-music-hello', tabId: musicTabId });
}

// Initialize music player on load
document.addEventListener('DOMContentLoaded', () => {
    initMusicPlayer();
    
    // Force music button to be transparent on page load (no animation).
    // NOTE: we explicitly do NOT clear activeSounds here — pomodoro's focus-mode
    // restoration starts sounds within this 100ms window and clearing would wipe
    // them, causing "ambient plays but picker says inactive, next refresh nothing plays".
    setTimeout(() => {
        const musicBtn = document.querySelector('.music-widget-btn');
        if (musicBtn && activeSounds.size === 0) {
            musicBtn.classList.remove('playing');
            const container = document.querySelector('.music-player-container');
            if (container && !container.classList.contains('active')) {
                container.classList.remove('native-embed');
                container.innerHTML = '';
            }
            const modalContainer = document.getElementById('music-modal-player-container');
            if (modalContainer && !modalContainer.classList.contains('active')) {
                modalContainer.classList.remove('native-embed');
                modalContainer.innerHTML = '';
            }
        }
    }, 100);
});

// Expose functions globally for use by newtab.js + pomodoro.js focus mode
window.stopMusic = stopMusic;
window.pauseMusic = pauseMusic;
window.resumeMusic = resumeMusic;
window.wfIsMusicPaused = function() { return isMusicPaused; };
window.wfHasActiveStreaming = function() {
    return !!(currentPlayer && (
        (playerContainer && playerContainer.classList.contains('active')) ||
        (modalPlayerContainer && modalPlayerContainer.classList.contains('active'))
    ));
};
})();


    // Firefox refuses audible playback in a tab nobody has interacted with,
    // which is exactly what a freshly opened new tab is. Starting music anyway
    // lit the dock up as playing with nothing coming out. Where the browser
    // does not say (Chrome has no getAutoplayPolicy), the answer is allowed.
    function canAutoplayAudio() {
        try {
            if (typeof navigator.getAutoplayPolicy !== 'function') return true;
            return navigator.getAutoplayPolicy('mediaelement') === 'allowed';
        } catch (_) {
            return true;
        }
    }

    // Runs the action now when audio is allowed, otherwise on the first real
    // interaction, which is what lifts the block. Returns whether it waited.
    let _pendingAudioGestureAction = null;
    function runWhenAudioAllowed(action) {
        if (canAutoplayAudio()) {
            action();
            return false;
        }
        _pendingAudioGestureAction = action;
        const fire = () => {
            document.removeEventListener('pointerdown', fire, true);
            document.removeEventListener('keydown', fire, true);
            const pending = _pendingAudioGestureAction;
            _pendingAudioGestureAction = null;
            if (pending) pending();
        };
        document.addEventListener('pointerdown', fire, true);
        document.addEventListener('keydown', fire, true);
        return true;
    }

