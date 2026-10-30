(function() {
    var version = '';
    try {
        var params = new URLSearchParams(location.search);
        version = params.get('to') || '';
        if (!version && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
            version = chrome.runtime.getManifest().version || '';
        }
    } catch (_) {}
    var meta = document.getElementById('version-meta');
    if (meta) meta.textContent = version ? 'v' + version : '';
})();

// ==============================
// LIVE DEMOS
// ==============================
// The controls on this page are the real ones rebuilt in plain markup, so the
// reader can press them instead of reading a description of them. Nothing here
// touches storage or the extension's settings: it is all local to this tab.
//
// The page runs under the extension CSP, which allows neither inline scripts
// nor inline styles, so every state change here is a class.
(function() {
    var reduceMotion = false;
    try {
        reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {}

    // --- The wallpaper behind the demos ---
    // One frame of the extension's own default wallpaper, taken once and
    // shared by every demo through a CSS variable, rather than painted
    // gradients. If the frame cannot be taken, the plain colour stays.
    (function wallpaperFrame() {
        var video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;

        video.addEventListener('loadeddata', function() {
            try {
                video.currentTime = Math.min(2, (video.duration || 4) / 2);
            } catch (_) {}
        }, { once: true });

        video.addEventListener('seeked', function() {
            try {
                var sourceWidth = video.videoWidth || 1280;
                var sourceHeight = video.videoHeight || 720;
                var width = Math.min(1280, sourceWidth);
                var height = Math.round(width * sourceHeight / sourceWidth);
                var canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(video, 0, 0, width, height);
                var frame = canvas.toDataURL('image/jpeg', 0.82);
                document.documentElement.style.setProperty('--wf-demo-wallpaper', 'url("' + frame + '")');
            } catch (_) {
                // A page opened from a file cannot read pixels from a video.
            }
            video.removeAttribute('src');
            video.load();
        }, { once: true });

        video.src = '../videos/default.mp4';
    })();

    // --- The interface language ---
    // A small new tab drawn in each shipped language from that language's own
    // catalogue, with the time and date from Intl, so the hour cycle is the one
    // the extension's clock starts in. It starts on the language this page is in.
    (function languageDemo() {
        var seg = document.getElementById('demo-lang-seg');
        var preview = document.getElementById('demo-lang-preview');
        var time = document.getElementById('demo-lang-time');
        var date = document.getElementById('demo-lang-date');
        var greet = document.getElementById('demo-lang-greet');
        var search = document.getElementById('demo-lang-search');
        if (!seg || !preview || !time || !date || !greet || !search || !window.wfI18n) return;

        var locales = Array.prototype.slice.call(wfI18n.supported || []);
        if (!locales.length) return;

        // Nine in the morning, so the greeting matches the hour on the clock.
        var sample = new Date();
        sample.setHours(9, 41, 0, 0);

        var catalogs = {};
        var latest = 0;

        function loadCatalog(code) {
            if (catalogs[code]) return Promise.resolve(catalogs[code]);
            var url = '../../_locales/' + code + '/messages.json';
            try {
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                    url = chrome.runtime.getURL('_locales/' + code + '/messages.json');
                }
            } catch (_) {}
            return fetch(url)
                .then(function(response) { return response.ok ? response.json() : {}; })
                .catch(function() { return {}; })
                .then(function(catalog) {
                    catalogs[code] = catalog;
                    return catalog;
                });
        }

        function messageFrom(catalog, key) {
            var entry = catalog && catalog[key];
            return entry && typeof entry.message === 'string' ? entry.message : '';
        }

        function show(code) {
            var ask = ++latest;
            Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function(btn) {
                var on = btn.getAttribute('data-code') === code;
                btn.classList.toggle('is-on', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            loadCatalog(code).then(function(catalog) {
                // A slower catalogue must not overwrite a language picked after it.
                if (ask !== latest) return;
                preview.setAttribute('lang', code);
                try {
                    // Two digit hours, as the clock on the new tab writes them.
                    time.textContent = new Intl.DateTimeFormat(code, { hour: '2-digit', minute: '2-digit' }).format(sample);
                    date.textContent = new Intl.DateTimeFormat(code, { weekday: 'long', day: 'numeric', month: 'long' }).format(sample);
                } catch (_) {
                    time.textContent = '9:41';
                    date.textContent = '';
                }
                greet.textContent = messageFrom(catalog, 'greet_headline_morning') || t('greet_headline_morning');
                search.textContent = messageFrom(catalog, 'search_search_the_web_placeholder') || t('search_search_the_web_placeholder');
            });
        }

        locales.forEach(function(locale) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'seg-btn';
            btn.setAttribute('data-code', locale.code);
            btn.setAttribute('lang', locale.code);
            btn.setAttribute('translate', 'no');
            btn.textContent = locale.native;
            seg.appendChild(btn);
        });

        seg.addEventListener('click', function(e) {
            var btn = e.target.closest('.seg-btn');
            if (btn) show(btn.getAttribute('data-code'));
        });

        var start = locales.some(function(locale) { return locale.code === wfI18n.lang; }) ? wfI18n.lang : 'en';
        show(start);
    })();

    // --- Tasks in a focus session ---
    // Kept in memory only: a reload puts the example back.
    (function tasksDemo() {
        var stage = document.getElementById('demo-fx');
        var list = document.getElementById('demo-tk-list');
        var input = document.getElementById('demo-tk-add');
        var foot = document.getElementById('demo-tk-foot');
        var count = document.getElementById('demo-tk-count');
        var clear = document.getElementById('demo-tk-clear');
        var time = document.getElementById('demo-fx-time');
        var phase = document.getElementById('demo-fx-phase');
        var ask = document.getElementById('demo-fx-ask');
        var askText = document.getElementById('demo-fx-ask-text');
        var yes = document.getElementById('demo-fx-yes');
        var no = document.getElementById('demo-fx-no');
        var toggle = document.getElementById('demo-fx-toggle');
        var now = document.getElementById('demo-fx-now');
        var nowText = document.getElementById('demo-fx-now-text');
        if (!stage || !list || !input || !foot || !count || !clear || !time || !phase ||
            !ask || !askText || !yes || !no || !toggle || !now || !nowText) return;

        // Fewer than the real 50, so the example never outgrows its frame.
        var MAX = 6;
        var focusing = true;
        var asking = null;
        var tasks = [
            { text: t('whatsnew_demo_task_1'), done: true },
            { text: t('whatsnew_demo_task_2'), done: false },
            { text: t('whatsnew_demo_task_3'), done: false }
        ];

        function firstOpen() {
            for (var i = 0; i < tasks.length; i++) {
                if (!tasks[i].done) return tasks[i];
            }
            return null;
        }

        function render(focusIndex) {
            var current = firstOpen();
            list.textContent = '';
            tasks.forEach(function(task, i) {
                var row = document.createElement('li');
                row.className = 'tk-row' + (task.done ? ' is-done' : '') + (task === current ? ' is-current' : '');
                row.setAttribute('role', 'checkbox');
                row.setAttribute('aria-checked', task.done ? 'true' : 'false');
                row.setAttribute('tabindex', '0');
                row.setAttribute('data-index', String(i));
                var check = document.createElement('span');
                check.className = 'tk-check';
                var text = document.createElement('span');
                text.className = 'tk-text';
                text.textContent = task.text;
                row.appendChild(check);
                row.appendChild(text);
                if (!task.done && task !== current) {
                    var up = document.createElement('button');
                    up.className = 'tk-promote';
                    up.type = 'button';
                    up.tabIndex = -1;
                    up.title = t('tasks_promote_title');
                    up.setAttribute('aria-label', t('tasks_promote_title'));
                    up.textContent = '↑';
                    row.appendChild(up);
                }
                list.appendChild(row);
            });

            var done = tasks.filter(function(task) { return task.done; }).length;
            foot.hidden = done === 0;
            count.textContent = t('tasks_done_count', { count: done });

            var full = tasks.length >= MAX;
            input.disabled = full;
            input.placeholder = full ? t('whatsnew_demo_tasks_enough') : t('tasks_add_a_task_placeholder');

            stage.classList.toggle('is-focus', focusing);
            time.textContent = focusing ? '24:59' : '05:00';
            phase.textContent = focusing ? t('pomo_focus') : t('pomo_title_short');
            toggle.textContent = focusing ? t('whatsnew_demo_end_the_session') : t('whatsnew_demo_start_next_session');

            var showNow = focusing && !!current;
            now.hidden = !showNow;
            nowText.textContent = showNow ? current.text : '';
            now.setAttribute('aria-label', showNow ? t('tasks_now_aria', { task: current.text }) : t('whatsnew_demo_no_task'));

            if (asking && (asking.done || tasks.indexOf(asking) === -1)) asking = null;
            ask.hidden = !asking;
            askText.textContent = asking ? t('tasks_ask_done', { task: asking.text }) : '';

            if (typeof focusIndex === 'number' && list.children[focusIndex]) {
                list.children[focusIndex].focus();
            }
        }

        list.addEventListener('click', function(e) {
            var row = e.target.closest('.tk-row');
            if (!row) return;
            var i = Number(row.getAttribute('data-index'));
            if (!tasks[i]) return;
            if (e.target.closest('.tk-promote')) {
                tasks.unshift(tasks.splice(i, 1)[0]);
            } else {
                tasks[i].done = !tasks[i].done;
            }
            render();
        });

        list.addEventListener('keydown', function(e) {
            var row = e.target.closest('.tk-row');
            if (!row || (e.key !== ' ' && e.key !== 'Enter')) return;
            e.preventDefault();
            var i = Number(row.getAttribute('data-index'));
            if (!tasks[i]) return;
            tasks[i].done = !tasks[i].done;
            render(i);
        });

        input.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                input.value = '';
                return;
            }
            if (e.key !== 'Enter') return;
            var text = input.value.replace(/\s+/g, ' ').trim().slice(0, 120);
            if (!text || tasks.length >= MAX) return;
            tasks.push({ text: text, done: false });
            input.value = '';
            render();
            if (!input.disabled) input.focus();
        });

        clear.addEventListener('click', function() {
            tasks = tasks.filter(function(task) { return !task.done; });
            render();
            input.focus();
        });

        // Ending the session is what the real timer does at zero: focus mode
        // closes, the list goes with it, and the question appears under the
        // timer. Starting the next one clears the question.
        toggle.addEventListener('click', function() {
            focusing = !focusing;
            asking = focusing ? null : firstOpen();
            render();
        });

        // The line under the timer: pressing it ticks the task off and the
        // next one takes its place.
        now.addEventListener('click', function() {
            var current = firstOpen();
            if (!current) return;
            current.done = true;
            render();
        });

        function answer(done) {
            if (asking && done) asking.done = true;
            asking = null;
            render();
            toggle.focus();
        }

        yes.addEventListener('click', function() { answer(true); });
        no.addEventListener('click', function() { answer(false); });

        render();
    })();

    // --- The rotation timer, and the duration a single wallpaper can keep ---
    (function timerDemo() {
        var seg = document.getElementById('demo-seg');
        var cards = document.getElementById('demo-cards');
        var hint = document.getElementById('demo-hint');
        if (!seg || !cards || !hint) return;

        var STEPS = [5, 15, 30, 60];
        var rows = Array.prototype.slice.call(cards.querySelectorAll('.demo-card'));
        var globalMinutes = 0;
        var showing = 0;
        var timer = null;

        // Short on a chip, spelled out in a sentence: "after 15m" reads like a
        // spreadsheet, "after 15 minutes" reads like a sentence.
        function label(minutes) {
            return minutes >= 60 ? t('unit_hours_compact', { count: minutes / 60 }) : t('unit_minutes_compact', { count: minutes });
        }

        function spoken(minutes) {
            return minutes >= 60 ? t('duration_hours', { count: minutes / 60 }) : t('duration_minutes', { count: minutes });
        }

        function ownMinutes(row) {
            var n = Number(row.getAttribute('data-own'));
            return STEPS.indexOf(n) === -1 ? null : n;
        }

        function paint() {
            cards.classList.toggle('demo-timer-on', globalMinutes > 0);
            rows.forEach(function(row, i) {
                row.classList.toggle('is-showing', i === showing);
                var chip = row.querySelector('.demo-chip');
                if (!chip) return;
                var own = ownMinutes(row);
                chip.textContent = label(own || globalMinutes || 15);
                chip.classList.toggle('is-own', own !== null);
            });
            paintHint();
        }

        function paintHint() {
            if (globalMinutes === 0) {
                hint.textContent = t('whatsnew_demo_hint_off');
                return;
            }
            var current = rows[showing];
            var own = ownMinutes(current);
            var name = current.getAttribute('data-name');
            // Built as nodes: the wallpaper name is a parameter, never markup.
            hint.replaceChildren(own
                ? tHtml('whatsnew_demo_hint_own_html', { name: name, duration: spoken(own) })
                : tHtml('whatsnew_demo_hint_timer_html', { name: name, duration: spoken(globalMinutes) }));
        }

        function advance() {
            showing = (showing + 1) % rows.length;
            paint();
        }

        function schedule() {
            if (timer) { clearInterval(timer); timer = null; }
            // Compressed to a couple of seconds so the point is visible on a
            // page nobody reads for fifteen minutes. Someone who asked for less
            // movement gets the controls without the carousel.
            if (globalMinutes > 0 && !reduceMotion) timer = setInterval(advance, 2600);
        }

        seg.addEventListener('click', function(e) {
            var btn = e.target.closest('.seg-btn');
            if (!btn) return;
            globalMinutes = Number(btn.getAttribute('data-min')) || 0;
            Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function(b) {
                b.classList.toggle('is-on', b === btn);
            });
            paint();
            schedule();
        });

        cards.addEventListener('click', function(e) {
            var chip = e.target.closest('.demo-chip');
            if (!chip || globalMinutes === 0) return;
            var row = chip.closest('.demo-card');
            var own = ownMinutes(row);
            var next = own === null ? STEPS[0] : STEPS[STEPS.indexOf(own) + 1];
            row.setAttribute('data-own', next === undefined ? '' : String(next));
            paint();
        });

        paint();
    })();

    // --- Searching the bookmarks panel ---
    (function bookmarksDemo() {
        var input = document.getElementById('demo-bm-input');
        var list = document.getElementById('demo-bm-list');
        if (!input || !list) return;

        // Sites most people keep a bookmark for. "git" finds GitHub by name,
        // and "mail" finds Gmail by name and Outlook by its address.
        var ITEMS = [
            { title: 'GitHub', url: 'github.com' },
            { title: 'Gmail', url: 'mail.google.com' },
            { title: 'YouTube', url: 'youtube.com' },
            { title: 'Reddit', url: 'reddit.com' },
            { title: 'Outlook', url: 'outlook.live.com/mail' },
            { title: 'Wikipedia', url: 'wikipedia.org' }
        ];

        function render() {
            var q = input.value.trim().toLowerCase();
            var hits = q
                ? ITEMS.filter(function(it) {
                    return it.title.toLowerCase().indexOf(q) !== -1 || it.url.toLowerCase().indexOf(q) !== -1;
                })
                : ITEMS;

            list.textContent = '';
            if (!hits.length) {
                var empty = document.createElement('div');
                empty.className = 'bm-empty';
                empty.textContent = t('bookmarks_no_match');
                list.appendChild(empty);
                return;
            }
            hits.forEach(function(it) {
                var row = document.createElement('div');
                row.className = 'bm-row';
                var dot = document.createElement('span');
                dot.className = 'bm-dot';
                var name = document.createElement('span');
                name.textContent = it.title;
                var url = document.createElement('span');
                url.className = 'bm-url';
                url.textContent = it.url;
                row.appendChild(dot);
                row.appendChild(name);
                row.appendChild(url);
                list.appendChild(row);
            });
        }

        input.addEventListener('input', render);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && input.value) {
                input.value = '';
                render();
            }
        });
        render();
    })();

    // --- The crossfade, before and after ---
    (function fadeDemo() {
        var stage = document.getElementById('demo-fade-stage');
        var before = document.getElementById('demo-fade-before');
        var after = document.getElementById('demo-fade-after');
        if (!stage || !before || !after) return;

        var resetTimer = null;

        function play(which) {
            if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
            stage.classList.remove('play-before', 'play-after');
            // Force the browser to apply the cleared state before the next one,
            // or the two class changes collapse into no transition at all.
            void stage.offsetWidth;
            stage.classList.add(which);
            resetTimer = setTimeout(function() {
                stage.classList.remove('play-before', 'play-after');
                resetTimer = null;
            }, 2600);
        }

        before.addEventListener('click', function() { play('play-before'); });
        after.addEventListener('click', function() { play('play-after'); });
    })();
})();
