// ==============================
// WALLPAPER STORAGE — IndexedDB operations
// ==============================

const DB_NAME = 'videoDB';
const DB_VERSION = 3; // bumped from 2: added 'posters' store for cached default thumbnail
const DB_STORE = 'videos';
const POSTER_STORE = 'posters';
// Bump suffix (e.g. ':v4') if src/videos/default.mp4 is replaced or thumbnail dims/format change.
// :v3 = downscaled (≤240px max dim, WebP 0.6) — smaller still than the v2 JPEG variant.
const DEFAULT_POSTER_CACHE_KEY = 'default-poster:v3';
const SUPPORTED_VIDEO_FORMATS = ['mp4', 'webm', 'ogg', 'mov'];
const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const IDB_REQUEST_TIMEOUT_MS = 15000;
// Card displays at 90×56 px. 240px max covers 2-3× retina with margin and shrinks
// WebP output ~15-25× vs full-res frames. Output is invisibly different at the
// rendered size but uses far less memory, IDB space, and decode CPU.
// WebP at 0.6 ≈ JPEG at 0.55 visually but ~25% smaller on disk.
const THUMBNAIL_MAX_DIM = 240;
const THUMBNAIL_WEBP_QUALITY = 0.6;
// One-shot migration: any pre-existing thumbnail larger than this is regenerated
// at the new small size. New uploads are already small so they skip the migration.
// Bump the flag suffix (e.g. _v4) if the dimensions/quality/format change again.
const THUMBNAIL_MIGRATION_FLAG = STORAGE_KEYS.THUMBNAIL_MIGRATION_FLAG;
const THUMBNAIL_MIGRATION_SIZE_THRESHOLD = 50 * 1024; // 50 KB

// Module-scoped state used by the default-wallpaper thumbnail render path.
// _defaultPosterMemoryCache: a Blob held in memory for the lifetime of the page so
// subsequent menu opens skip the IDB roundtrip entirely.
// _defaultThumbGen: monotonic counter — guards against assigning a freshly-decoded
// blob URL to a thumbnail node that was already removed by a re-render.
let _defaultPosterMemoryCache = null;
let _defaultThumbGen = 0;

// Prevent uncaught AbortError from Spotify iframe
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && (
        event.reason.message === 'The play() request was interrupted by a call to pause().' ||
        event.reason.name === 'AbortError' ||
        (typeof event.reason === 'string' && event.reason.includes('AbortError'))
    )) {
        event.preventDefault();
    }
});

// Wrap an IDBRequest in a Promise that rejects on error or timeout instead of
// hanging forever. Without this, a failed transaction silently blocks the caller.
function awaitIDBRequest(request, timeoutMs = IDB_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('IndexedDB request timed out')), timeoutMs);
        request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
        request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('IndexedDB request failed')); };
    });
}

// Wipe every uploaded wallpaper. One clear() inside a single transaction
// rather than a delete per key: a half-finished wipe would leave a library the
// user did not ask for and cannot reason about.
async function deleteAllWallpapers() {
    const db = await openDB(DB_NAME, DB_VERSION);
    const tx = db.transaction(DB_STORE, 'readwrite');
    const committed = awaitTransaction(tx);
    tx.objectStore(DB_STORE).clear();
    await committed;

    // Drop every reference too. Left behind they would silently adopt the next
    // uploads: a cleared store restarts autoIncrement at 1, so a stale
    // rotationKeys of ['1','2'] would put the user's next two files into random
    // rotation without being asked. Same reasoning as the eviction cleanup.
    await chrome.storage.local.set({
        rotationKeys: [],
        dayWallpaperKeys: [],
        nightWallpaperKeys: [],
        rotationDurations: {},
    });
    _rotationDurationsCache = {};
    await chrome.storage.local.remove(['activeVideoKey']);
}

// Lives in the storage footer, beside the total it acts on. Only offered while
// there is something to delete — on an empty library it would be a button that
// does nothing, which is worse than no button. The footer row itself stays, so
// "None yet" still answers the question the row is there to answer.
function syncDeleteAllWallpapersRow(customCount) {
    const btn = document.getElementById('delete-all-wallpapers-btn');
    if (!btn) return;
    btn.classList.toggle('is-hidden', !customCount);

    if (btn.dataset.bound === 'true') return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', async () => {
        const keys = await getAllKeys().catch(() => []);
        if (keys.length === 0) return;

        // Say the number out loud. "All wallpapers" is abstract; "all 12
        // wallpapers" is the fact the user needs to weigh before confirming.
        const textEl = document.getElementById('delete-all-wallpapers-text');
        if (textEl) {
            textEl.textContent = t('modal_delete_wallpapers_text_count', { count: keys.length });
        }

        // showConfirmModal lives in widgets.js, which loads before this file.
        const ok = typeof showConfirmModal === 'function'
            ? await showConfirmModal(
                'delete-all-wallpapers-modal',
                'delete-all-wallpapers-cancel',
                'delete-all-wallpapers-confirm',
                t('modal_delete_wallpapers_confirm_fallback', { count: keys.length }))
            : false;
        if (!ok) return;

        try {
            await deleteAllWallpapers();
            showPush(t('wallpapers_toast_deleted_all', { count: keys.length }), 'success');
        } catch (err) {
            console.error('Delete all wallpapers failed', err);
            showPush(t('wallpapers_toast_delete_all_failed'), 'warning');
            return;
        }
        updateVideo();
    });
}

// Bytes as a short human string. Wallpapers are megabytes, so one decimal
// below 10 MB and none above: enough to compare two files at a glance without
// implying precision the number does not have.
function formatBytes(bytes) {
    const n = Number(bytes);
    // The numbers go through t() as numbers, so the decimal separator follows
    // the language: 2.5 MB in English, 2,5 MB in German.
    if (!Number.isFinite(n) || n <= 0) return t('unit_size_kb', { size: 0 });
    if (n < 1024) return t('unit_size_b', { size: n });
    const kb = n / 1024;
    if (kb < 1024) return t('unit_size_kb', { size: Math.round(kb) });
    const mb = kb / 1024;
    if (mb < 1024) return t('unit_size_mb', { size: mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb) });
    return t('unit_size_gb', { size: Math.round((mb / 1024) * 10) / 10 });
}

// Pull the stored media out of a record. Old uploads were stored as a
// [blob, thumbnail] array before the object form existed; both still render.
function recordMediaBlob(record) {
    if (!record) return null;
    if (Array.isArray(record)) return record[0] || null;
    return record.blob || null;
}

// Total the same figure the cards show — the media itself, not the derived
// thumbnails. Sum-of-cards has to equal the total or the number stops being
// believable, and thumbnails are a fraction of a percent either way.
//
// One getAll() rather than a get() per key: reading a record hands back a Blob
// reference, not its bytes, so .size is cheap even for a library of gigabytes.
async function updateWallpaperStorageRow() {
    const valueEl = document.getElementById('wallpaper-storage-value');
    if (!valueEl) return;
    try {
        const db = await openDB(DB_NAME, DB_VERSION);
        const tx = db.transaction(DB_STORE, 'readonly');
        const records = await awaitIDBRequest(tx.objectStore(DB_STORE).getAll());
        let total = 0;
        for (const record of records) {
            const blob = recordMediaBlob(record);
            if (blob && blob.size) total += blob.size;
        }
        const count = records.length;
        valueEl.textContent = count === 0
            ? t('wallpapers_storage_none')
            : t('wallpapers_storage_summary', { count, size: formatBytes(total) });
    } catch (_) {
        // Never show a wrong number: an unreadable database is not zero bytes.
        valueEl.textContent = t('wallpapers_storage_unavailable');
    }
}

// Resolve when the transaction actually COMMITS, reject if it aborts.
//
// The code used to `await tx.done`. Native IDBTransaction has no `done` — that
// property belongs to the `idb` library, which this project does not use — so
// the expression was `await undefined` and resolved immediately, waiting for
// nothing. That matters because a request reports success against the
// transaction's own view, *before* the commit: measured order is
// request.onsuccess, then tx.oncomplete. When the commit then fails — which is
// exactly how IndexedDB surfaces running out of quota — the request had already
// said "success", nobody was listening for the abort, and the record silently
// never landed. The user was told "added successfully" and found the wallpaper
// gone on the next new tab.
//
// Attach the handlers SYNCHRONOUSLY after creating the transaction, before any
// await: a transaction that has already completed will never fire oncomplete,
// and a late listener would hang forever. The timeout is the same belt-and-
// braces the request wrapper above uses, for the same reason.
function awaitTransaction(tx, timeoutMs = IDB_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('IndexedDB transaction timed out')), timeoutMs);
        tx.oncomplete = () => { clearTimeout(timer); resolve(); };
        tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error('IndexedDB transaction aborted')); };
        tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error('IndexedDB transaction failed')); };
    });
}

// Detect storage-quota errors raised by IndexedDB writes. The platform's exact
// shape varies — Chromium throws DOMException name 'QuotaExceededError' (code 22),
// Firefox uses 'NS_ERROR_DOM_QUOTA_REACHED'. Some wrapped errors expose the cause
// via `.name` on a generic Error. Catch all variants so the caller sees a single
// uniform "out of space" condition.
function isQuotaError(err) {
    if (!err) return false;
    const name = err.name || (err.error && err.error.name) || '';
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || (typeof err.code === 'number' && err.code === 22);
}

// Best-effort: returns true when the browser-reported storage usage is within
// 5% of the quota, signalling that the next upload may fail. Used to warn the
// user proactively before they pick a large file. navigator.storage is widely
// supported on Chromium MV3 but the API can be absent on some embedders, so
// fall back to "no warning" rather than blocking the flow.
async function isStorageNearlyFull() {
    try {
        if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return false;
        const { usage, quota } = await navigator.storage.estimate();
        if (!quota) return false;
        return (usage / quota) >= 0.95;
    } catch (_) {
        return false;
    }
}

// Wallpaper blobs live in IndexedDB, which sits in the browser's *best-effort*
// storage bucket — reclaimable without warning, and without asking, when the
// device runs low on space. Settings survive the same event because
// localStorage and chrome.storage.local are not in that bucket, which is why
// the loss reads to a user as "only my video disappeared" rather than "the
// extension reset itself".
//
// The manifest's "unlimitedStorage" permission is the actual fix — Chrome
// documents it as exempting the extension from both quota limits and eviction.
// This call is a second lock on the same door for embedders that manage storage
// more aggressively, and it is the only one that reports back, so it also tells
// us whether the guarantee really took.
async function ensurePersistentStorage() {
    try {
        if (!navigator.storage || typeof navigator.storage.persist !== 'function') return false;
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
    } catch (_) {
        return false;
    }
}

// Every place outside IndexedDB that names a stored wallpaper: the lists, and
// the per-wallpaper durations map keyed by the same numbers.
const WALLPAPER_REFERENCE_LISTS = ['rotationKeys', 'dayWallpaperKeys', 'nightWallpaperKeys'];
const WALLPAPER_REFERENCE_MAPS = ['rotationDurations'];

// An empty videos store is ambiguous on its own — it is also exactly what a
// fresh install looks like. chrome.storage.local settles it, because it lives
// outside the quota that gets reclaimed: if it still names wallpapers the
// database no longer holds, then those records existed and are gone.
//
// The dangling references have to be cleared, not merely reported. A destroyed
// store restarts its autoIncrement at 1, so a stale rotationKeys of ['1','2']
// would silently adopt the user's next two uploads into random rotation — a
// setting they never chose and would have no way to explain.
async function reportEvictedWallpapers() {
    try {
        const stored = await chrome.storage.local.get(
            WALLPAPER_REFERENCE_LISTS.concat(WALLPAPER_REFERENCE_MAPS, ['activeVideoKey'])
        );

        // 'default' is bundled, not stored, so it proves nothing about the DB.
        const isStoredRecord = (k) => k !== null && k !== undefined && String(k) !== 'default';
        const mapKeys = (k) => (stored[k] && typeof stored[k] === 'object' ? Object.keys(stored[k]) : []);

        const refs = WALLPAPER_REFERENCE_LISTS
            .flatMap((k) => (Array.isArray(stored[k]) ? stored[k] : []))
            .concat(WALLPAPER_REFERENCE_MAPS.flatMap(mapKeys))
            .filter(isStoredRecord);
        const activeIsRecord = isStoredRecord(stored.activeVideoKey);
        if (refs.length === 0 && !activeIsRecord) return false;

        const cleanup = {};
        for (const k of WALLPAPER_REFERENCE_LISTS) {
            const list = Array.isArray(stored[k]) ? stored[k] : null;
            if (list && list.some(isStoredRecord)) {
                cleanup[k] = list.filter((v) => !isStoredRecord(v));
            }
        }
        for (const k of WALLPAPER_REFERENCE_MAPS) {
            if (mapKeys(k).some(isStoredRecord)) cleanup[k] = {};
        }
        if (Object.keys(cleanup).length > 0) await chrome.storage.local.set(cleanup);
        if (activeIsRecord) await chrome.storage.local.remove(['activeVideoKey']);

        if (typeof showPush === 'function') {
            // States what is observable, not a cause we cannot verify. Eviction
            // is the likeliest explanation and the one this release is about,
            // but a reference can outlive its record for other reasons — an
            // older build that cleaned up incompletely, a profile copied between
            // machines — and telling those users the browser did it would
            // simply be false. "may have" keeps the useful hint honest.
            showPush(t('wallpapers_toast_missing_uploads'), 'warning');
        }
        return true;
    } catch (_) {
        return false;
    }
}

// Fire and forget at load — nothing downstream may wait on it.
ensurePersistentStorage();

// SHA-256 hex of a Blob/File. Used to detect duplicate wallpaper uploads at
// content level (not name/size, which has false positives and false negatives —
// renamed-but-identical files would slip through). For typical wallpapers
// (1-30 MB) this takes ~30-200 ms in Chrome and runs once at upload time.
async function hashBlob(blob) {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
}

// Walk every stored wallpaper looking for one whose blob hashes to `targetHash`.
// Records uploaded before this dedupe feature don't have a `hash` field — those
// get hashed lazily here and the result is persisted back so the next check is
// instant (no IDB schema migration needed). Returns the IDB key of the duplicate
// or null when nothing matches.
async function findDuplicateWallpaper(targetHash) {
    let db;
    try { db = await openDB(DB_NAME, DB_VERSION); }
    catch (_) { return null; }

    let keys;
    try {
        const tx = db.transaction(DB_STORE, 'readonly');
        keys = await awaitIDBRequest(tx.objectStore(DB_STORE).getAllKeys());
    } catch (_) { return null; }

    for (const key of keys) {
        let record;
        try {
            const tx = db.transaction(DB_STORE, 'readonly');
            record = await awaitIDBRequest(tx.objectStore(DB_STORE).get(key));
        } catch (_) { continue; }
        if (!record || !record.blob) continue;

        let recordHash = record.hash;
        if (!recordHash) {
            try {
                recordHash = await hashBlob(record.blob);
                // Persist for next time. Failures here are fine — we'll just
                // re-hash on the next upload.
                try {
                    const wtx = db.transaction(DB_STORE, 'readwrite');
                    const committed = awaitTransaction(wtx);
                    record.hash = recordHash;
                    await awaitIDBRequest(wtx.objectStore(DB_STORE).put(record));
                    await committed;
                } catch (_) { /* non-fatal */ }
            } catch (_) { continue; }
        }
        if (recordHash === targetHash) return key;
    }
    return null;
}

// Open the side menu (if closed), scroll the duplicate card into view, and
// apply a brief shake + red-glow class so the user spots which existing
// wallpaper their upload collided with. Menu open requires waiting for the
// transition to finish before the wallpapers list is laid out.
function flashDuplicateWallpaperCard(key) {
    const reveal = () => {
        // Make sure the user is on the Wallpapers tab — if they're on Widgets
        // or Settings while the menu was already open, the wallpapers section
        // is display:none and any animation we run on the hidden card is
        // invisible. Click the Wallpapers nav button to switch.
        const wallpapersSection = document.getElementById('wallpapers-section');
        if (wallpapersSection && !wallpapersSection.classList.contains('active')) {
            const navBtn = document.getElementById('wallpapers-btn');
            if (navBtn) navBtn.click();
        }

        const listContainer = document.getElementById('wallpapers-list');
        const card = listContainer ? listContainer.querySelector(`[data-key="${key}"]`) : null;
        if (!card) return;

        // The actual scroll container isn't #wallpapers-list — that element
        // sits inside .management-section (display: block) so its `flex: 1`
        // never resolves to a bounded height; the scrollable ancestor is
        // .favorites-wallpapers (and ultimately .sidenav). scrollIntoView
        // walks the parent chain and scrolls whichever ancestor actually
        // has overflow, which is exactly the behaviour we need here. The
        // sidenav is guaranteed to be on-screen at this point (we either
        // entered with menu-open already true, or we just clicked the
        // toggle and waited 550 ms for the slide-in), so no risk of the
        // earlier horizontal-scroll bug that made us avoid scrollIntoView
        // in the auto-pin path.
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Detect whether a scroll is actually needed so we can fire the
        // highlight instantly when the card is already centred (no pointless
        // 420 ms pause between the toast and the visual feedback).
        const cardRect = card.getBoundingClientRect();
        const listRect = listContainer.getBoundingClientRect();
        const cardCentre = cardRect.top + cardRect.height / 2;
        const listCentre = listRect.top + listRect.height / 2;
        const alreadyVisible = Math.abs(cardCentre - listCentre) < cardRect.height;

        const startHighlight = () => {
            // Single-channel feedback: red bg + border + glow ring that
            // breathes in/out via a slow CSS transition. The shake animation
            // and opacity blink that used to live here were dropped — the
            // toast + auto-scroll + held red highlight already communicate
            // "this one exists" clearly, and the motion was reading as
            // "error klaxon" in an otherwise calm UI.
            card.classList.add('duplicate-highlight');
            setTimeout(() => card.classList.remove('duplicate-highlight'), 2300);
        };

        if (alreadyVisible) {
            startHighlight();
        } else {
            setTimeout(startHighlight, 420);
        }
    };

    if (document.body.classList.contains('menu-open')) {
        reveal();
        return;
    }
    // Menu closed → trigger the toggle (#open_close handler calls openSide()),
    // then wait for the transition to complete before locating the card.
    const toggle = document.getElementById('open_close');
    if (toggle) {
        toggle.click();
        setTimeout(reveal, 550); // sidenav transition is 0.5s
    }
}

// Process a FileList (or File[]) coming from either the file picker or a
// drag-and-drop. Validates extensions, generates thumbnails, writes to IDB,
// and surfaces quota/upload errors with toasts. Returns the key of the last
// successfully added record (used to auto-pin the new wallpaper).
async function ingestFiles(files) {
    if (!files || files.length === 0) return null;

    // Warn proactively when the storage area is already nearly full — gives
    // the user a chance to delete something before the first write fails.
    if (await isStorageNearlyFull()) {
        showPush(t('wallpapers_toast_storage_nearly_full'), 'warning');
    }

    let lastAddedKey = null;

    for (const file of files) {
        const extension = file.name.split('.').pop().toLowerCase();
        const isVideo = SUPPORTED_VIDEO_FORMATS.includes(extension);
        const isImage = SUPPORTED_IMAGE_FORMATS.includes(extension);
        if (!(isVideo || isImage)) {
            showPush(t('wallpapers_toast_format_unsupported', { file: file.name }), 'warning');
            console.error(`Error: .${extension} file format is not supported`);
            continue;
        }

        // Duplicate check — hash the new file BEFORE the expensive thumbnail
        // generation and IDB write, so we bail out early on collision and
        // avoid wasting work on something we won't store. If hashing itself
        // fails (rare; e.g. WebCrypto unavailable) we fall through and allow
        // the upload — better to risk a duplicate than block legitimate work.
        let newHash = null;
        try { newHash = await hashBlob(file); }
        catch (e) { console.warn(`Hash failed for ${file.name}:`, e); }

        if (newHash) {
            const dupeKey = await findDuplicateWallpaper(newHash);
            if (dupeKey !== null) {
                showPush(t('wallpapers_toast_duplicate', { file: file.name }), 'warning');
                flashDuplicateWallpaperCard(dupeKey);
                continue;
            }
        }

        try {
            const thumbnail = await getThumbnail(file, isVideo ? 'video' : 'image');
            const db = await openDB(DB_NAME, DB_VERSION);
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore('videos');
            const record = {
                blob: file,
                thumbnail: thumbnail,
                type: isVideo ? 'video' : 'image',
                mime: file.type || (isVideo ? 'video/*' : 'image/*'),
                hash: newHash || undefined
            };
            // Handlers attached before the first await — see awaitTransaction.
            const committed = awaitTransaction(tx);
            const request = store.put(record);
            const newKey = await awaitIDBRequest(request);
            // Nothing is claimed, and no card is rendered, until the row is
            // genuinely on disk. A quota overrun aborts here and falls into the
            // catch below, where the user is told the truth.
            await committed;
            lastAddedKey = newKey;
            // Awaited deliberately. updateSettings() is async and no call site
            // used to wait for it, so this per-file append could still be
            // running when the full rebuild that follows the batch removed the
            // cards — the append then landed *after* the removal and left a
            // duplicate card for the last file. Selecting three files at once
            // reproduced it every time.
            //
            // The 'all' render at the end of renderWallpaper() stays
            // un-awaited on purpose: making the wallpaper wait for the card
            // list to build would delay the background on every new tab, and
            // that render is already serialised by the _isUpdatingVideo guard.
            await updateSettings([lastAddedKey], 'last');
            showPush(t('wallpapers_toast_added', { file: file.name }), 'default');
        } catch (err) {
            if (isQuotaError(err)) {
                // Out of space — no point trying the rest of the batch; each
                // would fail the same way and spam the user with toasts.
                showPush(t('wallpapers_toast_storage_full'), 'warning');
                console.warn(`Quota exceeded while adding ${file.name}; aborting batch.`);
                break;
            }
            showPush(t('wallpapers_toast_add_failed', { file: file.name }), 'warning');
            console.error(`Error adding ${file.name} to object store:`, err);
        }
    }
    // Only refresh the wallpaper display + re-render the cards list when at
    // least one file was actually added. Calling updateVideo() unconditionally
    // (its 'ingestFiles' branch routes through updateSettings(keys, 'all'))
    // wipes every .fav-card and rebuilds them, which had a nasty side effect:
    // duplicate-detection's flashDuplicateWallpaperCard had just added the
    // shake/glow class to a card and the rebuild ripped that card out ~3 ms
    // later, leaving the user with a flicker. With nothing actually added,
    // there's nothing to refresh.
    if (lastAddedKey !== null) {
        // Pinning a wallpaper pauses the rotation, so an upload used to stop
        // the timer without saying so: you added a picture and your wallpapers
        // quietly stopped changing. With the timer running and nothing pinned
        // by hand, the upload is shown once instead of pinned, and the rotation
        // carries on. Everything else keeps the old behaviour, including
        // replacing a pin the user chose themselves.
        const rotateOn = parseRotateMinutes(safeGet(STORAGE_KEYS.WALLPAPER_ROTATE_MINUTES)) > 0;
        const pinnedByUser = await getActiveVideoKey();
        const shouldPin = !rotateOn || !!pinnedByUser;

        if (shouldPin) {
            // The key is written before the render, because the render reads
            // it. Writing it afterwards, as this used to, left the background
            // on the previous wallpaper while the card list said the new one
            // was pinned; a second render meant to fix that hit the busy guard
            // and did nothing.
            await setActiveVideoKey(lastAddedKey);
        } else {
            _wfForceNextKey = lastAddedKey;
        }
        await updateVideo('ingestFiles');

        // The card list is built by updateSettings() inside the render, which
        // is not awaited there; wait for the card with rAF rather than a sleep.

        const tryActivateNewCard = (attemptsLeft) => {
            const listContainer = document.getElementById('wallpapers-list');
            const newCard = listContainer
                ? listContainer.querySelector(`[data-key="${lastAddedKey}"]`)
                : null;
            if (!newCard) {
                if (attemptsLeft > 0) {
                    requestAnimationFrame(() => tryActivateNewCard(attemptsLeft - 1));
                }
                return;
            }
            if (shouldPin) {
                newCard.classList.add('active');
                const setBtn = newCard.querySelector('.fav-set');
                setPinButtonState(setBtn, true);
                const allCards = listContainer.querySelectorAll('.fav-card');
                allCards.forEach((c) => {
                    if (c !== newCard) {
                        c.classList.remove('active');
                        const btn = c.querySelector('.fav-set');
                        setPinButtonState(btn, false);
                    }
                });
            }
            refreshWallpaperCardsMeta();
            // Only scroll the new card into view when the side menu is open —
            // otherwise the card lives inside an off-screen sidenav (translated
            // +350px right) and scrollIntoView causes the browser to horizontally
            // scroll the document to "reveal" it, which shifts every absolutely
            // positioned widget left and leaves the page in a broken state until
            // the tab is reopened.
            if (document.body.classList.contains('menu-open')) {
                newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            if (shouldPin) {
                showPush(t('wallpapers_toast_pinned_auto'), 'success');
            } else if (_wfPoolHasShowing) {
                showPush(t('wallpapers_toast_added_showing'), 'success');
            } else {
                // It is on screen but outside the list the timer walks, so it
                // will not come back on its own. Say that rather than let the
                // user discover it.
                showPush(t('wallpapers_toast_added_outside_rotation'), 'success');
            }
        };
        // Up to ~30 frames (~500ms at 60fps) waiting for updateSettings
        // to attach the card. Bails out silently if the card never lands.
        requestAnimationFrame(() => tryActivateNewCard(30));
    }

    return lastAddedKey;
}

// Unified media picker (videos + static images). The `video_origin` parameter
// + early-return only allowed 'file' anyway — every call site passed 'file'.
// Dropped to simplify the API.
async function getVideo() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,image/*';
    input.multiple = true;

    input.addEventListener('change', (event) => ingestFiles(event.target.files));
    input.click();
}

// ==============================
// DRAG-AND-DROP UPLOAD
// ==============================
// Full-page overlay activated when the user drags external files onto the tab.
// Drop anywhere → files go through the same ingestFiles() pipeline as the
// upload button (validation, thumbnail, IDB write, quota handling, auto-pin).
// Uses a depth counter because dragenter/dragleave fire on every nested
// element traversal, not just the body boundary.
function initDragDropUpload() {
    const overlay = document.getElementById('wallpaper-drop-overlay');
    if (!overlay) return;

    let dragDepth = 0;

    // Only react to drags that carry files. Internal drags (e.g. dragging an
    // image element within the page, or dragging text) have different types.
    function isExternalFileDrag(e) {
        if (!e.dataTransfer || !e.dataTransfer.types) return false;
        // dataTransfer.types is a DOMStringList — some browsers, an array.
        for (const type of e.dataTransfer.types) {
            if (type === 'Files') return true;
        }
        return false;
    }

    function showOverlay() {
        overlay.classList.add('show');
        // Body class lets the side menu (z-index above the overlay) show its own
        // drop-ready hint when the user is dragging while the menu is open. Pure
        // CSS — see .wallpapers-upload-row drag-active rules in style.css.
        document.body.classList.add('is-dragging-files');
    }
    function hideOverlay() {
        dragDepth = 0;
        overlay.classList.remove('show');
        document.body.classList.remove('is-dragging-files');
    }

    document.addEventListener('dragenter', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        dragDepth++;
        if (dragDepth === 1) showOverlay();
    });

    // dragover MUST call preventDefault for drop to fire — without it the
    // browser uses the default "no drop" cursor and rejects the drop event.
    document.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
    });

    document.addEventListener('dragleave', (e) => {
        if (!isExternalFileDrag(e)) return;
        dragDepth--;
        if (dragDepth <= 0) hideOverlay();
    });

    document.addEventListener('drop', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        hideOverlay();
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            ingestFiles(files);
        }
    });

    // Esc as an escape hatch — if Chrome ever leaves the overlay stuck because
    // dragleave didn't fire (e.g. user dragged out of the window without releasing),
    // pressing Esc clears it manually.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) hideOverlay();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDragDropUpload);
} else {
    initDragDropUpload();
}

// Compute downscaled dimensions preserving aspect ratio. If the source is already
// smaller than maxDim on both axes, returns the original size unchanged.
function computeThumbnailDimensions(srcWidth, srcHeight, maxDim = THUMBNAIL_MAX_DIM) {
    if (srcWidth <= maxDim && srcHeight <= maxDim) {
        return { width: srcWidth, height: srcHeight };
    }
    const ratio = Math.min(maxDim / srcWidth, maxDim / srcHeight);
    return {
        width: Math.max(1, Math.round(srcWidth * ratio)),
        height: Math.max(1, Math.round(srcHeight * ratio))
    };
}

// Render `source` (HTMLVideoElement or HTMLImageElement) onto a small canvas and
// export as WebP blob. Centralizes the downscaling so all thumbnail paths produce
// uniformly small artifacts (~5-20 KB instead of 100-300 KB at full resolution).
async function renderDownscaledThumbnail(source, srcWidth, srcHeight) {
    const { width, height } = computeThumbnailDimensions(srcWidth, srcHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // High-quality downscaling — without this, Chrome may use box filtering and
    // produce visible aliasing on edges. Negligible cost at these sizes.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', THUMBNAIL_WEBP_QUALITY));
}

// Generate thumbnail directly from a video URL (extension resource or remote)
async function generateThumbnailFromURL(videoURL) {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // Attach to DOM (hidden) — Chrome won't decode frames for detached video elements
    video.className = 'video-offscreen';
    document.body.appendChild(video);
    video.src = videoURL;
    video.load();

    const cleanup = () => {
        try { video.pause(); } catch (_) {}
        video.removeAttribute('src');
        try { video.load(); } catch (_) {}
        if (video.parentNode) video.parentNode.removeChild(video);
    };

    try {
        // Wait for the first frame to be decodable (loadeddata, not just metadata)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('loadeddata timeout')), 10000);
            video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
            video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video load error')); }, { once: true });
        });

        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const targetTime = Math.max(0, Math.min(2, duration * 0.3 || 0.1));

        if (duration > 0.2 && targetTime > 0) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('seek timeout')), 10000);
                video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
                video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video seek error')); }, { once: true });
                video.currentTime = targetTime;
            });
        }

        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) throw new Error('No video dimensions');

        const blob = await renderDownscaledThumbnail(video, w, h);
        cleanup();
        if (!blob) throw new Error('canvas.toBlob returned null');
        return blob;
    } catch (err) {
        cleanup();
        throw err;
    }
}

async function getThumbnail(fileBlob, kind) {
    if (kind === 'video' || (fileBlob.type && fileBlob.type.startsWith('video'))) {
        const video = document.createElement('video');
        const videoObjectURL = URL.createObjectURL(fileBlob);
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        // Attach to DOM (hidden) — some browsers won't decode frames for detached video elements
        video.className = 'video-offscreen';
        document.body.appendChild(video);
        video.src = videoObjectURL;
        video.load();

        const cleanup = () => {
            try { video.pause(); } catch (_) {}
            video.removeAttribute('src');
            try { video.load(); } catch (_) {}
            if (video.parentNode) video.parentNode.removeChild(video);
            URL.revokeObjectURL(videoObjectURL);
        };

        try {
            // Wait for metadata (dimensions + duration), with timeout
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('metadata timeout')), 8000);
                video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
                video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video load error')); }, { once: true });
            });

            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            const targetTime = Math.max(0, Math.min(2, duration * 0.5 || 0.1));

            // Seek and wait for the frame to be ready
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('seek timeout')), 8000);
                video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
                video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video seek error')); }, { once: true });
                video.currentTime = targetTime;
            });

            const w = video.videoWidth;
            const h = video.videoHeight;
            if (!w || !h) { cleanup(); throw new Error('No video dimensions'); }
            const thumbnail = await renderDownscaledThumbnail(video, w, h);
            cleanup();
            return thumbnail;
        } catch (err) {
            cleanup();
            throw err;
        }
    } else {
        const img = document.createElement('img');
        const imageObjectURL = URL.createObjectURL(fileBlob);
        img.src = imageObjectURL;
        try {
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
            });
            const thumbnail = await renderDownscaledThumbnail(img, img.naturalWidth, img.naturalHeight);
            return thumbnail || fileBlob;
        } finally {
            URL.revokeObjectURL(imageObjectURL);
        }
    }
}

async function openDB(name, version) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (ev) => {
            const db = request.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE, { keyPath: 'num', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains(POSTER_STORE)) {
                db.createObjectStore(POSTER_STORE, { keyPath: 'id' });
            }
        };
    });
}

async function getCachedDefaultPoster(id) {
    if (_defaultPosterMemoryCache) return _defaultPosterMemoryCache;
    try {
        const db = await openDB(DB_NAME, DB_VERSION);
        if (!db.objectStoreNames.contains(POSTER_STORE)) return null;
        const tx = db.transaction(POSTER_STORE, 'readonly');
        const result = await awaitIDBRequest(tx.objectStore(POSTER_STORE).get(id));
        const blob = result && result.blob ? result.blob : null;
        if (blob) _defaultPosterMemoryCache = blob;
        return blob;
    } catch (_) {
        return null;
    }
}

async function putCachedDefaultPoster(id, blob) {
    try {
        const db = await openDB(DB_NAME, DB_VERSION);
        if (!db.objectStoreNames.contains(POSTER_STORE)) return;
        const tx = db.transaction(POSTER_STORE, 'readwrite');
        const committed = awaitTransaction(tx);
        await awaitIDBRequest(tx.objectStore(POSTER_STORE).put({ id, blob }));
        await committed;
        // Memory mirrors disk only once disk has it; an aborted write must
        // not leave this tab believing the poster is cached.
        _defaultPosterMemoryCache = blob;
    } catch (_) { /* cache write failure is non-fatal */ }
}

// Schedule a callback for the next idle window. Returns a Promise that resolves
// when the callback finishes — the await chain pauses between items so each
// regeneration happens in its own idle slice (no long task / no UI jank).
function nextIdleSlice(timeoutMs = 5000) {
    return new Promise((resolve) => {
        const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 100));
        idle(resolve, { timeout: timeoutMs });
    });
}

// One-shot background migration: walk the videos store, find any record whose
// thumbnail blob is larger than THUMBNAIL_MIGRATION_SIZE_THRESHOLD, and rewrite
// it at the new compact size. Safe to interrupt — partial progress is preserved
// because each item is its own readwrite transaction. The flag is only marked
// 'done' after the loop finishes; an aborted migration retries on next boot.
async function migrateOversizedThumbnails() {
    try {
        const stored = await chrome.storage.local.get([THUMBNAIL_MIGRATION_FLAG]);
        if (stored[THUMBNAIL_MIGRATION_FLAG] === 'done') return;
    } catch (_) { return; }

    let db;
    try {
        db = await openDB(DB_NAME, DB_VERSION);
    } catch (_) { return; }

    // Phase 1: collect candidate keys with a single readonly cursor pass.
    // Holding the cursor across awaits is unsafe, so we copy keys eagerly.
    const candidates = [];
    try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        await new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onerror = () => reject(req.error);
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) { resolve(); return; }
                const val = cursor.value;
                if (val && val.thumbnail && typeof val.thumbnail.size === 'number'
                    && val.thumbnail.size > THUMBNAIL_MIGRATION_SIZE_THRESHOLD) {
                    candidates.push(cursor.key);
                }
                cursor.continue();
            };
        });
    } catch (_) {
        // Cursor failed — bail without marking done so we can retry next boot.
        return;
    }

    if (candidates.length === 0) {
        try { await chrome.storage.local.set({ [THUMBNAIL_MIGRATION_FLAG]: 'done' }); } catch (_) {}
        return;
    }

    // Phase 2: regenerate one at a time, yielding to idle between items so the
    // browser can paint, scroll, and respond to input without stutter.
    let migrated = 0;
    for (const key of candidates) {
        await nextIdleSlice();
        try {
            const record = await getVideoBlob(key);
            if (!record || !record.blob) continue;
            const kind = record.type === 'image' ? 'image' : 'video';
            const newThumb = await getThumbnail(record.blob, kind);
            // Skip the write if regeneration didn't actually shrink anything —
            // protects against pathological cases (already-small source).
            if (!newThumb || (record.thumbnail && newThumb.size >= record.thumbnail.size)) continue;
            const tx = db.transaction(DB_STORE, 'readwrite');
            const committed = awaitTransaction(tx);
            const store = tx.objectStore(DB_STORE);
            record.thumbnail = newThumb;
            await awaitIDBRequest(store.put(record));
            // Without waiting for the commit, a quota abort looked like success
            // and the migration marked itself done having written nothing.
            await committed;
            migrated++;
        } catch (err) {
            // Hitting the storage quota mid-migration means every subsequent
            // put would fail too — bail without marking done so the next boot
            // can pick up where we left off (after the user frees space).
            if (isQuotaError(err)) {
                console.warn('Thumbnail migration paused — storage quota reached. Will resume next boot.');
                return;
            }
            // One item's non-quota failure shouldn't abort the rest of the migration.
            console.warn('Thumbnail migration skipped for key', key, err);
        }
    }

    try { await chrome.storage.local.set({ [THUMBNAIL_MIGRATION_FLAG]: 'done' }); } catch (_) {}
    // (production console.log removed — migration is silent for the user; the
    // value was only useful during development.)
}

// Schedule the migration well after boot — wait for page load, then for an idle
// window, so we never compete with the user's first interaction. (`typeof window`
// guard removed — wallpaper.js only ever runs in the browser.)
{
    const startMigration = () => {
        nextIdleSlice(10000).then(() => migrateOversizedThumbnails());
    };
    if (document.readyState === 'complete') {
        startMigration();
    } else {
        window.addEventListener('load', startMigration, { once: true });
    }
}

// (countLiveWallpapers helper removed — zero callers across the codebase.)

async function getVideoBlob(key) {
    const db = await openDB(DB_NAME, DB_VERSION);
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore('videos');
    return awaitIDBRequest(store.get(key));
}

async function deleteVideoBlob(key) {
    const db = await openDB(DB_NAME, DB_VERSION);
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore('videos');

    const sideNav = document.getElementById('mySidenav');
    const scrollPosition = sideNav ? sideNav.scrollTop : 0;

    try {
        const committed = awaitTransaction(tx);
        store.delete(key);
        await committed;
        // Single read covers both rotation + active key — saves one async barrier
        // vs two sequential chrome.storage.local.get() calls.
        const stored = await chrome.storage.local.get(['rotationKeys', 'rotationDurations', 'activeVideoKey']);
        const rotationKeys = Array.isArray(stored.rotationKeys) ? stored.rotationKeys.map(String) : [];
        const updatedRotation = rotationKeys.filter((k) => k !== String(key));
        if (updatedRotation.length !== rotationKeys.length) {
            await chrome.storage.local.set({ rotationKeys: updatedRotation });
        }
        const durations = (stored.rotationDurations && typeof stored.rotationDurations === 'object') ? { ...stored.rotationDurations } : {};
        if (String(key) in durations) {
            delete durations[String(key)];
            _rotationDurationsCache = durations;
            await chrome.storage.local.set({ rotationDurations: durations });
        }

        const activeKey = stored.activeVideoKey ?? null;
        if (activeKey !== null && String(activeKey) === String(key)) {
            const remainingKeys = await getAllKeys();
            if (remainingKeys.length === 0) {
                await setActiveVideoKey('default');
            } else {
                await chrome.storage.local.remove(['activeVideoKey']);
            }
        }

        const modeSettings = await getWallpaperModeSettings();
        const dayWallpaperKeys = modeSettings.dayWallpaperKeys.filter((k) => String(k) !== String(key));
        const nightWallpaperKeys = modeSettings.nightWallpaperKeys.filter((k) => String(k) !== String(key));
        await chrome.storage.local.set({ dayWallpaperKeys, nightWallpaperKeys });

        showPush(t('wallpapers_toast_wallpaper_deleted'), 'default');
        updateVideo();

        setTimeout(() => {
            if (sideNav) {
                sideNav.scrollTop = scrollPosition;
            }
        }, 100);
        return true;
    } catch (e) {
        console.error('Error deleting wallpaper blob (key=' + key + '):', e);
        showPush(t('wallpapers_toast_delete_failed'), 'warning');
        return false;
    }
}

async function getAllKeys() {
    const db = await openDB(DB_NAME, DB_VERSION);
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    // Native IDBObjectStore.getAllKeys is one round-trip vs the cursor-walk
    // pattern, which fires onsuccess once per row. Same result, less code.
    return awaitIDBRequest(store.getAllKeys());
}

// ==============================
// WALLPAPER UI — cards, filters, settings panel
// ==============================

function clearAllActiveCardStates() {
    document.querySelectorAll('.fav-card').forEach(c => {
        c.classList.remove('active');
        setPinButtonState(c.querySelector('.fav-set'), false);
    });
}

function setPinButtonState(btn, isPinned) {
    if (!btn) return;
    btn.classList.toggle('is-pinned', isPinned);
    btn.innerHTML = isPinned
        ? '<span class="material-symbols-outlined">push_pin</span>'
        : '<span class="material-symbols-outlined">keep_off</span>';
    const pinLabel = isPinned ? t('wallpapers_unpin_title') : t('wallpapers_pin_title');
    btn.setAttribute('aria-label', pinLabel);
    btn.title = pinLabel;
}

function createRandomToggleButton(key, card) {
    const includeBtn = document.createElement('button');
    includeBtn.className = 'fav-include fav-random fav-icon-btn';
    includeBtn.title = t('wallpapers_random_add_title');
    includeBtn.setAttribute('aria-label', t('wallpapers_random_add_title'));
    includeBtn.innerHTML = '<span class="material-symbols-outlined">shuffle</span>';

    includeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isDayNightWidgetEnabled()) {
            showPush(t('wallpapers_toast_random_unavailable_daynight'), 'warning');
            return;
        }

        const activeKey = await getActiveVideoKey();
        if (activeKey) {
            if (activeKey === 'default') {
                showPush(t('wallpapers_toast_random_blocked_default'), 'warning');
            } else {
                showPush(t('wallpapers_toast_random_blocked_pinned'), 'warning');
            }
            return;
        }

        const res = await chrome.storage.local.get(['rotationKeys']);
        const rotationKeys = Array.isArray(res.rotationKeys) ? res.rotationKeys.map(String) : [];
        const ks = String(key);
        let updated;

        if (rotationKeys.includes(ks)) {
            updated = rotationKeys.filter(x => x !== ks);
            includeBtn.classList.remove('included');
            card.classList.remove('in-rotation');
            includeBtn.innerHTML = '<span class="material-symbols-outlined">shuffle</span>';
            includeBtn.title = t('wallpapers_random_add_title');
            includeBtn.setAttribute('aria-label', t('wallpapers_random_add_title'));
            showPush(t('wallpapers_toast_random_removed'), 'success');
        } else {
            updated = rotationKeys.concat([ks]);
            includeBtn.classList.add('included');
            card.classList.add('in-rotation');
            includeBtn.innerHTML = '<span class="material-symbols-outlined">check_circle</span>';
            includeBtn.title = t('wallpapers_random_remove_title');
            includeBtn.setAttribute('aria-label', t('wallpapers_random_remove_title'));
            showPush(t('wallpapers_toast_random_added'), 'success');
        }

        chrome.storage.local.set({ rotationKeys: updated });
        updateWallpaperCardBadges(card);
        applyWallpaperFilters();
    });

    return includeBtn;
}

// ==============================
// PER-WALLPAPER DURATION
// ==============================
// How long one wallpaper stays on screen when the timer is on. Stored in
// chrome.storage.local as { [key]: minutes }, next to rotationKeys and for the
// same reason: it names IndexedDB rows, so it never leaves this machine and is
// pruned wherever those rows are. The in-memory copy is what the synchronous
// card paths read; it is loaded once per tab and updated on every write.
let _rotationDurationsCache = {};
let _rotationDurationsLoaded = false;

async function loadRotationDurations() {
    if (_rotationDurationsLoaded) return _rotationDurationsCache;
    try {
        const res = await chrome.storage.local.get(['rotationDurations']);
        _rotationDurationsCache = (res.rotationDurations && typeof res.rotationDurations === 'object') ? { ...res.rotationDurations } : {};
    } catch (_) {
        _rotationDurationsCache = {};
    }
    _rotationDurationsLoaded = true;
    return _rotationDurationsCache;
}

function currentRotateMinutes() {
    return parseRotateMinutes(safeGet(STORAGE_KEYS.WALLPAPER_ROTATE_MINUTES));
}

function formatRotateMinutes(minutes) {
    return minutes >= 60 ? t('unit_hours', { count: minutes / 60 }) : t('unit_minutes', { count: minutes });
}

function shortRotateMinutes(minutes) {
    return minutes >= 60 ? t('unit_hours_compact', { count: minutes / 60 }) : t('unit_minutes_compact', { count: minutes });
}

function createDurationChip(key, card) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fav-duration';
    chip.title = t('wallpapers_duration_chip_title');
    chip.setAttribute('aria-label', chip.title);

    chip.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ks = String(key);
        const next = nextDurationOverride(_rotationDurationsCache[ks] ?? null);
        const updated = { ..._rotationDurationsCache };
        if (next === null) delete updated[ks]; else updated[ks] = next;
        try {
            await chrome.storage.local.set({ rotationDurations: updated });
        } catch (_) {
            showPush(t('common_save_failed_retry'), 'warning');
            return;
        }
        _rotationDurationsCache = updated;
        syncDurationChip(card);
        showPush(next === null ? t('wallpapers_toast_duration_follows_timer') : t('wallpapers_toast_duration_set', { duration: formatRotateMinutes(next) }), 'success');
        // The wallpaper on screen gets its new due time right away.
        if (ks === _wfShowingKey) scheduleWallpaperRotation();
    });

    return chip;
}

// Paints one card's chip from the cache. Visibility is CSS: the chip shows only
// while the timer is on and the card carries `in-pool`, which
// applyWallpaperFilters() sets from the same rule the picker uses.
function syncDurationChip(card) {
    const chip = card.querySelector('.fav-duration');
    if (!chip) return;
    const ks = String(card.dataset.key);
    const own = Number(_rotationDurationsCache[ks]);
    const override = WALLPAPER_ROTATE_CHOICES.includes(own) && own > 0;
    const minutes = override ? own : currentRotateMinutes();
    chip.textContent = minutes > 0 ? shortRotateMinutes(minutes) : '';
    chip.classList.toggle('is-override', override);
}

// ==============================
// DEFAULT WALLPAPER VISIBILITY
// ==============================
// The bundled wallpaper used to be undeletable, which reads as a bug once you
// have your own: there was no way to keep it out of the rotation permanently.
// It isn't a stored blob, so "delete" here means "hide" — the flag below.
const DEFAULT_WALLPAPER_HIDDEN_KEY = 'defaultWallpaperHidden';

async function getDefaultWallpaperHiddenFlag() {
    try {
        const res = await chrome.storage.local.get([DEFAULT_WALLPAPER_HIDDEN_KEY]);
        return res[DEFAULT_WALLPAPER_HIDDEN_KEY] === true;
    } catch (_) {
        return false;
    }
}

async function setDefaultWallpaperHiddenFlag(hidden) {
    try {
        await chrome.storage.local.set({ [DEFAULT_WALLPAPER_HIDDEN_KEY]: !!hidden });
        return true;
    } catch (_) {
        showPush(t('common_save_failed_retry'), 'warning');
        return false;
    }
}

// The flag only takes effect while at least one custom wallpaper exists, so
// hiding the default can never leave the library empty and the page without a
// background. Delete every custom wallpaper and the default returns on its own;
// upload one again and the earlier choice applies once more. The flag is never
// cleared, so the preference survives that round trip.
async function isDefaultWallpaperHidden(customCount) {
    if (!customCount) return false;
    return getDefaultWallpaperHiddenFlag();
}

// Drops 'default' out of rotation, both day/night slots, and the pinned key.
// Runs on hide so a hidden wallpaper can't still be picked by updateVideo().
async function detachDefaultWallpaperFromSelections() {
    const stored = await chrome.storage.local.get(['rotationKeys', 'activeVideoKey']);
    const rotationKeys = (Array.isArray(stored.rotationKeys) ? stored.rotationKeys.map(String) : [])
        .filter((k) => k !== 'default');
    await chrome.storage.local.set({ rotationKeys });

    const modeSettings = await getWallpaperModeSettings();
    await chrome.storage.local.set({
        dayWallpaperKeys: modeSettings.dayWallpaperKeys.filter((k) => String(k) !== 'default'),
        nightWallpaperKeys: modeSettings.nightWallpaperKeys.filter((k) => String(k) !== 'default'),
    });

    if (String(stored.activeVideoKey ?? '') === 'default') {
        await chrome.storage.local.remove(['activeVideoKey']);
    }
}

// Hiding the default is only honest if there's a way back. The control lives in
// Settings rather than under the wallpaper list: the list is for content, and a
// permanent row there would tax every user to cover a rare case. It only appears
// while the hide flag is actually in effect.
//
// Kept in this module (not widgets.js, which owns the rest of the Settings pane)
// because this is where the flag and updateVideo() live — wiring it from there
// would add another undeclared cross-file dependency.
function syncRestoreDefaultWallpaperRow(isHidden) {
    const row = document.getElementById('restore-default-wallpaper-row');
    if (!row) return;
    row.classList.toggle('is-hidden', !isHidden);

    if (row.dataset.bound === 'true') return;
    row.dataset.bound = 'true';

    const btn = document.getElementById('restore-default-wallpaper-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const sideNav = document.getElementById('mySidenav');
        const scrollPosition = sideNav ? sideNav.scrollTop : 0;

        if (!(await setDefaultWallpaperHiddenFlag(false))) return;
        showPush(t('wallpapers_toast_default_restored'), 'success');
        // Re-renders the list (the card comes back), makes the default eligible
        // for rotation again, and drives this row back to hidden via
        // updateSettings().
        updateVideo();

        setTimeout(() => {
            if (sideNav) sideNav.scrollTop = scrollPosition;
        }, 50);
    });
}

function addDefaultWallpaperCard(container, customWallpapersCount = 0, activeKeyForUI = null) {
    const card = document.createElement('div');
    card.className = 'fav-card default-wallpaper';
    card.dataset.key = 'default';

    // Default thumbnail uses a static cached poster — never decodes the MP4 in the menu.
    // Cold cache: gradient placeholder paints instantly, real frame is generated in idle
    // time and persisted to IndexedDB. Warm cache: poster is read from in-memory or IDB
    // cache and applied within one frame. The active live wallpaper still uses the full
    // MP4 — that path runs through updateVideo() and is unaffected.
    const thumb = document.createElement('img');
    thumb.className = 'fav-thumb default-thumb default-thumb-placeholder';
    thumb.alt = 'default wallpaper thumbnail';

    const generation = ++_defaultThumbGen;
    thumb.dataset.generation = String(generation);

    const applyPoster = (blob) => {
        if (!blob || Number(thumb.dataset.generation) !== generation || !thumb.isConnected) return;
        const url = URL.createObjectURL(blob);
        const revoke = () => URL.revokeObjectURL(url);
        thumb.onload = () => { revoke(); thumb.classList.remove('default-thumb-placeholder'); };
        thumb.onerror = revoke;
        thumb.src = url;
    };

    (async () => {
        const cached = await getCachedDefaultPoster(DEFAULT_POSTER_CACHE_KEY);
        if (cached) {
            applyPoster(cached);
            return;
        }
        // Cold cache — generate the poster off the critical render path so the menu
        // open is never blocked by video decoding. Placeholder gradient stays visible
        // until the real frame is ready (typically <1s on first run, then cached forever).
        const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
        idle(async () => {
            try {
                const blob = await generateThumbnailFromURL(chrome.runtime.getURL('src/videos/default.mp4'));
                await putCachedDefaultPoster(DEFAULT_POSTER_CACHE_KEY, blob);
                applyPoster(blob);
            } catch (err) {
                console.error('Default poster generation failed:', err);
                // Placeholder gradient stays visible — no further fallback needed.
            }
        }, { timeout: 2000 });
    })();

    const btns = document.createElement('div');
    btns.className = 'fav-btns';

    const setBtn = document.createElement('button');
    setBtn.className = 'fav-set fav-pin-btn fav-icon-btn';
    setPinButtonState(setBtn, false);

    if (customWallpapersCount === 0) {
        setBtn.classList.add('is-hidden');
    }

    setBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const sideNav = document.getElementById('mySidenav');
        const scrollPosition = sideNav ? sideNav.scrollTop : 0;

        const currentActive = await getActiveVideoKey();
        if (currentActive === 'default') {
            chrome.storage.local.remove(['activeVideoKey']);
            card.classList.remove('active');
            setPinButtonState(setBtn, false);
            showPush(t('wallpapers_toast_pin_removed'), 'success');
            updateVideo('SET_BUTTON');
        } else {
            await setActiveVideoKey('default');
            showPush(t('wallpapers_toast_default_pinned'), 'success');
            updateVideo('SET_BUTTON');
            clearAllActiveCardStates();
            card.classList.add('active');
            setPinButtonState(setBtn, true);
        }
        refreshWallpaperCardsMeta();

        setTimeout(() => {
            if (sideNav) {
                sideNav.scrollTop = scrollPosition;
            }
        }, 50);
    });

    const includeBtn = createRandomToggleButton('default', card);
    if (customWallpapersCount === 0) {
        includeBtn.classList.add('is-hidden');
    }
    const { dayBtn, nightBtn } = createWallpaperTimeSlotButtons('default');

    // Same affordance custom wallpapers have, but only once the user actually
    // has something to fall back on — offering it with an empty library would
    // just fail or blank the page.
    const hideBtn = document.createElement('button');
    hideBtn.className = 'fav-remove fav-icon-btn';
    hideBtn.title = t('wallpapers_default_hide_title');
    hideBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    hideBtn.setAttribute('aria-label', t('wallpapers_default_hide_title'));
    if (customWallpapersCount === 0) {
        hideBtn.classList.add('is-hidden');
    }
    hideBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const sideNav = document.getElementById('mySidenav');
        const scrollPosition = sideNav ? sideNav.scrollTop : 0;

        const shouldHide = await confirmWallpaperDelete({
            card,
            title: t('wallpapers_confirm_hide_title'),
            subtitle: t('wallpapers_confirm_hide_subtitle'),
        });
        if (!shouldHide) return;

        if (!(await setDefaultWallpaperHiddenFlag(true))) return;
        await detachDefaultWallpaperFromSelections();

        card.classList.add('deleting');
        setTimeout(() => card.remove(), 800);
        showPush(t('wallpapers_toast_default_hidden'), 'success');
        // Re-picks a wallpaper (the default may have been the active one) and
        // re-renders the list through updateSettings().
        updateVideo();

        setTimeout(() => {
            if (sideNav) sideNav.scrollTop = scrollPosition;
        }, 850);
    });

    btns.appendChild(setBtn);
    btns.appendChild(dayBtn);
    btns.appendChild(nightBtn);
    btns.appendChild(includeBtn);
    btns.appendChild(hideBtn);

    const media = document.createElement('div');
    media.className = 'fav-media';
    media.appendChild(thumb);
    media.appendChild(createDurationChip('default', card));

    // No label: the bundled wallpaper is the one card that cannot be deleted,
    // only hidden, and it always sits first. A word saying so was one more
    // thing to read in a list that is meant to be scanned.
    card.appendChild(media);
    card.appendChild(btns);
    container.appendChild(card);
    updateWallpaperCardBadges(card);

    if (activeKeyForUI === 'default') {
        card.classList.add('active');
        setPinButtonState(setBtn, true);
    }
    (async () => {
        const res = await chrome.storage.local.get(['rotationKeys']);
        const rotationKeys = Array.isArray(res.rotationKeys) ? res.rotationKeys.map(String) : [];
        if (rotationKeys.includes('default')) {
            includeBtn.classList.add('included');
            includeBtn.innerHTML = '<span class="material-symbols-outlined">check_circle</span>';
            includeBtn.title = t('wallpapers_random_remove_title');
            includeBtn.setAttribute('aria-label', t('wallpapers_random_remove_title'));
            card.classList.add('in-rotation');
        }
        updateWallpaperCardBadges(card);
    })();
    applyWallpaperFilters();
}

// `fileName` parameter dropped — declared but never read in the body.
async function updateSettings(keys, toUpdate) {
    if (toUpdate === 'last') {
        keys = keys.slice(-1);
    }

    if (Array.isArray(keys)) {
        const seen = new Set();
        const unique = [];
        for (const k of keys) {
            const ks = String(k);
            if (!seen.has(ks)) {
                seen.add(ks);
                unique.push(k);
            }
        }
        keys = unique;
    }

    const listContainer = document.getElementById('wallpapers-list');
    if (!listContainer) return;

    const scrollPosition = listContainer.scrollTop;
    const activeKey = await getCurrentPrimaryKeyForUI(keys);

    const existingDefaultCard = listContainer.querySelector('.default-wallpaper');

    // `keys` is sliced to one entry on the upload path, so it can't be used as
    // the library size there — and the size is exactly what decides whether the
    // hide flag applies.
    const totalCustomCount = toUpdate === 'last'
        ? (await getAllKeys()).length
        : keys.length;
    const defaultHidden = await isDefaultWallpaperHidden(totalCustomCount);

    if (toUpdate !== 'last') {
        const customCards = listContainer.querySelectorAll('.fav-card:not(.default-wallpaper)');
        customCards.forEach(card => card.remove());

        if (defaultHidden) {
            // Nothing to render or update — the block below is all about a card
            // that shouldn't exist right now.
        } else if (!existingDefaultCard) {
            addDefaultWallpaperCard(listContainer, keys.length, activeKey);
        } else {
            const defaultCard = listContainer.querySelector('.default-wallpaper');
            const setBtn = defaultCard.querySelector('.fav-set');
            const randomBtn = defaultCard.querySelector('.fav-include');
            if (setBtn && keys.length === 0) {
                setBtn.classList.add('is-hidden');
            } else if (setBtn && keys.length > 0) {
                setBtn.classList.remove('is-hidden');
            }
            if (randomBtn && keys.length === 0) {
                randomBtn.classList.add('is-hidden');
                defaultCard.classList.remove('in-rotation');
                const rotRes = await chrome.storage.local.get(['rotationKeys']);
                const rotationKeys = Array.isArray(rotRes.rotationKeys) ? rotRes.rotationKeys.map(String) : [];
                const nextRotationKeys = rotationKeys.filter((k) => k !== 'default');
                if (nextRotationKeys.length !== rotationKeys.length) {
                    await chrome.storage.local.set({ rotationKeys: nextRotationKeys });
                }
            } else if (randomBtn && keys.length > 0) {
                randomBtn.classList.remove('is-hidden');
            }
            const hideBtn = defaultCard.querySelector('.fav-remove');
            if (hideBtn) hideBtn.classList.toggle('is-hidden', keys.length === 0);
            const isDefaultActive = activeKey === 'default';
            defaultCard.classList.toggle('active', isDefaultActive);
            setPinButtonState(setBtn, isDefaultActive);
            updateWallpaperCardBadges(defaultCard);
        }
    }

    // Covers the upload path too: hiding only becomes effective once the first
    // custom wallpaper lands, and that render goes through toUpdate === 'last'.
    if (defaultHidden) {
        const staleDefaultCard = listContainer.querySelector('.default-wallpaper');
        if (staleDefaultCard) staleDefaultCard.remove();
    }
    syncRestoreDefaultWallpaperRow(defaultHidden);
    syncDeleteAllWallpapersRow(totalCustomCount);
    updateWallpaperStorageRow();

    // (#favorites-title was renamed to a static "Wallpapers" heading and
    //  the id was dropped from the HTML; the JS guard above ran no code.)

    // Pre-fetch all storage entries the per-card sync needs in ONE call.
    // Previously each iteration of the for-loop below spawned its own
    // chrome.storage.local.get(['rotationKeys']) — for a library of 50
    // wallpapers that's 50 round-trips reading the same array. The keys
    // here cover the three lookups (rotation, day, night) the card needs.
    let preloadedRotationKeys = [];
    let preloadedDayKeys = [];
    let preloadedNightKeys = [];
    try {
        const preload = await chrome.storage.local.get([
            'rotationKeys', 'dayWallpaperKeys', 'nightWallpaperKeys',
            'dayPrimaryKey', 'nightPrimaryKey'
        ]);
        preloadedRotationKeys = Array.isArray(preload.rotationKeys)
            ? preload.rotationKeys.map(String)
            : [];
        preloadedDayKeys = Array.isArray(preload.dayWallpaperKeys)
            ? preload.dayWallpaperKeys.map(String)
            : (preload.dayPrimaryKey ? [String(preload.dayPrimaryKey)] : []);
        preloadedNightKeys = Array.isArray(preload.nightWallpaperKeys)
            ? preload.nightWallpaperKeys.map(String)
            : (preload.nightPrimaryKey ? [String(preload.nightPrimaryKey)] : []);
    } catch (_) { /* fall back to empty arrays */ }

    for (const key of keys) {
        let thumbnailSrc = '';
        let mediaSize = 0;

        const record = await getVideoBlob(key);
        const mediaBlob = recordMediaBlob(record);
        if (mediaBlob && mediaBlob.size) mediaSize = mediaBlob.size;
        if (record) {
            if (Array.isArray(record)) {
                thumbnailSrc = URL.createObjectURL(record[1]);
            } else if (record.thumbnail) {
                thumbnailSrc = URL.createObjectURL(record.thumbnail);
            }
        }

        const card = document.createElement('div');
        card.className = 'fav-card';
        card.dataset.key = String(key);

        const thumb = document.createElement('img');
        thumb.className = 'fav-thumb';
        thumb.src = thumbnailSrc || '';
        thumb.alt = 'thumbnail';
        // Revoke the blob URL once the browser has decoded the thumbnail,
        // whether load succeeds or errors — prevents blob accumulation.
        if (thumbnailSrc) {
            const revoke = () => { try { URL.revokeObjectURL(thumbnailSrc); } catch (_) {} };
            thumb.addEventListener('load', revoke, { once: true });
            thumb.addEventListener('error', revoke, { once: true });
        }

        const btns = document.createElement('div');
        btns.className = 'fav-btns';

        const setBtn = document.createElement('button');
        setBtn.className = 'fav-set fav-pin-btn fav-icon-btn';
        if (activeKey && String(activeKey) === String(key)) {
            card.classList.add('active');
            setPinButtonState(setBtn, true);
        } else {
            setPinButtonState(setBtn, false);
        }

        if (keys.length === 0) {
            setBtn.classList.add('is-hidden');
        }

        setBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const sideNav = document.getElementById('mySidenav');
            const scrollPosition = sideNav ? sideNav.scrollTop : 0;

            const k = parseInt(card.dataset.key);
            const currentActive = await getActiveVideoKey();
            if (currentActive && parseInt(currentActive) === k) {
                await chrome.storage.local.remove(['activeVideoKey']);
                clearAllActiveCardStates();
                showPush(t('wallpapers_toast_pin_removed_random_active'), 'success');
                updateVideo('SET_BUTTON');
            } else {
                await setActiveVideoKey(k);
                showPush(t('wallpapers_toast_pinned'), 'success');
                updateVideo('SET_BUTTON');
                clearAllActiveCardStates();
                card.classList.add('active');
                setPinButtonState(setBtn, true);
            }
            refreshWallpaperCardsMeta();

            setTimeout(() => {
                if (sideNav) {
                    sideNav.scrollTop = scrollPosition;
                }
            }, 50);
        });

        const remBtn = document.createElement('button');
        remBtn.className = 'fav-remove fav-icon-btn';
        remBtn.title = t('wallpapers_delete_title');
        remBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
        remBtn.setAttribute('aria-label', t('wallpapers_delete_aria'));
        remBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const sideNav = document.getElementById('mySidenav');
            const scrollPosition = sideNav ? sideNav.scrollTop : 0;

            const k = parseInt(card.dataset.key);

            // Inline confirm — overlay drops onto the card itself (no fullscreen
            // modal, no thumbnail regen needed since the card's own thumbnail
            // shows through the blurred overlay).
            const shouldDelete = await confirmWallpaperDelete({
                card,
                title: t('wallpapers_confirm_delete_title'),
                subtitle: t('wallpapers_confirm_delete_subtitle'),
            });

            if (!shouldDelete) return;

            // The card leaves only once the row is gone. Removing it first and
            // hoping showed a wallpaper as deleted that came back on reload.
            const deleted = await deleteVideoBlob(k);
            if (!deleted) return;

            card.classList.add('deleting');
            setTimeout(() => card.remove(), 800);
            setTimeout(() => refreshWallpaperCardsMeta(), 810);

            setTimeout(() => {
                if (sideNav) {
                    sideNav.scrollTop = scrollPosition;
                }
            }, 850);
        });
        const includeBtn = createRandomToggleButton(String(key), card);

        const { dayBtn, nightBtn } = createWallpaperTimeSlotButtons(String(key));

        btns.appendChild(setBtn);
        btns.appendChild(dayBtn);
        btns.appendChild(nightBtn);
        btns.appendChild(includeBtn);
        btns.appendChild(remBtn);

        // The size rides on the thumbnail rather than sitting beside it, the
        // way a duration badge does on a video. Placing it in the row cost
        // real width, and the card had almost none to give: with the panel's
        // 12px scrollbar taking layout space, the widest labels pushed the
        // delete button past the card edge. Over the thumbnail it costs
        // nothing horizontally or vertically, and reads as belonging to that
        // wallpaper rather than floating between it and the controls.
        const media = document.createElement('div');
        media.className = 'fav-media';
        media.appendChild(thumb);
        media.appendChild(createDurationChip(key, card));

        // The gap between the thumbnail and the buttons was empty and the
        // image was not, so the size reads there rather than over the artwork.
        // It rides inside the button row, positioned just left of it, because
        // as a flex child it claimed width even while invisible and pushed the
        // delete button past the edge of the card.
        const sizeEl = document.createElement('span');
        sizeEl.className = 'fav-meta fav-size';
        sizeEl.textContent = mediaSize ? formatBytes(mediaSize) : '';

        if (sizeEl.textContent) btns.appendChild(sizeEl);
        card.appendChild(media);
        card.appendChild(btns);

        listContainer.appendChild(card);
        if (activeKey && parseInt(key) === parseInt(activeKey)) {
            card.classList.add('active');
            const btn = card.querySelector('.fav-set');
            setPinButtonState(btn, true);
        }

        // Sync the include/random toggle state from the preloaded snapshot.
        // No async work — the storage read happened once before the loop.
        const ib = card.querySelector('.fav-include');
        if (ib) {
            if (preloadedRotationKeys.includes(String(key))) {
                ib.classList.add('included');
                card.classList.add('in-rotation');
                ib.innerHTML = '<span class="material-symbols-outlined">check_circle</span>';
                ib.title = t('wallpapers_random_remove_title');
                ib.setAttribute('aria-label', t('wallpapers_random_remove_title'));
            } else {
                ib.classList.remove('included');
                card.classList.remove('in-rotation');
                ib.innerHTML = '<span class="material-symbols-outlined">shuffle</span>';
                ib.title = t('wallpapers_random_add_title');
                ib.setAttribute('aria-label', t('wallpapers_random_add_title'));
            }
        }

        // Sync day/night assignment chips from the preloaded snapshot.
        const keyStr = String(key);
        const dayBtnEl = card.querySelector('.fav-time-slot[data-slot="day"]');
        const nightBtnEl = card.querySelector('.fav-time-slot[data-slot="night"]');
        if (dayBtnEl) dayBtnEl.classList.toggle('active-day', preloadedDayKeys.includes(keyStr));
        if (nightBtnEl) nightBtnEl.classList.toggle('active-night', preloadedNightKeys.includes(keyStr));

        updateWallpaperCardBadges(card);
    }
    // The per-card loop above already synced badges, rotation toggle, and
    // day/night chips from the preloaded snapshot — refreshWallpaperCardsMeta()
    // would walk the same cards a second time. Skip it; only call the global
    // helpers that aren't per-card.
    applyWallpaperFilters();
    updateDayNightUiAvailability();

    setTimeout(() => {
        if (listContainer) {
            listContainer.scrollTop = scrollPosition;
        }
    }, 0);
}

function initializeWallpaperFilterControls() {
    const filterButtons = document.querySelectorAll('.wallpapers-filter-btn');
    if (!filterButtons.length) return;

    for (const button of filterButtons) {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const filter = button.getAttribute('data-filter');
            if (!filter) return;
            if (filter === 'random' && isDayNightWidgetEnabled()) {
                showPush(t('wallpapers_toast_random_filter_unavailable'), 'warning');
                return;
            }
            if ((filter === 'day' || filter === 'night') && !isDayNightWidgetEnabled()) {
                showPush(t('wallpapers_toast_daynight_inactive'), 'warning');
                return;
            }
            currentWallpapersFilter = filter;
            updateWallpaperFilterButtons();
            applyWallpaperFilters();
        });
    }

    updateWallpaperFilterButtons();
    applyWallpaperFilters();
    updateDayNightUiAvailability();
    renderWallpaperFilterHelpContent();
    initializeWallpaperFilterHelp();
    initializeWallpaperRotationSettings();
}

// The "Change wallpaper" segment above the list. Changing it never swaps the
// wallpaper on screen; it only gives it a new due time.
function initializeWallpaperRotationSettings() {
    const row = document.getElementById('wallpapers-rotation-row');
    if (!row) return;
    const buttons = row.querySelectorAll('.widget-open-mode-btn[data-setting="wallpaperRotate"]');
    const list = document.getElementById('wallpapers-list');

    const sync = () => {
        const minutes = currentRotateMinutes();
        for (const btn of buttons) {
            const isActive = parseRotateMinutes(btn.getAttribute('data-value')) === minutes;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
        if (list) list.classList.toggle('rotation-on', minutes > 0);
    };

    sync();
    applyWallpaperFilters();
    renderWallpaperFilterHelpContent();
    scheduleWallpaperRotation();
    scheduleDayNightBoundary();

    if (row.dataset.initialized === 'true') return;
    row.dataset.initialized = 'true';

    row.addEventListener('click', (e) => { e.stopPropagation(); });
    for (const btn of buttons) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const minutes = parseRotateMinutes(btn.getAttribute('data-value'));
            safeSet(STORAGE_KEYS.WALLPAPER_ROTATE_MINUTES, String(minutes));
            sync();
            applyWallpaperFilters();
            renderWallpaperFilterHelpContent();
            scheduleWallpaperRotation();
            scheduleDayNightBoundary();
            showPush(minutes > 0
                ? t('wallpapers_toast_rotation_every', { duration: formatRotateMinutes(minutes) })
                : t('wallpapers_toast_rotation_new_tab_only'), 'success');
        });
    }
}

function updateWallpaperFilterButtons() {
    const filterButtons = document.querySelectorAll('.wallpapers-filter-btn');
    for (const button of filterButtons) {
        const filter = button.getAttribute('data-filter');
        const isActive = filter === currentWallpapersFilter;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
    renderWallpaperFilterHelpContent();
}

function renderWallpaperFilterHelpContent() {
    const helpDropdown = document.querySelector('#wallpapers-filter-help .wallpapers-filter-help-dropdown');
    if (!helpDropdown) return;
    const hasVisibleButton = (selector) =>
        Array.from(document.querySelectorAll(selector)).some((el) => el.style.display !== 'none');

    // Day and Night start at 07:00 and 19:00 (isDayPeriod), written the way
    // the reader's locale writes times.
    const clockTime = (hour, minute) => new Intl.DateTimeFormat(window.wfI18n ? wfI18n.intlLocales() : [], { hour: 'numeric', minute: '2-digit' })
        .format(new Date(2000, 0, 1, hour, minute));

    // Each action is known by its id. The help used to be filtered by its
    // English label, which a translation would have broken.
    const actions = [
        { id: 'pin', icon: 'push_pin', label: t('wallpapers_help_pin'), description: t('wallpapers_help_pin_desc') },
        { id: 'random', icon: 'shuffle', label: t('wallpapers_help_random'), description: t('wallpapers_help_random_desc') },
        { id: 'day', icon: 'wb_sunny', label: t('wallpapers_help_day'), description: t('wallpapers_help_day_desc', { start: clockTime(7, 0), end: clockTime(18, 59) }) },
        { id: 'night', icon: 'dark_mode', label: t('wallpapers_help_night'), description: t('wallpapers_help_night_desc', { start: clockTime(19, 0), end: clockTime(6, 59) }) },
        { id: 'delete', icon: 'delete', label: t('wallpapers_help_delete'), description: t('wallpapers_help_delete_desc') },
        { id: 'rotate', icon: 'repeat', label: t('wallpapers_help_timer'), description: t('wallpapers_help_timer_desc') },
    ];

    const visibleActions = actions.filter((action) => {
        if (action.id === 'pin') return hasVisibleButton('#wallpapers-list .fav-set');
        if (action.id === 'random') return hasVisibleButton('#wallpapers-list .fav-random');
        if (action.id === 'day') return hasVisibleButton('#wallpapers-list .fav-time-slot[data-slot="day"]');
        if (action.id === 'night') return hasVisibleButton('#wallpapers-list .fav-time-slot[data-slot="night"]');
        if (action.id === 'delete') return hasVisibleButton('#wallpapers-list .fav-remove');
        if (action.id === 'rotate') return currentRotateMinutes() > 0;
        return false;
    });

    helpDropdown.replaceChildren();
    for (const action of visibleActions) {
        const row = document.createElement('div');
        row.className = 'wallpapers-help-row';
        const iconWrap = document.createElement('span');
        iconWrap.className = `wallpapers-help-icon wallpapers-help-icon-${action.id}`;
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = action.icon;
        iconWrap.appendChild(icon);
        const text = document.createElement('span');
        text.className = 'wallpapers-help-text';
        text.appendChild(tHtml('wallpapers_help_row_html', { label: action.label, description: action.description }));
        row.appendChild(iconWrap);
        row.appendChild(text);
        helpDropdown.appendChild(row);
    }

    const note = document.createElement('div');
    note.className = 'wallpapers-help-note';
    note.appendChild(isDayNightWidgetEnabled() ? tHtml('wallpapers_help_note_daynight_html') : tHtml('wallpapers_help_note_random_html'));
    helpDropdown.appendChild(note);
}

function applyWallpaperFilters() {
    const listContainer = document.getElementById('wallpapers-list');
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.fav-card');
    const emptyState = document.getElementById('wallpapers-empty-state');
    const counts = { all: 0, primary: 0, random: 0, day: 0, night: 0 };
    let visibleCount = 0;
    // The list the timer walks, computed from the cards with the same rule the
    // picker uses, so the duration chips appear on exactly the wallpapers that
    // can come up.
    const poolInput = { keys: [], rotationKeys: [], dayKeys: [], nightKeys: [] };

    for (const card of cards) {
        const isPrimary = card.classList.contains('active');
        const isInRotation = card.classList.contains('in-rotation');
        const isDay = card.querySelector('.fav-time-slot[data-slot="day"]')?.classList.contains('active-day');
        const isNight = card.querySelector('.fav-time-slot[data-slot="night"]')?.classList.contains('active-night');
        const ks = String(card.dataset.key);
        if (ks !== 'default') poolInput.keys.push(ks);
        if (isInRotation) poolInput.rotationKeys.push(ks);
        if (isDay) poolInput.dayKeys.push(ks);
        if (isNight) poolInput.nightKeys.push(ks);

        counts.all += 1;
        if (isPrimary) counts.primary += 1;
        if (isInRotation) counts.random += 1;
        if (isDay) counts.day += 1;
        if (isNight) counts.night += 1;

        const shouldHide =
            (currentWallpapersFilter === 'primary' && !isPrimary) ||
            (currentWallpapersFilter === 'random' && !isInRotation) ||
            (currentWallpapersFilter === 'day' && !isDay) ||
            (currentWallpapersFilter === 'night' && !isNight);

        card.classList.toggle('wallpaper-filter-hidden', shouldHide);
        if (!shouldHide) visibleCount += 1;
    }

    const pool = buildCandidatePool({
        ...poolInput,
        dayNightEnabled: isDayNightWidgetEnabled(),
        isDay: isDayPeriod(),
        defaultHidden: !listContainer.querySelector('.fav-card.default-wallpaper'),
    });
    listContainer.dataset.poolSize = String(pool.length);
    for (const card of cards) {
        card.classList.toggle('in-pool', pool.includes(String(card.dataset.key)));
        syncDurationChip(card);
    }

    for (const btn of document.querySelectorAll('.wallpapers-filter-btn[data-filter]')) {
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

    if (emptyState) {
        emptyState.classList.toggle('show', visibleCount === 0);
    }

    updateWallpaperModeHint();
}

// Nothing is written over the thumbnail any more. Pills saying Primary and
// Random used to sit there, on an image 90 pixels wide that two of them
// covered completely, while a pinned wallpaper already had a teal card border
// and a teal pin button and one in the rotation a teal shuffle button. The
// wallpaper on screen is marked the way a pinned one already was, by the
// card's own border, and the file size appears beside the buttons on hover.
//
// Derived here rather than set from outside: this runs from five places and
// each has to leave the card in the right state. A pinned card is the one on
// screen by definition and already wears the border, so it keeps no ring.
function updateWallpaperCardBadges(card) {
    const isPrimary = card.classList.contains('active');
    const isShowing = !isPrimary && _wfShowingKey !== null && String(card.dataset.key) === _wfShowingKey;
    card.classList.toggle('is-showing', isShowing);
    const thumb = card.querySelector('.fav-thumb');
    if (thumb) {
        if (isShowing) thumb.title = t('wallpapers_on_screen_now_title');
        else thumb.removeAttribute('title');
    }
}

async function updateWallpaperModeHint() {
    const hint = document.getElementById('wallpapers-mode-hint');
    if (!hint) return;

    const hasPrimary = !!document.querySelector('#wallpapers-list .fav-card.active');
    const dayNightEnabled = isDayNightWidgetEnabled();
    const timerOn = currentRotateMinutes() > 0;

    if (hasPrimary) {
        // Four whole sentences rather than one assembled from pieces.
        if (dayNightEnabled) {
            hint.textContent = timerOn ? t('wallpapers_hint_primary_daynight_timer') : t('wallpapers_hint_primary_daynight');
        } else {
            hint.textContent = timerOn ? t('wallpapers_hint_primary_random_timer') : t('wallpapers_hint_primary_random');
        }
        hint.classList.add('show');
        return;
    }

    if (timerOn) {
        const list = document.getElementById('wallpapers-list');
        const poolSize = Number(list?.dataset.poolSize || 0);
        if (poolSize < 2) {
            hint.textContent = t('wallpapers_hint_add_second');
            hint.classList.add('show');
            return;
        }
    }

    hint.classList.remove('show');
}

function initializeWallpaperFilterHelp() {
    const helpContainers = document.querySelectorAll('.wallpapers-filter-help');
    if (!helpContainers.length) return;

    const closeAll = (except = null) => {
        for (const container of helpContainers) {
            if (except && container === except) continue;
            container.classList.remove('open');
            const btn = container.querySelector('.wallpapers-filter-help-btn');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        }
    };

    for (const helpContainer of helpContainers) {
        const helpBtn = helpContainer.querySelector('.wallpapers-filter-help-btn');
        const helpDropdown = helpContainer.querySelector('.wallpapers-filter-help-dropdown');
        if (!helpBtn || !helpDropdown) continue;

        helpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = helpContainer.classList.contains('open');
            closeAll(helpContainer);
            helpContainer.classList.toggle('open', !isOpen);
            helpBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        });

        helpDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.wallpapers-filter-help')) {
            closeAll();
        }
    });
}

function createWallpaperTimeSlotButtons(key) {
    const dayNightEnabled = isDayNightWidgetEnabled();

    const dayBtn = document.createElement('button');
    dayBtn.className = 'fav-time-slot';
    dayBtn.setAttribute('data-slot', 'day');
    dayBtn.setAttribute('aria-label', t('wallpapers_day_slot_aria'));
    dayBtn.title = t('wallpapers_day_slot_title');
    dayBtn.innerHTML = '<span class="material-symbols-outlined">wb_sunny</span>';
    dayBtn.classList.toggle('is-hidden', !(dayNightEnabled));
    dayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setWallpaperTimeSlot('day', key).catch(() => showPush(t('wallpapers_toast_day_save_failed'), 'warning'));
    });

    const nightBtn = document.createElement('button');
    nightBtn.className = 'fav-time-slot';
    nightBtn.setAttribute('data-slot', 'night');
    nightBtn.setAttribute('aria-label', t('wallpapers_night_slot_aria'));
    nightBtn.title = t('wallpapers_night_slot_title');
    nightBtn.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
    nightBtn.classList.toggle('is-hidden', !(dayNightEnabled));
    nightBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setWallpaperTimeSlot('night', key).catch(() => showPush(t('wallpapers_toast_night_save_failed'), 'warning'));
    });

    return { dayBtn, nightBtn };
}

async function setWallpaperTimeSlot(slot, key) {
    const storageKey = slot === 'day' ? 'dayWallpaperKeys' : 'nightWallpaperKeys';
    const settings = await getWallpaperModeSettings();
    const currentList = Array.isArray(settings[storageKey]) ? settings[storageKey] : [];
    const keyStr = String(key);
    const isSelected = currentList.includes(keyStr);
    const nextList = isSelected
        ? currentList.filter((k) => k !== keyStr)
        : currentList.concat([keyStr]);
    await chrome.storage.local.set({ [storageKey]: nextList });

    let slotMessage;
    if (slot === 'day') slotMessage = isSelected ? t('wallpapers_toast_day_removed') : t('wallpapers_toast_day_saved');
    else slotMessage = isSelected ? t('wallpapers_toast_night_removed') : t('wallpapers_toast_night_saved');
    showPush(slotMessage, 'success');
    // refreshWallpaperCardsMeta() now syncs the day/night chips inline,
    // so the explicit refreshScheduleSlotButtons() call after it is no
    // longer needed (it would walk the same cards a second time).
    refreshWallpaperCardsMeta();
    updateVideo('SET_BUTTON');
}

// Consolidated single-pass refresh:
// - The previous version walked the card list 4× (badges, filters,
//   schedule-slots, then the filter helper walks again internally).
// - Now we read `dayKeys`/`nightKeys` once via getWallpaperModeSettings(),
//   walk the cards a single time updating badges + day/night chips, then
//   call applyWallpaperFilters() for its (cheap) count-and-toggle pass.
// - kept async because getWallpaperModeSettings is async; callers that
//   don't await it (most do not) keep working — the function is fire-
//   and-forget, the visible UI updates resolve in the next microtask.
async function refreshWallpaperCardsMeta() {
    const cards = document.querySelectorAll('#wallpapers-list .fav-card');
    let dayKeys = [];
    let nightKeys = [];
    try {
        const settings = await getWallpaperModeSettings();
        dayKeys = settings.dayWallpaperKeys.map(String);
        nightKeys = settings.nightWallpaperKeys.map(String);
    } catch (_) { /* fall back to no day/night sync */ }

    for (const card of cards) {
        updateWallpaperCardBadges(card);
        const key = String(card.getAttribute('data-key'));
        const dayBtn = card.querySelector('.fav-time-slot[data-slot="day"]');
        const nightBtn = card.querySelector('.fav-time-slot[data-slot="night"]');
        if (dayBtn) dayBtn.classList.toggle('active-day', dayKeys.includes(key));
        if (nightBtn) nightBtn.classList.toggle('active-night', nightKeys.includes(key));
    }
    applyWallpaperFilters();
    updateDayNightUiAvailability();
}

// Inline confirm — instead of opening a fullscreen modal that pulls the user
// out of context, transform the .fav-card itself: a red-tinted overlay with
// blur drops over the card's existing content (thumbnail stays visible behind
// the blur, so the user keeps a visual anchor on what they're deleting), with
// "Delete this wallpaper? Cannot be undone." + Cancel / Delete buttons sitting
// on top. The Promise resolves to true/false the same way the modal flow did,
// so the caller doesn't need to know the UI changed.
function confirmWallpaperDelete({ card, title = t('wallpapers_confirm_delete_title'), subtitle = t('wallpapers_confirm_delete_subtitle') } = {}) {
    if (!card) {
        return Promise.resolve(window.confirm(t('wallpapers_confirm_delete_fallback')));
    }

    // Auto-cancel any OTHER card already in confirm state — only one inline
    // confirm visible at a time avoids the awkward "I clicked × on three
    // cards, which one am I confirming?" state.
    document.querySelectorAll('.fav-card.confirm-delete').forEach((other) => {
        if (other !== card && typeof other._wfConfirmClose === 'function') {
            other._wfConfirmClose(false);
        }
    });

    return new Promise((resolve) => {
        let overlay = card.querySelector(':scope > .fav-card-confirm-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'fav-card-confirm-overlay';
            // "Delete this?" instead of "Delete this wallpaper?" — the card
            // is the wallpaper, so the noun is implied. Shorter title fits
            // the ~298 px usable width comfortably alongside the subtitle
            // and both action buttons, no ellipsis.
            overlay.innerHTML =
                '<div class="fav-card-confirm-text">'
                + '<span class="fav-card-confirm-title"></span>'
                + '<span class="fav-card-confirm-subtitle"></span>'
                + '</div>'
                + '<div class="fav-card-confirm-actions">'
                + '<button type="button" class="fav-card-confirm-btn cancel"></button>'
                + '<button type="button" class="fav-card-confirm-btn delete"></button>'
                + '</div>';
            overlay.querySelector('.fav-card-confirm-btn.cancel').textContent = t('common_cancel');
            overlay.querySelector('.fav-card-confirm-btn.delete').textContent = t('common_delete');
            card.appendChild(overlay);
        }

        // Set as text, not markup — copy varies per card type (the bundled
        // wallpaper is hidden rather than destroyed, so "Cannot be undone."
        // would be a lie there).
        overlay.querySelector('.fav-card-confirm-title').textContent = title;
        overlay.querySelector('.fav-card-confirm-subtitle').textContent = subtitle;

        const cancelBtn = overlay.querySelector('.fav-card-confirm-btn.cancel');
        const deleteBtn = overlay.querySelector('.fav-card-confirm-btn.delete');

        const close = (result) => {
            card.classList.remove('confirm-delete');
            cancelBtn.removeEventListener('click', onCancel);
            deleteBtn.removeEventListener('click', onConfirm);
            overlay.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onKeyDown);
            delete card._wfConfirmClose;
            resolve(result);
        };

        const onCancel = (e) => { e.stopPropagation(); close(false); };
        const onConfirm = (e) => { e.stopPropagation(); close(true); };
        // Trap clicks on the overlay so the underlying card buttons (set/pin/
        // day/night) don't fire while the confirm is open.
        const onOverlayClick = (e) => { e.stopPropagation(); };
        const onKeyDown = (e) => { if (e.key === 'Escape') close(false); };

        card._wfConfirmClose = close;
        cancelBtn.addEventListener('click', onCancel);
        deleteBtn.addEventListener('click', onConfirm);
        overlay.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onKeyDown);

        // rAF defer so the CSS transition triggers cleanly when the class
        // first lands.
        requestAnimationFrame(() => card.classList.add('confirm-delete'));
    });
}

// rotationMode + rotationIndex were leftovers from a removed "sequence" rotation
// mode — no code path in the current build ever wrote rotationMode, so the
// 'sequence' branch in updateVideo() was unreachable. Read only the live key.
// (setRotationIndex helper removed — only consumer was the dead sequence branch.)
function getRotationData() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['rotationKeys'], resolve);
    });
}

// ==============================
// WALLPAPER RUNTIME — background playback, media selection
// ==============================

let _currentBlobURL = null;
let _isUpdatingVideo = false;
// A render asked for while one is running is not dropped: it runs once the
// current one ends. Any full render outranks a SET_BUTTON-only one. A rotation
// tick is the exception: the render in progress re-arms the timer itself, so
// a queued tick would only swap twice.
let _queuedRender = null;
// Renders that leave the side panel's card list alone.
const LIGHT_RENDER = new Set(['SET_BUTTON', 'ROTATION']);

// Rotation state. The deck is the shuffled order over the current list; the
// showing key drives the "Showing" badge and the "don't repeat" rule.
let _wfDeck = null;
let _wfShowingKey = null;
// Show this wallpaper on the next render without pinning it. An upload uses it
// so a new file appears at once while the rotation carries on; cleared as soon
// as it is used, so the deck decides every render after that.
let _wfForceNextKey = null;
let _wfPoolSize = 0;
let _wfPinned = false;
// Whether the wallpaper on screen is one the rotation can reach again. False
// only for a fresh upload the user has not added to a curated list.
let _wfPoolHasShowing = true;
let _rotationTimer = null;
let _rotationDueAt = 0;
let _boundaryTimer = null;
let _boundaryDueAt = 0;

// The guard used to be released only by the `finally` around the DOM-render
// step, which sat well below the first `await getAllKeys()`. So a rejected
// IndexedDB open — exactly what happens when storage is under pressure, the
// very condition this release is about — left `_isUpdatingVideo` latched true
// for the life of the page: every later call returned at the guard and the
// wallpaper never loaded again, silently, with no error surfaced anywhere.
// The wrapper now owns the guard, so no failure path can skip releasing it.
async function updateVideo(calledFrom) {
    if (_isUpdatingVideo) {
        if (calledFrom === 'ROTATION') return;
        _queuedRender = (calledFrom === 'SET_BUTTON' && _queuedRender === null) ? 'SET_BUTTON' : 'queued';
        return;
    }
    _isUpdatingVideo = true;
    try {
        await renderWallpaper(calledFrom);
    } catch (err) {
        console.warn('[wallsflow] wallpaper render failed', err);
        paintFallbackWallpaper();
    } finally {
        _isUpdatingVideo = false;
    }
    if (_queuedRender !== null) {
        const next = _queuedRender === 'SET_BUTTON' ? 'SET_BUTTON' : undefined;
        _queuedRender = null;
        await updateVideo(next);
    }
}

// Last resort when the database is unreachable: the bundled default needs no
// IndexedDB, so there is no excuse for leaving the page with a blank backdrop.
function paintFallbackWallpaper() {
    try {
        if (document.getElementById('mainVideo')) return;
        const container = document.getElementById('background');
        if (!container) return;
        const elem = document.createElement('video');
        elem.setAttribute('id', 'mainVideo');
        elem.src = '../videos/default.mp4';
        container.prepend(elem);
        playVideo(elem);
    } catch (_) { /* nothing further we can do */ }
}

async function renderWallpaper(calledFrom) {
    // Whatever was due is void: this render decides the next due time. Without
    // this, a tick armed before a pin would fire and re-randomise the pinned
    // wallpaper.
    cancelWallpaperTimers();
    await loadRotationDurations();
    const allKeys = await getAllKeys();
    const keys = allKeys;
    let mediaRecord;
    let mediaURL;
    let mediaType = 'video';
    const previousShowingKey = _wfShowingKey;
    let shownKey = null;
    _wfPinned = false;
    _wfPoolSize = 0;
    _wfPoolHasShowing = true;

    if (keys[0] === undefined) {
        mediaURL = '../videos/default.mp4';
        shownKey = 'default';
        // Store opened cleanly and came back empty. Fire and forget: this only
        // reports and tidies up, and the wallpaper must paint either way.
        reportEvictedWallpapers();
    } else {
        const modeSettings = await getWallpaperModeSettings();
        const activeObj = await new Promise((resolve) =>
            chrome.storage.local.get(['activeVideoKey'], resolve)
        );
        const activeKey = normalizeMediaKeyForList(
            activeObj?.activeVideoKey ?? null,
            keys
        );

        if (activeKey !== null) {
            _wfPinned = true;
            shownKey = String(activeKey);
            if (activeKey === 'default') {
                mediaURL = '../videos/default.mp4';
                mediaType = 'video';
            } else {
                mediaRecord = await getVideoBlob(Number(activeKey) || activeKey);
            }
        } else {
            // Keys that no longer exist in the store are dropped before the
            // list is built, so a stale reference can never be picked.
            const live = (list) => [...new Set(
                (Array.isArray(list) ? list : [])
                    .map((k) => normalizeMediaKeyForList(k, keys))
                    .filter((k) => k !== null)
                    .map(String)
            )];
            const rot = await getRotationData();
            // When the user hid the default it must stay out of the implicit
            // fallback pool too, otherwise rotation would keep serving a
            // wallpaper they removed from the list.
            const defaultHiddenForPool = await isDefaultWallpaperHidden(keys.length);
            const pool = buildCandidatePool({
                keys,
                dayNightEnabled: isDayNightWidgetEnabled(),
                isDay: isDayPeriod(),
                dayKeys: live(modeSettings.dayWallpaperKeys),
                nightKeys: live(modeSettings.nightWallpaperKeys),
                rotationKeys: live(rot.rotationKeys),
                defaultHidden: defaultHiddenForPool,
            });
            _wfPoolSize = pool.length;

            // A wallpaper just uploaded skips the queue once, so the upload is
            // visible immediately. The deck is left untouched, so the rotation
            // resumes exactly where it was.
            const forced = normalizeMediaKeyForList(_wfForceNextKey, keys);
            _wfForceNextKey = null;

            let chosenKey;
            if (forced !== null) {
                chosenKey = forced;
            } else {
                // Every wallpaper once before any repeats, never the same one
                // twice in a row, and a fresh tab starts away from what the
                // previous tab was showing.
                const avoid = _wfShowingKey ?? safeGet(STORAGE_KEYS.WALLPAPER_LAST_KEY);
                const picked = pickFromDeck(_wfDeck, pool, avoid);
                _wfDeck = picked.deck;
                chosenKey = picked.key;
            }
            shownKey = chosenKey;
            _wfPoolHasShowing = chosenKey !== null && pool.includes(String(chosenKey));

            if (chosenKey === 'default') {
                mediaURL = '../videos/default.mp4';
                mediaType = 'video';
            } else if (chosenKey !== null) {
                mediaRecord = await getVideoBlob(Number(chosenKey) || chosenKey);
            }
        }
    }

    _wfShowingKey = shownKey === null ? null : String(shownKey);
    if (_wfShowingKey !== null) safeSet(STORAGE_KEYS.WALLPAPER_LAST_KEY, _wfShowingKey);

    // The previous object URL stays alive until the element using it is gone:
    // during a crossfade that is a second later, not now.
    const previousBlobURL = _currentBlobURL;
    _currentBlobURL = null;
    if (mediaRecord) {
        if (Array.isArray(mediaRecord)) {
            mediaURL = URL.createObjectURL(mediaRecord[0]);
            mediaType = 'video';
        } else if (mediaRecord?.blob) {
            mediaURL = URL.createObjectURL(mediaRecord.blob);
            mediaType = mediaRecord.type || (mediaRecord.mime?.startsWith('image') ? 'image' : 'video');
        }
        _currentBlobURL = mediaURL;
    }

    if (!mediaURL) {
        mediaURL = '../videos/default.mp4';
        mediaType = 'video';
    }

    // The 'deleteVideoBlob' and 'getVideo' calledFrom branches used to live
    // here; they were unreachable (no caller ever passed 'deleteVideoBlob',
    // and the 'getVideo' arm did identical work to the default arm).
    if (!LIGHT_RENDER.has(calledFrom)) {
        updateSettings(keys, 'all');
    } else {
        syncShowingBadge(previousShowingKey);
    }

    if (mediaURL !== 'null') {
        await mountWallpaper({ mediaURL, mediaType, previousBlobURL });
    }

    scheduleWallpaperRotation();
    scheduleDayNightBoundary();
}

function buildWallpaperElement(mediaURL, mediaType) {
    let elem;
    if (mediaType === 'image') {
        elem = document.createElement('img');
        elem.src = mediaURL;
        elem.style.objectFit = 'cover';
        elem.style.width = '100%';
        elem.style.height = '100%';
        elem.style.position = 'absolute';
        elem.style.top = '0';
        elem.style.left = '0';
    } else {
        elem = document.createElement('video');
        elem.src = mediaURL;
    }
    return elem;
}

// Resolves true once the element has something to show (a decoded image, the
// first frame of a video), false on a load error. A cap keeps a very large
// file from holding two wallpapers in memory indefinitely; past it the swap
// goes ahead and is logged.
function waitForWallpaperReady(elem, mediaType, capMs = 2500) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            resolve(ok);
        };
        const cap = setTimeout(() => {
            console.warn('[wallsflow] wallpaper not ready within the cap; showing it anyway');
            settle(true);
        }, capMs);
        elem.addEventListener('error', () => settle(false), { once: true });
        if (mediaType === 'image') {
            if (typeof elem.decode === 'function') {
                // A rejected decode is either a broken file (the error event
                // settles it) or a file too large for the decode cache (the
                // cap settles it); neither is a reason to give up here.
                elem.decode().then(() => settle(true), () => {});
            } else {
                elem.addEventListener('load', () => settle(true), { once: true });
            }
        } else if (elem.readyState >= 2) {
            settle(true);
        } else {
            // loadeddata, not playing: with Animations off the video never
            // plays, but its first frame still arrives.
            elem.addEventListener('loadeddata', () => settle(true), { once: true });
        }
    });
}

// Puts the new wallpaper on screen. On a fresh page it fades in from the page
// background as it always has. When one is already showing, the new one is
// mounted behind it, waits until it has decoded, and only then does the old
// one fade out on top: the page never dips to black between two wallpapers.
async function mountWallpaper({ mediaURL, mediaType, previousBlobURL }) {
    const container = document.getElementById('background');
    if (!container) return false;
    const releasePrevious = () => {
        if (previousBlobURL) {
            try { URL.revokeObjectURL(previousBlobURL); } catch (_) {}
        }
    };
    const oldElem = document.getElementById('mainVideo');
    const elem = buildWallpaperElement(mediaURL, mediaType);

    if (!oldElem) {
        elem.setAttribute('id', 'mainVideo');
        if (mediaType === 'image') {
            elem.style.opacity = '0';
            /* Only opacity fades in here; the filter is owned by the CSS rule
               on .bg img / .bg video that reads the user's blur and
               brightness. */
            elem.style.transition = 'opacity 1s ease';
            setTimeout(() => { elem.style.opacity = '1'; }, 50);
        }
        container.prepend(elem);
        if (mediaType === 'video') {
            playVideo(elem);
            checkAndApplyVideoPlaybackState(elem);
        }
        releasePrevious();
        return true;
    }

    // Behind the current one, fully opaque, without the id: #mainVideo stays
    // unambiguous, and a file that fails to load leaves the page untouched.
    elem.classList.add('wf-incoming');
    elem.style.opacity = '1';
    container.prepend(elem);
    if (mediaType === 'video') {
        playVideo(elem);
        checkAndApplyVideoPlaybackState(elem);
    }

    const ready = await waitForWallpaperReady(elem, mediaType);
    if (!ready) {
        try { elem.remove(); } catch (_) {}
        if (typeof mediaURL === 'string' && mediaURL.startsWith('blob:')) {
            try { URL.revokeObjectURL(mediaURL); } catch (_) {}
        }
        _currentBlobURL = previousBlobURL;
        console.warn('[wallsflow] incoming wallpaper failed to load; keeping the current one');
        return false;
    }

    elem.classList.remove('wf-incoming');
    elem.setAttribute('id', 'mainVideo');
    oldElem.setAttribute('id', 'removing');
    // Commit the id change before the opacity change, so the fade runs on
    // #removing's transition rather than snapping.
    void oldElem.offsetWidth;
    oldElem.style.opacity = '0';

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        if (oldElem.tagName === 'VIDEO') {
            try { oldElem.pause(); } catch (_) {}
        }
        try { oldElem.remove(); } catch (_) {}
        releasePrevious();
    };
    oldElem.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'opacity') finish();
    });
    setTimeout(finish, 1600);
    return true;
}

// Repaints only the two cards whose "on screen" ring changed.
function syncShowingBadge(previousKey) {
    const list = document.getElementById('wallpapers-list');
    if (!list) return;
    for (const key of new Set([previousKey, _wfShowingKey].filter((k) => k !== null && k !== undefined))) {
        const card = list.querySelector(`.fav-card[data-key="${String(key)}"]`);
        if (card) updateWallpaperCardBadges(card);
    }
}

// ==============================
// ROTATION TIMERS
// ==============================
// Two one-shot timers, re-armed after every render: the interval the user
// chose, and the next Day/Night boundary. Both are cleared while the tab is
// hidden and settled on return, so nothing swaps in a tab nobody is looking at
// and a wallpaper that fell due while hidden changes the moment it is seen.
function cancelWallpaperTimers() {
    if (_rotationTimer) { clearTimeout(_rotationTimer); _rotationTimer = null; }
    if (_boundaryTimer) { clearTimeout(_boundaryTimer); _boundaryTimer = null; }
    _rotationDueAt = 0;
    _boundaryDueAt = 0;
}

function scheduleWallpaperRotation() {
    if (_rotationTimer) { clearTimeout(_rotationTimer); _rotationTimer = null; }
    _rotationDueAt = 0;
    const minutes = currentRotateMinutes();
    if (minutes <= 0 || _wfPinned || _wfPoolSize < 2 || _wfShowingKey === null) return;
    const ms = effectiveRotationMinutes(_wfShowingKey, minutes, _rotationDurationsCache) * 60 * 1000;
    if (ms <= 0) return;
    _rotationDueAt = Date.now() + ms;
    _rotationTimer = setTimeout(rotateWallpaper, ms);
}

function rotateWallpaper() {
    _rotationTimer = null;
    // Not while hidden: the visibility handler swaps on return instead.
    if (document.hidden) return;
    updateVideo('ROTATION');
}

function scheduleDayNightBoundary() {
    if (_boundaryTimer) { clearTimeout(_boundaryTimer); _boundaryTimer = null; }
    _boundaryDueAt = 0;
    if (!isDayNightWidgetEnabled() || _wfPinned) return;
    const ms = msUntilNextDayNightBoundary();
    _boundaryDueAt = Date.now() + ms;
    _boundaryTimer = setTimeout(dayNightBoundaryTick, ms);
}

function dayNightBoundaryTick() {
    _boundaryTimer = null;
    if (document.hidden) return;
    updateVideo('ROTATION');
}

function handleWallpaperTimersVisibility(hidden) {
    if (hidden) {
        if (_rotationTimer) { clearTimeout(_rotationTimer); _rotationTimer = null; }
        if (_boundaryTimer) { clearTimeout(_boundaryTimer); _boundaryTimer = null; }
        return;
    }
    const now = Date.now();
    const rotationDue = _rotationDueAt > 0 && _rotationDueAt <= now;
    const boundaryDue = _boundaryDueAt > 0 && _boundaryDueAt <= now;
    if (rotationDue || boundaryDue) {
        // One render covers both; it re-arms whatever still applies.
        updateVideo('ROTATION');
        return;
    }
    if (_rotationDueAt > 0 && !_rotationTimer) {
        _rotationTimer = setTimeout(rotateWallpaper, remainingMs(_rotationDueAt, now));
    }
    if (_boundaryDueAt > 0 && !_boundaryTimer) {
        _boundaryTimer = setTimeout(dayNightBoundaryTick, remainingMs(_boundaryDueAt, now));
    }
}

if (typeof window !== 'undefined' && typeof window.wfOnVisibilityChange === 'function') {
    window.wfOnVisibilityChange(handleWallpaperTimersVisibility);
}

async function setActiveVideoKey(key) {
    await chrome.storage.local.set({ activeVideoKey: key });
}

async function getActiveVideoKey() {
    const res = await chrome.storage.local.get(['activeVideoKey']);
    return res?.activeVideoKey ?? null;
}

async function getWallpaperModeSettings() {
    const res = await chrome.storage.local.get(
        ['dayWallpaperKeys', 'nightWallpaperKeys', 'dayPrimaryKey', 'nightPrimaryKey']
    );
    const dayLegacy = res?.dayPrimaryKey ? [String(res.dayPrimaryKey)] : [];
    const nightLegacy = res?.nightPrimaryKey ? [String(res.nightPrimaryKey)] : [];
    const dayWallpaperKeys = Array.isArray(res?.dayWallpaperKeys)
        ? res.dayWallpaperKeys.map(String)
        : dayLegacy;
    const nightWallpaperKeys = Array.isArray(res?.nightWallpaperKeys)
        ? res.nightWallpaperKeys.map(String)
        : nightLegacy;
    return { dayWallpaperKeys, nightWallpaperKeys };
}

function isDayPeriod() {
    const h = new Date().getHours();
    return h >= 7 && h < 19;
}

function normalizeMediaKeyForList(rawKey, availableKeys) {
    if (rawKey === null || rawKey === undefined) return null;
    if (rawKey === 'default') return 'default';
    const maybeNum = Number(rawKey);
    if (Number.isFinite(maybeNum) && availableKeys.includes(maybeNum)) return maybeNum;
    if (availableKeys.includes(rawKey)) return rawKey;
    return null;
}

async function getCurrentPrimaryKeyForUI(availableKeys) {
    const activeKey = await getActiveVideoKey();
    return normalizeMediaKeyForList(activeKey, availableKeys);
}

function playVideo(video_elem) {
    video_elem.muted = true;
    video_elem.setAttribute('autoplay', 'autoplay');
    video_elem.setAttribute('preload', 'auto');
    video_elem.setAttribute('loop', 'loop');

    video_elem.play().catch(() => {});

    setTimeout(function () {
        /* style.filter = 'blur(0px)' lived here too — same reason as in
           updateVideo()'s image branch: an inline filter beat the
           user's --wf-bg-blur / --wf-bg-brightness driven CSS rule, so
           the Background sliders had zero visible effect. Only opacity
           is touched here now. */
        video_elem.style.opacity = '1';
    }, 50);
}

function pauseVideo(video_elem) {
    video_elem?.pause();
}

function resumeVideo(video_elem) {
    video_elem?.play();
}

function handleVideoPlaybackToggle(isEnabled, showNotification = true) {
    safeSet('videoPlaybackEnabled', isEnabled.toString());

    const backgroundDiv = document.getElementById('background');
    if (!backgroundDiv) return;

    const videoElement = backgroundDiv.querySelector('video');
    if (!videoElement) {
        // Active wallpaper is a static image — there is nothing to animate.
        // Tell the user explicitly instead of failing silently; the preference
        // is already persisted and will take effect when a live wallpaper is
        // selected next.
        if (showNotification) {
            const isStatic = !!backgroundDiv.querySelector('img#mainVideo');
            if (isStatic) {
                showPush(t('widget_video_playback_toast_static'), 'warning');
            }
        }
        return;
    }

    if (isEnabled) {
        resumeVideo(videoElement);
        if (showNotification) {
            showPush(t('widget_video_playback_toast_enabled'), 'success');
        }
    } else {
        pauseVideo(videoElement);
        if (showNotification) {
            showPush(t('widget_video_playback_toast_disabled'), 'disabled');
        }
    }
}

function initVideoPlaybackState() {
    const videoEnabled = safeGet('videoPlaybackEnabled');
    const isEnabled = videoEnabled === null ? true : videoEnabled === 'true';

    // Apply the persisted preference as soon as the wallpaper element lands
    // in #background, not after a fixed magic sleep. The previous version
    // waited a full second, which meant a user who had set Animations OFF
    // saw the wallpaper animate visibly for ~1s on every new-tab open
    // before it finally paused. Same rAF + retry pattern as the pin-action
    // flow in ingestFiles(): up to ~30 frames (≈500ms) — if no wallpaper
    // shows up by then, we'd be in a broken state anyway.
    const tryApply = (attemptsLeft) => {
        const bg = document.getElementById('background');
        if (bg && bg.firstElementChild) {
            handleVideoPlaybackToggle(isEnabled, false);
            return;
        }
        if (attemptsLeft > 0) {
            requestAnimationFrame(() => tryApply(attemptsLeft - 1));
        }
    };
    requestAnimationFrame(() => tryApply(30));
}

function checkAndApplyVideoPlaybackState(videoElement) {
    const videoEnabled = safeGet('videoPlaybackEnabled');
    const isEnabled = videoEnabled === null ? true : videoEnabled === 'true';

    if (!isEnabled && videoElement) {
        setTimeout(() => {
            pauseVideo(videoElement);
        }, 100);
    }
}

// Pause the wallpaper video while the new-tab page is in a hidden tab
// (alt-tab, minimize, switching to another tab). Chrome may throttle
// hidden tabs but does not fully stop a `<video>` element's decode
// pipeline, so we explicitly pause and resume to drop GPU/CPU usage to
// zero whenever the user can't see the page anyway. Resume is gated by
// the user's "Animations" toggle so a wallpaper that was deliberately
// frozen stays frozen when the tab becomes visible again.
//
// `wasPlayingBeforeHide` ensures we only resume what we actually paused
// here — if the video was already paused (Animations off, or never
// started), we leave it alone on resume.
let _wfWallpaperWasPlayingBeforeHide = false;
function _wfFindWallpaperVideo() {
    const bg = document.getElementById('background');
    if (!bg) return null;
    const v = bg.querySelector('video');
    return (v && typeof v.pause === 'function') ? v : null;
}

if (typeof window !== 'undefined' && typeof window.wfOnVisibilityChange === 'function') {
    window.wfOnVisibilityChange((hidden) => {
        const video = _wfFindWallpaperVideo();
        if (!video) return;
        if (hidden) {
            _wfWallpaperWasPlayingBeforeHide = !video.paused;
            if (_wfWallpaperWasPlayingBeforeHide) {
                try { video.pause(); } catch (_) {}
            }
        } else {
            if (!_wfWallpaperWasPlayingBeforeHide) return;
            _wfWallpaperWasPlayingBeforeHide = false;
            // Re-check the user preference at resume time — it may have
            // been toggled off in another tab while this one was hidden.
            const stored = safeGet('videoPlaybackEnabled');
            const animationsEnabled = stored === null ? true : stored === 'true';
            if (animationsEnabled) {
                try { video.play().catch(() => {}); } catch (_) {}
            }
        }
    });
}
