(function() {
    'use strict';

    // ==============================
    // POMODORO TIMER WIDGET
    // ==============================

    const POMO_STATE_KEY = STORAGE_KEYS.POMO_STATE;
    const POMO_COMPLETED_AT_KEY = STORAGE_KEYS.POMO_COMPLETED_AT;
    const POMO_SESSIONS_KEY = STORAGE_KEYS.POMO_SESSIONS;
    const POMO_SESSIONS_DATE_KEY = STORAGE_KEYS.POMO_SESSIONS_DATE;
    // SVG progress ring stroke length: 2*PI*r where r=54px in the timer SVG.
    const CIRCUMFERENCE = 2 * Math.PI * 54;

    const POMO_SETTINGS_MAP = {
        focusDuration: { key: 'wf_pomo_focus_min', fallback: '25' },
        shortBreak:    { key: 'wf_pomo_short_min', fallback: '5' },
        longBreak:     { key: 'wf_pomo_long_min',  fallback: '15' },
        autoStart:     { key: 'wf_pomo_auto_start', fallback: 'false' },
        focusMode:     { key: 'wf_pomo_focus_mode', fallback: 'true' },
        // Whether the task list opens beside the timer in focus mode, and
        // the timer asks about the current task when a session ends.
        focusTasks:    { key: 'wf_pomo_focus_tasks', fallback: 'true' }
    };

    // One place names every phase: the label under the time, the browser tab
    // title and the notification when a phase ends. Read at call time, so all
    // three follow the page language.
    function phaseText(phase) {
        if (phase === 'short') return { label: t('pomo_phase_short'), title: t('pomo_title_short'), done: t('pomo_toast_short_done') };
        if (phase === 'long') return { label: t('pomo_phase_long'), title: t('pomo_title_long'), done: t('pomo_toast_long_done') };
        return { label: t('pomo_focus'), title: t('pomo_title_focus'), done: t('pomo_toast_focus_done') };
    }

    // DOM references
    let widget, timeEl, phaseEl, ringEl, startBtn, resetBtn, skipBtn, sessionsEl;
    let tickInterval = null;
    let completionAudio = null;

    // ==============================
    // STATE HELPERS
    // ==============================

    function getDefaultState() {
        return {
            phase: 'focus',
            status: 'idle',
            endTime: null,
            remainingMs: getSetting('focusDuration') * 60 * 1000,
            totalMs: getSetting('focusDuration') * 60 * 1000
        };
    }

    // In-memory cache for the parsed Pomodoro state. tick() runs once a
    // second while the timer is active and used to JSON.parse() the
    // localStorage entry on every invocation. State is only mutated by
    // user actions (start/pause/skip/reset) and the phase-complete handler,
    // which all route through saveState() and refresh the cache directly.
    // A 'storage' listener invalidates the cache if another tab writes the
    // key (multi-tab coherence — rare but cheap to support).
    var _stateCache = null;

    function getState() {
        if (_stateCache) return _stateCache;
        try {
            const raw = safeGet(POMO_STATE_KEY);
            if (!raw) {
                _stateCache = getDefaultState();
                return _stateCache;
            }
            const parsed = JSON.parse(raw);
            _stateCache = isSaneState(parsed) ? parsed : getDefaultState();
            return _stateCache;
        } catch (e) {
            _stateCache = getDefaultState();
            return _stateCache;
        }
    }

    // A stored state is only trusted when every field is what the timer
    // expects. A hand-edited or damaged entry (an endTime of "abc", a phase
    // that does not exist) used to reach the display as NaN:NaN, in the tab
    // title too.
    function isSaneState(s) {
        if (!s || typeof s !== 'object') return false;
        if (!['focus', 'shortBreak', 'longBreak', 'short', 'long'].includes(s.phase)) return false;
        if (!['idle', 'running', 'paused'].includes(s.status)) return false;
        const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
        if (!finite(s.totalMs) || s.totalMs === 0) return false;
        if (s.remainingMs != null && !finite(s.remainingMs)) return false;
        if (s.status === 'running' && !finite(s.endTime)) return false;
        if (s.endTime != null && !finite(s.endTime)) return false;
        return true;
    }

    function saveState(state) {
        safeSet(POMO_STATE_KEY, JSON.stringify(state));
        _stateCache = state;
    }

    // Cross-tab sync. The 'storage' event fires only on OTHER tabs (the writer
    // tab never sees its own event), so we don't fight saveState. Dropping the
    // cache alone left this tab painted with the old phase and count until the
    // user touched it; it now repaints from what the other tab saved.
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', function(e) {
            if (e && e.key === POMO_STATE_KEY) syncFromSharedState();
        });
    }

    // Repaints this tab from the shared state after another tab changed it.
    // Focus mode is left alone on purpose: it belongs to the tab the user
    // pressed Start in, and entering it here would start its ambient sounds
    // in every open tab.
    function syncFromSharedState() {
        _stateCache = null;
        var s = getState();
        updatePhaseLabel(s.phase);
        updateSessionsDisplay();
        if (s.status === 'running' && s.endTime) {
            updateDisplay(Math.max(0, s.endTime - Date.now()), s.totalMs);
            updateStartButtonIcon('running');
            updateTabTitle(s);
            if (!tickInterval && !document.hidden) tickInterval = setInterval(tick, 1000);
        } else {
            if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
            updateDisplay(s.remainingMs != null ? s.remainingMs : s.totalMs, s.totalMs);
            updateStartButtonIcon(s.status);
            resetTabTitle();
        }
    }

    function getSetting(name) {
        const config = POMO_SETTINGS_MAP[name];
        if (!config) return 25;
        return Number(safeGet(config.key) || config.fallback);
    }

    function getDurationMs(phase) {
        if (phase === 'focus') return getSetting('focusDuration') * 60 * 1000;
        if (phase === 'short') return getSetting('shortBreak') * 60 * 1000;
        if (phase === 'long')  return getSetting('longBreak') * 60 * 1000;
        return 25 * 60 * 1000;
    }

    // ==============================
    // SESSION TRACKING
    // ==============================

    function resetSessionsIfNewDay() {
        var today = new Date().toISOString().slice(0, 10);
        if (safeGet(POMO_SESSIONS_DATE_KEY) !== today) {
            safeSet(POMO_SESSIONS_KEY, '0');
            safeSet(POMO_SESSIONS_DATE_KEY, today);
        }
    }

    function getSessionCount() {
        resetSessionsIfNewDay();
        return Number(safeGet(POMO_SESSIONS_KEY) || '0');
    }

    function incrementSession() {
        var count = getSessionCount() + 1;
        safeSet(POMO_SESSIONS_KEY, String(count));
        return count;
    }

    // ==============================
    // DISPLAY
    // ==============================

    function formatTime(ms) {
        var totalSec = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(totalSec / 60);
        var s = totalSec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    // Track last-rendered seconds so we can skip the textContent + style writes
    // when the displayed value would be identical. tick() runs every 1000ms but
    // can fire twice in close succession on visibility resume — without the
    // skip, both paint the same value.
    var _lastRenderedSec = -1;

    function updateDisplay(remainingMs, totalMs) {
        if (!timeEl || !ringEl) return;
        var sec = Math.max(0, Math.ceil(remainingMs / 1000));
        if (sec !== _lastRenderedSec) {
            _lastRenderedSec = sec;
            timeEl.textContent = formatTime(remainingMs);
            var fraction = Math.max(0, Math.min(1, 1 - (remainingMs / totalMs)));
            ringEl.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
        }
    }

    function updatePhaseLabel(phase) {
        if (!phaseEl || !widget) return;
        phaseEl.textContent = phaseText(phase).label;
        widget.classList.remove('phase-focus', 'phase-short', 'phase-long');
        widget.classList.add('phase-' + phase);
    }

    function updateSessionsDisplay() {
        if (!sessionsEl) return;
        sessionsEl.textContent = getSessionCount() + ' / 4';
    }

    function updateStartButtonIcon(status) {
        if (!startBtn || !widget) return;
        var icon = startBtn.querySelector('.material-symbols-outlined');
        if (!icon) return;
        if (status === 'running') {
            icon.textContent = 'pause';
            startBtn.title = t('common_pause');
            widget.classList.add('is-running');
        } else {
            icon.textContent = 'play_arrow';
            startBtn.title = t('pomo_start_title');
            widget.classList.remove('is-running');
        }
    }

    // ==============================
    // FOCUS MODE
    // ==============================

    var focusModeActive = false;
    var focusPausedStreaming = false;
    var FOCUS_AMBIENT_MEMORY_KEY = STORAGE_KEYS.POMO_FOCUS_AMBIENT_MEMORY;
    // clock-stack rather than clock-widget: the weather used to be a child of
    // the clock and is now its sibling inside that container. Naming the clock
    // alone left the temperature sitting over the focus timer.
    var FOCUS_HIDE_TARGETS = [
        'searchBar', 'shortcuts-container', 'greeting-container', 'clock-stack',
        'music-widget', 'music-player-dock', 'music-visualizer-strip',
        'review-modal-backdrop', 'bookmarks-widget', 'open_close'
    ];
    // Cache of HTMLElements for FOCUS_HIDE_TARGETS — populated lazily on first
    // enter. The IDs never change at runtime so a single resolution is enough.
    var _focusHideElements = null;

    function getFocusHideElements() {
        if (_focusHideElements) return _focusHideElements;
        _focusHideElements = [];
        for (var i = 0; i < FOCUS_HIDE_TARGETS.length; i++) {
            var el = document.getElementById(FOCUS_HIDE_TARGETS[i]);
            if (el) _focusHideElements.push(el);
        }
        return _focusHideElements;
    }

    function isFocusModeEnabled() {
        return (safeGet(POMO_SETTINGS_MAP.focusMode.key) || POMO_SETTINGS_MAP.focusMode.fallback) === 'true';
    }

    function areFocusTasksEnabled() {
        return (safeGet(POMO_SETTINGS_MAP.focusTasks.key) || POMO_SETTINGS_MAP.focusTasks.fallback) === 'true';
    }

    function enterFocusMode() {
        if (focusModeActive || !isFocusModeEnabled()) return;
        focusModeActive = true;

        // Create dark overlay div with an exit affordance. Previously the user
        // could enter focus mode and have no way out short of finishing or
        // resetting the timer (Escape did nothing). Now: a small "×" button at
        // top-right of the overlay calls pauseTimer (which exits focus mode
        // via the existing flow); Escape does the same — see boot() below.
        if (!document.getElementById('pomo-focus-overlay')) {
            var overlay = document.createElement('div');
            overlay.id = 'pomo-focus-overlay';
            var exitBtn = document.createElement('button');
            exitBtn.id = 'pomo-focus-exit';
            exitBtn.type = 'button';
            exitBtn.setAttribute('aria-label', t('pomo_exit_focus_aria'));
            exitBtn.title = t('pomo_exit_focus_title');
            exitBtn.textContent = '×';
            exitBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                pauseTimer();
            });
            overlay.appendChild(exitBtn);
            document.body.appendChild(overlay);
        }

        // Pause the wallpaper video while in focus mode. The video keeps
        // decoding frames behind the blur(24px) overlay otherwise — pure GPU
        // waste since the user can't see the content meaningfully through that
        // blur radius. Resume on exit.
        try {
            var bgVideo = document.getElementById('mainVideo');
            if (bgVideo && !bgVideo.paused) {
                bgVideo.dataset.pomoPaused = '1';
                bgVideo.pause();
            }
        } catch (_) {}

        document.body.classList.add('pomo-focus-active');
        // The task list is not in FOCUS_HIDE_TARGETS: it is the one thing
        // focus mode shows rather than hides, beside the timer.
        document.body.classList.toggle('pomo-tasks-on', areFocusTasksEnabled());
        var elements = getFocusHideElements();
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (!el.classList.contains('hidden-final')) {
                el.classList.add('pomo-focus-hidden');
            }
        }

        // Auto-pause currently-playing streaming music (YouTube). Remember so we can
        // resume it when focus ends.
        try {
            var streamingNow = typeof window.wfHasActiveStreaming === 'function' &&
                               typeof window.wfIsMusicPaused === 'function' &&
                               window.wfHasActiveStreaming() && !window.wfIsMusicPaused();

            // On page reload mid-focus, music.js may have flagged that streaming
            // smart-resume was suppressed — treat that as "streaming was playing,
            // we should resume it when focus ends"
            var streamingPending = safeGet('wf_pomo_focus_streaming_pending') === 'true';

            if (streamingNow) {
                if (typeof window.pauseMusic === 'function') {
                    window.pauseMusic();
                    focusPausedStreaming = true;
                    // Mark persistent flag so a page reload still knows to block
                    // smart-resume + restore the pause-resume contract.
                    safeSet('wf_pomo_focus_streaming_pending', 'true');
                }
            } else if (streamingPending) {
                // Flag survives across reloads — keep it until focus ends
                focusPausedStreaming = true;
            }
        } catch (_) {}

        // Restore ambient sounds from the previous focus session (focus-scoped memory).
        // The user picks/manages sounds from the music panel via the "Sounds" button.
        restoreFocusAmbientMemory();
    }

    function exitFocusMode() {
        if (!focusModeActive) return;
        focusModeActive = false;

        // Remove overlay div
        var overlay = document.getElementById('pomo-focus-overlay');
        if (overlay) overlay.remove();

        // Resume wallpaper video if we paused it on enter (only if it was
        // actually playing before — don't unilaterally start a paused video).
        try {
            var bgVideo = document.getElementById('mainVideo');
            if (bgVideo && bgVideo.dataset.pomoPaused === '1') {
                delete bgVideo.dataset.pomoPaused;
                var p = bgVideo.play();
                if (p && typeof p.catch === 'function') p.catch(function() {});
            }
        } catch (_) {}

        document.body.classList.remove('pomo-focus-active');
        document.body.classList.remove('pomo-tasks-on');
        var elements = getFocusHideElements();
        for (var i = 0; i < elements.length; i++) {
            elements[i].classList.remove('pomo-focus-hidden');
        }

        // Save which ambient sounds were active during this focus session so we can
        // restore them on the next focus start (focus-scoped ambient persistence).
        saveFocusAmbientMemory();

        // Stop all ambient sounds, then resume streaming if we paused it on enter.
        try {
            if (typeof window.wfStopAllAmbientSounds === 'function') {
                window.wfStopAllAmbientSounds();
            }
        } catch (_) {}

        if (focusPausedStreaming) {
            try {
                var hasPlayer = typeof window.wfHasActiveStreaming === 'function' && window.wfHasActiveStreaming();
                if (hasPlayer) {
                    // Normal path — iframe exists, just unpause it
                    if (typeof window.resumeMusic === 'function') {
                        window.resumeMusic();
                    }
                } else {
                    // Edge case — streaming was flagged pending from a suppressed smart-resume
                    // (page reloaded mid-focus). Trigger a fresh smart resume to spin up
                    // the iframe and start playback.
                    if (typeof window.wfTriggerSmartResume === 'function') {
                        window.wfTriggerSmartResume();
                    }
                }
            } catch (_) {}
            focusPausedStreaming = false;
        }
        // Clear persistent flag — focus is over, streaming state is handled
        safeRemove('wf_pomo_focus_streaming_pending');

    }

    // ==============================
    // FOCUS SOUNDS MODAL — dedicated lightweight grid for ambient sounds
    // ==============================

    var POMO_SOUNDS_ICON_MAP = {
        rain: 'rainy', beach: 'waves', storm: 'thunderstorm', birds: 'flutter_dash',
        forest: 'forest', river: 'water', waterfall: 'water_drop', desert: 'air',
        swamp: 'eco', campfire: 'local_fire_department', city: 'location_city',
        city_night: 'nights_stay', plane: 'flight', train: 'train', submarine: 'sailing',
        playground: 'child_friendly', vinyl: 'album', night: 'bedtime',
        chimes: 'music_note', chimes_wav: 'notifications', white_noise: 'graphic_eq',
        bar: 'local_cafe', end_sound_timer: 'self_improvement'
    };

    function buildPomoSoundsChips() {
        var grid = document.getElementById('pomo-sounds-grid');
        if (!grid || grid.dataset.built === '1') return;
        grid.innerHTML = '';
        // Iterate over the actual sound cards in the DOM so we use the canonical
        // names + keys (no duplication of the sound list).
        var cards = document.querySelectorAll('.sound-card[data-sound]');
        cards.forEach(function(card) {
            var key = card.getAttribute('data-sound');
            var name = card.getAttribute('data-name') || key;
            // Pull the current volume from the music panel slider (single source of truth)
            var origSlider = card.querySelector('.sound-volume');
            var volValue = origSlider ? origSlider.value : '50';

            var chip = document.createElement('div');
            chip.className = 'pomo-sounds-chip';
            chip.setAttribute('role', 'button');
            chip.setAttribute('tabindex', '0');
            chip.setAttribute('data-sound', key);
            chip.title = name;

            var icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            icon.textContent = POMO_SOUNDS_ICON_MAP[key] || 'music_note';

            var label = document.createElement('span');
            label.className = 'pomo-sounds-chip-name';
            label.textContent = name;

            var slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'pomo-sounds-chip-volume';
            slider.min = '0';
            // Mirrors .sound-volume in the music panel, which goes to 200 so
            // ambient can be boosted past unity gain. Kept in sync by hand —
            // a chip capped at 100 would silently clamp a boosted sound back
            // down the moment the user touched it here.
            slider.max = '200';
            slider.value = volValue;
            // Fill is a fraction of the range, not of 100 — with max=200 the
            // old `value + '%'` overshot the track at anything above half.
            slider.style.setProperty('--volume-pct', (Number(volValue) / 2) + '%');
            slider.setAttribute('aria-label', t('pomo_sounds_volume_aria', { sound: name }));

            chip.appendChild(icon);
            chip.appendChild(label);
            chip.appendChild(slider);
            grid.appendChild(chip);
        });
        grid.dataset.built = '1';
    }

    function syncPomoSoundsChips() {
        var grid = document.getElementById('pomo-sounds-grid');
        if (!grid) return;
        var chips = grid.querySelectorAll('.pomo-sounds-chip');
        for (var i = 0; i < chips.length; i++) {
            var key = chips[i].getAttribute('data-sound');
            var active = typeof window.wfIsAmbientPlaying === 'function' && window.wfIsAmbientPlaying(key);
            chips[i].classList.toggle('active', !!active);
            chips[i].setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    }

    function openPomoSoundsModal() {
        var modal = document.getElementById('pomo-sounds-modal');
        if (!modal) return;
        buildPomoSoundsChips();
        syncPomoSoundsChips();
        // Sync slider values with the music panel's per-sound volumes (in case
        // user changed them outside focus)
        syncPomoSoundsSliders();
        if (typeof updateMuteBtnState === 'function') updateMuteBtnState();
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        // Previously a 400ms setInterval re-ran syncPomoSoundsChips while the
        // modal was open — 2.5 querySelectorAll passes/sec for an idle modal.
        // Replaced with the per-click setTimeout(..., 60/400) re-syncs that
        // already exist in the chip handler (initPomoSoundsModal). Sounds are
        // toggled exclusively from inside the modal while it's open, so the
        // per-click re-syncs catch every state change.
    }

    function syncPomoSoundsSliders() {
        var chips = document.querySelectorAll('#pomo-sounds-grid .pomo-sounds-chip');
        chips.forEach(function(chip) {
            var key = chip.getAttribute('data-sound');
            var origSlider = document.querySelector('.sound-card[data-sound="' + key + '"] .sound-volume');
            var chipSlider = chip.querySelector('.pomo-sounds-chip-volume');
            if (origSlider && chipSlider) {
                chipSlider.value = origSlider.value;
                const chipMax = Number(chipSlider.max) || 100;
                chipSlider.style.setProperty(
                    '--volume-pct',
                    ((Number(origSlider.value) / chipMax) * 100) + '%'
                );
            }
        });
    }

    function closePomoSoundsModal() {
        var modal = document.getElementById('pomo-sounds-modal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
    }

    function initPomoSoundsModal() {
        var modal = document.getElementById('pomo-sounds-modal');
        if (!modal || modal.dataset.wired === '1') return;
        modal.dataset.wired = '1';

        var closeBtn = modal.querySelector('.pomo-sounds-modal-close');
        var backdrop = modal.querySelector('.pomo-sounds-modal-backdrop');

        if (closeBtn) closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            closePomoSoundsModal();
        });
        if (backdrop) backdrop.addEventListener('click', function(e) {
            e.stopPropagation();
            closePomoSoundsModal();
        });

        // Click on a chip → toggle sound. Click on the chip's volume slider →
        // adjust the corresponding sound's volume (mirroring the music panel slider).
        var grid = document.getElementById('pomo-sounds-grid');
        if (grid) {
            grid.addEventListener('click', function(e) {
                // Slider clicks are handled by 'input' below — don't trigger toggle
                if (e.target.classList.contains('pomo-sounds-chip-volume')) return;
                var chip = e.target.closest('.pomo-sounds-chip');
                if (!chip) return;
                e.stopPropagation();
                var key = chip.getAttribute('data-sound');
                if (!key) return;
                if (typeof window.wfToggleAmbientByKey === 'function') {
                    window.wfToggleAmbientByKey(key);
                    setTimeout(syncPomoSoundsChips, 60);
                    setTimeout(syncPomoSoundsChips, 400);
                }
            });

            // Volume slider — mirror the value to the original sound card's slider
            // and dispatch its 'input' event so the existing audio.volume handler runs.
            grid.addEventListener('input', function(e) {
                if (!e.target.classList.contains('pomo-sounds-chip-volume')) return;
                var chip = e.target.closest('.pomo-sounds-chip');
                if (!chip) return;
                // Update the visual fill on the slider track
                const chipMax = Number(e.target.max) || 100;
                e.target.style.setProperty(
                    '--volume-pct',
                    ((Number(e.target.value) / chipMax) * 100) + '%'
                );
                var key = chip.getAttribute('data-sound');
                var origCard = document.querySelector('.sound-card[data-sound="' + key + '"]');
                if (!origCard) return;
                var origSlider = origCard.querySelector('.sound-volume');
                if (!origSlider) return;
                origSlider.value = e.target.value;
                // Trigger the existing handler that updates audio.volume + persists state
                origSlider.dispatchEvent(new Event('input', { bubbles: true }));
            });

            // Keyboard support — Space/Enter on chip toggles
            grid.addEventListener('keydown', function(e) {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                var chip = e.target.closest('.pomo-sounds-chip');
                if (!chip || e.target !== chip) return;
                e.preventDefault();
                chip.click();
            });
        }

        // Mute all → click the original ambient mute button (toggle behavior reused)
        var muteBtn = document.getElementById('pomo-sounds-mute-btn');
        if (muteBtn) {
            muteBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var orig = document.getElementById('ambient-mute-all-btn');
                if (orig) orig.click();
                // Reflect mute state visually in our button
                setTimeout(updateMuteBtnState, 50);
            });
        }

        // Stop all → click the original ambient stop-all button
        var stopBtn = document.getElementById('pomo-sounds-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (typeof window.wfStopAllAmbientSounds === 'function') {
                    window.wfStopAllAmbientSounds();
                }
                setTimeout(syncPomoSoundsChips, 60);
            });
        }

        // Escape closes
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.classList.contains('show')) {
                closePomoSoundsModal();
            }
        });
    }

    function updateMuteBtnState() {
        var btn = document.getElementById('pomo-sounds-mute-btn');
        if (!btn) return;
        // Check the original mute button's text to know current state
        var orig = document.getElementById('ambient-mute-all-btn');
        var isMuted = orig && (orig.textContent || '').toLowerCase().indexOf('unmute') !== -1;
        btn.classList.toggle('is-muted', isMuted);
        var label = btn.querySelector('.pomo-sounds-action-label');
        if (label) label.textContent = isMuted ? t('common_unmute') : t('common_mute');
        var icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = isMuted ? 'volume_up' : 'volume_off';
    }

    // ==============================
    // AMBIENT QUICK PICKER (visible in focus overlay)
    // ==============================

    function saveFocusAmbientMemory() {
        try {
            var keys = [];
            if (typeof window.wfGetActiveAmbientKeys === 'function') {
                keys = window.wfGetActiveAmbientKeys() || [];
            }
            safeSet(FOCUS_AMBIENT_MEMORY_KEY, JSON.stringify(keys));
        } catch (_) {}
    }

    function restoreFocusAmbientMemory() {
        try {
            var raw = safeGet(FOCUS_AMBIENT_MEMORY_KEY);
            if (!raw) return;
            var keys = JSON.parse(raw);
            if (!Array.isArray(keys) || !keys.length) return;
            // Stagger starts slightly so the existing "one-tab-owner" ambient check
            // and audio context warm-up don't race.
            keys.forEach(function(key, idx) {
                setTimeout(function() {
                    if (typeof window.wfIsAmbientPlaying === 'function' &&
                        !window.wfIsAmbientPlaying(key) &&
                        typeof window.wfToggleAmbientByKey === 'function') {
                        window.wfToggleAmbientByKey(key);
                    }
                }, 80 * idx);
            });
        } catch (_) {}
    }

    // ==============================
    // TIMER LOGIC
    // ==============================

    // ==============================
    // TAB TITLE — show countdown in browser tab while running
    // ==============================

    function defaultTabTitle() { return t('page_new_tab'); }
    var PHASE_ICONS = { focus: '🍅', short: '☕', long: '☕' }; // 🍅 / ☕

    // Pass already-parsed state in to avoid the second JSON.parse per tick.
    // The previous implementation parsed POMO_STATE_KEY twice every second
    // (once in tick(), once inside updateTabTitle()).
    function updateTabTitle(state) {
        try {
            var s = state || getState();
            if (!s || s.status !== 'running') {
                if (document.title !== defaultTabTitle()) document.title = defaultTabTitle();
                return;
            }
            var remaining = Math.max(0, s.endTime - Date.now());
            var totalSec = Math.ceil(remaining / 1000);
            var m = Math.floor(totalSec / 60);
            var sec = totalSec % 60;
            var time = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
            var phase = s.phase || 'focus';
            var icon = PHASE_ICONS[phase] || PHASE_ICONS.focus;
            var label = phaseText(phase).title;
            var newTitle = icon + ' ' + time + ' \u00B7 ' + label;
            if (document.title !== newTitle) document.title = newTitle;
        } catch (_) { /* silent */ }
    }

    function resetTabTitle() {
        if (document.title !== defaultTabTitle()) document.title = defaultTabTitle();
    }

    function tick() {
        var state = getState();
        if (state.status !== 'running') return;

        var remaining = state.endTime - Date.now();
        if (remaining <= 0) {
            onPhaseComplete(state);
        } else {
            updateDisplay(remaining, state.totalMs);
            updateTabTitle(state);
        }
    }

    // The question itself lives in tasks.js, which loads after this file.
    // A marker in storage rather than a direct call, so a session that
    // finished while every tab was closed, and completes during boot before
    // tasks.js exists, still gets its question.
    function askAboutCurrentTask() {
        if (!isFocusModeEnabled() || !areFocusTasksEnabled()) return;
        safeSet(STORAGE_KEYS.TASKS_ASK, 'current');
        if (typeof window.wfTasksRenderAsk === 'function') window.wfTasksRenderAsk();
    }

    function dismissTaskQuestion() {
        safeRemove(STORAGE_KEYS.TASKS_ASK);
        if (typeof window.wfTasksRenderAsk === 'function') window.wfTasksRenderAsk();
    }

    function startTimer() {
        var state = getState();
        var remaining = state.remainingMs || getDurationMs(state.phase || 'focus');
        var total = state.totalMs || remaining;
        var newState = {
            phase: state.phase || 'focus',
            status: 'running',
            endTime: Date.now() + remaining,
            remainingMs: remaining,
            totalMs: total
        };
        saveState(newState);
        updateStartButtonIcon('running');
        if (newState.phase === 'focus') {
            // A new session makes the question about the last one moot.
            dismissTaskQuestion();
            enterFocusMode();
        }
        tick();
        updateTabTitle();
        if (tickInterval) clearInterval(tickInterval);
        tickInterval = setInterval(tick, 1000);
    }

    function pauseTimer() {
        var state = getState();
        if (state.status !== 'running') return;
        var remaining = Math.max(0, state.endTime - Date.now());
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
        var newState = {
            phase: state.phase,
            status: 'paused',
            endTime: null,
            remainingMs: remaining,
            totalMs: state.totalMs
        };
        saveState(newState);
        updateStartButtonIcon('paused');
        exitFocusMode();
        resetTabTitle();
    }

    function resetTimer() {
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
        var state = getState();
        var phase = state.phase || 'focus';
        var totalMs = getDurationMs(phase);
        var newState = { phase: phase, status: 'idle', endTime: null, remainingMs: totalMs, totalMs: totalMs };
        saveState(newState);
        updateDisplay(totalMs, totalMs);
        updateStartButtonIcon('idle');
        updatePhaseLabel(phase);
        exitFocusMode();
        resetTabTitle();
    }

    function getNextPhase(currentPhase) {
        if (currentPhase === 'focus') {
            var sessions = getSessionCount();
            return ((sessions + 1) % 4 === 0) ? 'long' : 'short';
        }
        return 'focus';
    }

    function skipPhase() {
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
        exitFocusMode();
        var state = getState();
        var nextPhase = getNextPhase(state.phase || 'focus');
        var totalMs = getDurationMs(nextPhase);
        var newState = { phase: nextPhase, status: 'idle', endTime: null, remainingMs: totalMs, totalMs: totalMs };
        saveState(newState);
        updateDisplay(totalMs, totalMs);
        updateStartButtonIcon('idle');
        updatePhaseLabel(nextPhase);
        updateSessionsDisplay();
        resetTabTitle();
    }

    function onPhaseComplete(state) {
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }

        // Every open tab ticks the same shared state, so two tabs reach this
        // point for the same run. The first records which run it completed;
        // the other only catches up its display from what the first saved.
        var completionStamp = state.endTime ? String(state.endTime) : '';
        if (completionStamp && safeGet(POMO_COMPLETED_AT_KEY) === completionStamp) {
            syncFromSharedState();
            return;
        }
        if (completionStamp) safeSet(POMO_COMPLETED_AT_KEY, completionStamp);

        playCompletionSound();
        exitFocusMode();

        if (state.phase === 'focus') {
            incrementSession();
            askAboutCurrentTask();
        }

        if (typeof showPush === 'function') {
            showPush(phaseText(state.phase).done, 'success');
        }

        var nextPhase = getNextPhase(state.phase);
        var totalMs = getDurationMs(nextPhase);
        var newState = { phase: nextPhase, status: 'idle', endTime: null, remainingMs: totalMs, totalMs: totalMs };
        saveState(newState);
        updateDisplay(totalMs, totalMs);
        updatePhaseLabel(nextPhase);
        updateStartButtonIcon('idle');
        updateSessionsDisplay();
        resetTabTitle();

        var autoStart = safeGet(POMO_SETTINGS_MAP.autoStart.key) || POMO_SETTINGS_MAP.autoStart.fallback;
        if (autoStart === 'true') {
            setTimeout(startTimer, 1500);
        }
    }

    function playCompletionSound() {
        try {
            // Create once, reuse across phase completions — don't leak a new Audio each time
            if (!completionAudio) {
                completionAudio = new Audio(chrome.runtime.getURL('src/audio/end_sound_timer.mp3'));
                completionAudio.volume = 0.6;
            } else {
                completionAudio.pause();
                completionAudio.currentTime = 0;
            }
            completionAudio.play().catch(function() {});
        } catch (e) { /* silent */ }
    }

    // ==============================
    // SETTINGS INIT (exposed globally)
    // ==============================

    window.initializePomodoroSettings = function() {
        var settingsRoot = document.querySelector('[data-widget-options="pomodoro"]');
        if (!settingsRoot) return;

        var allButtons = settingsRoot.querySelectorAll('.widget-open-mode-btn');
        if (!allButtons.length) return;

        var syncActiveButtons = function() {
            for (var setting in POMO_SETTINGS_MAP) {
                var config = POMO_SETTINGS_MAP[setting];
                var stored = safeGet(config.key) || config.fallback;
                var btns = settingsRoot.querySelectorAll('.widget-open-mode-btn[data-setting="' + setting + '"]');
                for (var i = 0; i < btns.length; i++) {
                    var btn = btns[i];
                    var isActive = btn.getAttribute('data-value') === stored;
                    btn.classList.toggle('active', isActive);
                    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                }
            }
        };

        syncActiveButtons();

        if (settingsRoot.dataset.initialized === 'true') return;
        settingsRoot.dataset.initialized = 'true';

        settingsRoot.addEventListener('click', function(e) { e.stopPropagation(); });

        for (var i = 0; i < allButtons.length; i++) {
            (function(button) {
                button.setAttribute('aria-pressed', 'false');
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();

                    var setting = button.getAttribute('data-setting');
                    var value = button.getAttribute('data-value');
                    var config = POMO_SETTINGS_MAP[setting];
                    if (!config) return;

                    if (!saveSetting(config.key, value)) { syncActiveButtons(); return; }
                    syncActiveButtons();

                    // If duration changed while idle, update display
                    var state = getState();
                    if (state.status === 'idle') {
                        var totalMs = getDurationMs(state.phase);
                        saveState({ phase: state.phase, status: 'idle', endTime: null, remainingMs: totalMs, totalMs: totalMs });
                        updateDisplay(totalMs, totalMs);
                    }

                    // Shared with the rest of the Settings panel (widgets.js), so
                    // Pomodoro confirms changes exactly like every other card.
                    if (typeof window.wfAnnounceSettingChange === 'function') {
                        window.wfAnnounceSettingChange(button);
                    }
                });
            })(allButtons[i]);
        }
    };

    // Exposed for settings reset
    window.resetPomodoroTimer = function() {
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
        exitFocusMode();
        // Clear ALL pomo-prefixed keys, not just state/sessions. The previous
        // implementation left wf_pomo_focus_ambient_memory and
        // wf_pomo_focus_streaming_pending behind across resets, leading to
        // stale ambient restoration on the next focus session.
        safeRemove(POMO_STATE_KEY);
        safeRemove(POMO_SESSIONS_KEY);
        safeRemove(POMO_SESSIONS_DATE_KEY);
        safeRemove(FOCUS_AMBIENT_MEMORY_KEY);
        safeRemove('wf_pomo_focus_streaming_pending');
        dismissTaskQuestion();
        // Setting keys (focus_min, short_min, long_min, auto_start, focus_mode)
        // are intentionally NOT cleared here — those are user preferences and
        // get cleared by the Settings panel's own Reset button (widgets.js).
        var totalMs = 25 * 60 * 1000;
        var state = { phase: 'focus', status: 'idle', endTime: null, remainingMs: totalMs, totalMs: totalMs };
        saveState(state);
        if (timeEl) updateDisplay(totalMs, totalMs);
        if (phaseEl) updatePhaseLabel('focus');
        if (startBtn) updateStartButtonIcon('idle');
        if (sessionsEl) updateSessionsDisplay();
    };

    // ==============================
    // BOOT
    // ==============================

    function boot() {
        widget     = document.getElementById('pomodoro-widget');
        timeEl     = document.getElementById('pomo-time');
        phaseEl    = document.getElementById('pomo-phase');
        ringEl     = document.getElementById('pomo-ring-progress');
        startBtn   = document.getElementById('pomo-start');
        resetBtn   = document.getElementById('pomo-reset');
        skipBtn    = document.getElementById('pomo-skip');
        sessionsEl = document.getElementById('pomo-sessions');

        if (!widget || !timeEl || !phaseEl || !ringEl || !startBtn) return;

        // Wire the "Sounds" button — opens the dedicated focus-mode sounds modal
        var soundsBtn = document.getElementById('pomo-sounds-btn');
        if (soundsBtn) {
            soundsBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                openPomoSoundsModal();
            });
        }
        initPomoSoundsModal();

        // Restore state
        resetSessionsIfNewDay();
        var state = getState();

        // If timer was running and completed while tab was closed
        if (state.status === 'running' && state.endTime && state.endTime <= Date.now()) {
            onPhaseComplete(state);
        } else if (state.status === 'running') {
            // Resume running timer
            updatePhaseLabel(state.phase);
            updateStartButtonIcon('running');
            updateDisplay(state.endTime - Date.now(), state.totalMs);
            updateTabTitle();
            if (state.phase === 'focus') enterFocusMode();
            tickInterval = setInterval(tick, 1000);
        } else {
            // Idle or paused
            var phase = state.phase || 'focus';
            var remaining = state.remainingMs || getDurationMs(phase);
            var total = state.totalMs || getDurationMs(phase);
            updatePhaseLabel(phase);
            updateDisplay(remaining, total);
            updateStartButtonIcon(state.status || 'idle');
        }

        updateSessionsDisplay();

        // Button event listeners
        startBtn.addEventListener('click', function() {
            var s = getState();
            if (s.status === 'running') {
                pauseTimer();
            } else {
                startTimer();
            }
        });

        if (resetBtn) resetBtn.addEventListener('click', resetTimer);
        if (skipBtn)  skipBtn.addEventListener('click', skipPhase);

        // Persist ambient state on page reload/close if focus is active, so the next
        // load restores the same ambient mix instead of using a stale memory.
        window.addEventListener('beforeunload', function() {
            if (focusModeActive) {
                saveFocusAmbientMemory();
            }
        });

        // Escape exits focus mode. Without this the user could be trapped in
        // focus mode if they paused but the timer didn't auto-resume — there
        // was no overlay-level dismiss affordance. The new exit button (top-
        // right of the overlay) and this Escape handler both fall through to
        // pauseTimer(), which calls exitFocusMode() in its existing flow.
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            if (!focusModeActive) return;
            // If the sounds modal is open, let its own Escape handler close it
            // first; we don't want one Esc press to close both.
            var soundsModal = document.getElementById('pomo-sounds-modal');
            if (soundsModal && soundsModal.classList.contains('show')) return;
            e.preventDefault();
            pauseTimer();
        });

        // (#pomo-ambient-picker handler removed — id no longer in HTML.
        //  Ambient-memory saves still trigger from the focus-mode lifecycle
        //  hooks above, which fire whenever the user toggles a card.)

        // Tab visibility — pause/resume interval (via shared visibility hub).
        if (typeof window.wfOnVisibilityChange === 'function') {
            window.wfOnVisibilityChange(function(hidden) {
                var s = getState();
                if (s.status !== 'running') return;

                if (hidden) {
                    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
                } else {
                    if (s.endTime && s.endTime <= Date.now()) {
                        onPhaseComplete(s);
                    } else {
                        tick();
                        if (tickInterval) clearInterval(tickInterval);
                        tickInterval = setInterval(tick, 1000);
                    }
                }
            });
        }
    }

    // Init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
