// ==============================
// NEWTAB UTILITIES — search
// ==============================
// (faviconURL + getFormattedName lived here — both were exported but had
// zero callers across the codebase. Favicon resolution is now done inside
// utils.js's bookmark/shortcut renderers; the hostname formatter was a leftover
// from an earlier shortcut-naming auto-suggest feature that no longer ships.)

const search_input = document.getElementById('searchInput');
const search_trigger = document.getElementById('searchTrigger');

// ==============================
// SEARCH BAR — open mode (New tab / Same tab)
// ==============================
// Storage keys SEARCH_OPEN_MODE_KEY / SEARCH_OPEN_MODE_MUSIC_KEY are declared
// once in widgets.js (loaded earlier). Top-level scripts share lexical scope.
// resolveOpenMode lives in notifications.js — also loaded earlier.

function getSearchOpenDisposition() {
    return resolveOpenMode(SEARCH_OPEN_MODE_KEY, SEARCH_OPEN_MODE_MUSIC_KEY) === '_self'
        ? 'CURRENT_TAB' : 'NEW_TAB';
}

function runSearch(query) {
    const text = String(query || '').trim();
    if (!text) return false;
    try {
        chrome.search.query({ text, disposition: getSearchOpenDisposition() }, () => {});
    } catch (_) {
        // Fallback if chrome.search is unavailable — open Google directly.
        const url = 'https://www.google.com/search?q=' + encodeURIComponent(text);
        if (getSearchOpenDisposition() === 'CURRENT_TAB') window.location.assign(url);
        else window.open(url, '_blank');
    }
    return true;
}

// Cache the original placeholder so the empty-submit hint reverts to the
// configured value. The previous code reverted to a hard-coded "Search",
// so the first empty submit permanently changed the placeholder from the
// real "Search the Web" string to a wrong literal that never bounced
// back. Also: store the timer so consecutive empty submits don't stack
// independent reverts.
const SEARCH_DEFAULT_PLACEHOLDER =
    (search_input && search_input.getAttribute('placeholder')) || t('search_search_the_web_placeholder');
let _searchEmptyHintTimer = null;

function showSearchEmptyHint() {
    if (!search_input) return;
    search_input.setAttribute('placeholder', t('search_empty_hint_placeholder'));
    if (_searchEmptyHintTimer) clearTimeout(_searchEmptyHintTimer);
    _searchEmptyHintTimer = setTimeout(() => {
        search_input.setAttribute('placeholder', SEARCH_DEFAULT_PLACEHOLDER);
        _searchEmptyHintTimer = null;
    }, 2000);
}

if (search_trigger && search_input) {
    search_trigger.addEventListener('click', function() {
        if (!runSearch(search_input.value)) showSearchEmptyHint();
    });

    // Lupa carries role="button" + tabindex="0" + aria-label="Search" in
    // markup so it joins the tab order and is announced as a button by
    // screen readers. Keyboard activation (Enter / Space) mirrors native
    // <button> semantics — without it, the lupa was visually clickable
    // but unreachable except via mouse.
    search_trigger.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        search_trigger.click();
    });

    search_input.addEventListener('keyup', function(event) {
        if (event.key === 'Enter') search_trigger.click();
    });
}

// ==============================
// REVIEW SYSTEM
// ==============================

function initReviewSystem() {
    const reviewBackdrop = document.getElementById('review-modal-backdrop');
    const reviewCloseBtn = document.getElementById('review-modal-close');
    const reviewLeaveBtn = document.getElementById('review-btn-leave');
    const reviewLaterBtn = document.getElementById('review-btn-later');
    const reviewStars = document.querySelectorAll('.review-star-btn');

    if (!reviewBackdrop) return;

    // The only permanent stop: they went to the store page, via the button or a
    // star. Both "Maybe Later" and the × only ever postpone.
    if (safeGet('reviewSubmitted') === 'true') {
        return;
    }

    const dayMs = 1000 * 60 * 60 * 24;
    const firstTabOpenTime = parseInt(safeGet('firstTabOpenTime') || Date.now(), 10);
    const daysSinceFirstOpen = (Date.now() - firstTabOpenTime) / dayMs;
    const nextPromptDay = parseInt(safeGet('reviewNextPromptDay') || '3', 10);

    if (daysSinceFirstOpen >= nextPromptDay) {
        setTimeout(() => {
            showReviewModal();
        }, 2000);
    }

    function showReviewModal() {
        reviewBackdrop.classList.add('show');
    }

    function closeReviewModal() {
        reviewBackdrop.classList.remove('show');
    }

    function scheduleNextPrompt() {
        const currentDays = Math.floor((Date.now() - firstTabOpenTime) / dayMs);
        let nextDay;

        if (currentDays < 7) {
            nextDay = 7;
        } else if (currentDays < 14) {
            nextDay = 14;
        } else {
            nextDay = currentDays + 14;
        }

        safeSet('reviewNextPromptDay', nextDay.toString());
        // (reviewLaterTimestamp was written here and read nowhere — the next
        //  prompt is derived entirely from reviewNextPromptDay above.)
    }

    if (reviewCloseBtn) {
        reviewCloseBtn.addEventListener('click', () => {
            closeReviewModal();
            scheduleNextPrompt();
        });
    }

    function openReviewPage() {
        const extensionId = chrome.runtime.id;
        const ua = navigator.userAgent || '';
        const isFirefox = /firefox/i.test(ua);
        // Checked after Firefox: Edge's user agent also says Chrome.
        const isEdge = !isFirefox && ua.indexOf('Edg') !== -1;
        // chromewebstore.google.com is the current host; the old
        // chrome.google.com/webstore path still 301s here, but going direct
        // saves a redirect and survives the legacy redirect eventually going away.
        // Edge accepts the id on its own and fills in the name slug itself.
        // Chrome and Edge address a listing by the runtime id, which differs
        // per store and is read at run time. AMO uses a slug, fixed here.
        let reviewUrl;
        if (isFirefox) {
            reviewUrl = 'https://addons.mozilla.org/firefox/addon/wallsflow-new-tab/reviews/';
        } else if (isEdge) {
            reviewUrl = `https://microsoftedge.microsoft.com/addons/detail/${extensionId}`;
        } else {
            reviewUrl = `https://chromewebstore.google.com/detail/${extensionId}/reviews`;
        }

        window.open(reviewUrl, '_blank');
        closeReviewModal();
        safeSet('reviewSubmitted', 'true');
        showPush(t('review_toast_thanks'), 'default');
    }

    if (reviewLeaveBtn) {
        reviewLeaveBtn.addEventListener('click', openReviewPage);
    }

    if (reviewStars && reviewStars.length) {
        reviewStars.forEach((starBtn) => {
            starBtn.addEventListener('click', openReviewPage);
        });
    }

    if (reviewLaterBtn) {
        reviewLaterBtn.addEventListener('click', () => {
            closeReviewModal();
            scheduleNextPrompt();
        });
    }

    reviewBackdrop.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (!safeGet('firstTabOpenTime')) {
        safeSet('firstTabOpenTime', Date.now().toString());
    }

    initReviewSystem();

    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            chrome.tabs.create({
                // utm_source is deliberately browser-agnostic: the same build
                // ships to Chrome, Edge and Firefox, so "chrome_extension"
                // would have mislabelled two thirds of the traffic.
                url: 'https://wallsflow.com/?utm_source=wallsflow_extension&utm_medium=referral&utm_campaign=newtab&utm_content=download_more'
            });
        });
    }

    const brandVersion = document.getElementById('menu-brand-version');
    const manifestData = chrome.runtime.getManifest();
    if (brandVersion) brandVersion.textContent = `v${manifestData.version}`;
});

// ==============================
// NEWTAB MANAGER — side panel, wallpaper upload, visibility
// ==============================

function createManager() {
    // (Two capture-phase handlers used to live here — they intercepted
    //  <a> clicks and mouseovers inside #shortcuts-container. Shortcut tiles
    //  are <div role="button"> nodes (see utils.js renderShortcuts), not <a>,
    //  so the link.closest('a') filter never matched. Both were dead.)

    const videoFile = document.getElementById('add_video_file');
    const openClose = document.getElementById('open_close');
    const gear = document.getElementById('gear');
    const sideNav = document.getElementById('mySidenav');
    const overlay = document.getElementById('side-blur-overlay');

    if (videoFile) videoFile.addEventListener('click', () => getVideo('file'));

    let outsideHandler = null;

    function openSide() {
            if (sideNav.getAttribute('status') === 'open') return;
            sideNav.classList.remove('closing');
            sideNav.classList.add('opening');
            // RAF defers the .open class one frame so the .opening transition
            // gets a chance to register starting state — without this, the
            // panel snaps open without animating.
            requestAnimationFrame(() => sideNav.classList.add('open'));
           openClose.classList.add('active');
           gear.classList.add('panel-open');
            sideNav.setAttribute('status', 'open');
            if (overlay) overlay.classList.add('show');
            document.body.classList.add('menu-open');

            // (Earlier versions auto-paused #mainVideo here as a GPU-saving
            //  optimization while the menu was open. That was rolled back —
            //  the live wallpaper now keeps animating with the menu open and
            //  only stops when the user explicitly disables the "Animations"
            //  widget in Widgets. The auto-pause was confusing because users
            //  expect the wallpaper to behave consistently regardless of
            //  whether the side menu is visible.)
        outsideHandler = function (ev) {
            // (Old #confirm-backdrop fullscreen modal check lived here — that
            // modal was retired in favor of an inline confirm overlay drawn
            // on the .fav-card itself. The inline overlay is inside sideNav
            // already, so the sideNav.contains() check below covers it.)
            if (sideNav.contains(ev.target) || openClose.contains(ev.target)) return;
            closeSide();
        };
        document.addEventListener('pointerdown', outsideHandler, { capture: true });
    }

    function closeSide() {
            if (sideNav.getAttribute('status') === 'closed') return;
            gear.classList.remove('panel-open');
            sideNav.setAttribute('status', 'closed');
            sideNav.classList.remove('opening','open');
            sideNav.classList.add('closing');
            const cleanup = () => {
                sideNav.classList.remove('closing');
                sideNav.removeEventListener('transitionend', cleanup);
            };
            sideNav.addEventListener('transitionend', cleanup);
            openClose.classList.remove('active');
            if (overlay) overlay.classList.remove('show');
            document.body.classList.remove('menu-open');

            // (Resume-on-close removed in tandem with the pause-on-open
            //  rollback in openSide(). Nothing to resume here anymore — the
            //  wallpaper's playback state is only changed by the explicit
            //  "Animations" toggle in Widgets and by initVideoPlaybackState
            //  on page load.)
        if (outsideHandler) {
            document.removeEventListener('pointerdown', outsideHandler, { capture: true });
            outsideHandler = null;
        }
    }

    openClose.addEventListener('click', (e) => {
        e.stopPropagation();
        const status = sideNav.getAttribute('status');
        if (status === 'closed') openSide();
        else closeSide();
    });

    if (overlay) overlay.addEventListener('click', (e) => { e.stopPropagation(); closeSide(); });

    // (~85 lines of widget-visibility popup wiring lived here — bound to
    // #visibility-settings-btn + #visibility-popup, neither of which exists
    // in newtabpage.html anymore. The widget-visibility UI was migrated to
    // the side menu's "Widgets" management section in widgets.js, which uses
    // the same storage keys (searchHidden/shortcutsHidden/musicHidden/etc.)
    // so user preferences carry over without a migration step.)
}

updateVideo();
createManager();
