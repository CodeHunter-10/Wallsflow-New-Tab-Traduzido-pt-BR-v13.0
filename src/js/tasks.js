(function() {
    'use strict';

    // ==============================
    // TASKS
    // ==============================
    // A short checklist for Pomodoro focus sessions. It is drawn only while
    // focus mode is on, to the left of the timer: a new tab is a glance, and a
    // focus session is the stretch of time someone set aside to work through
    // the list. The first unfinished task is the one being worked on. It is
    // written under the timer, where pressing it ticks it off, and when a
    // focus session ends the timer asks about it.
    //
    // A row has three verbs: tick it, change it, or put it first. A full notes
    // editor was considered and rejected.

    const MAX_TASKS = 50;
    const MAX_TASK_LEN = 120;
    // Written to the question key by pomodoro.js when a session ends. That file
    // loads before this one, and a session that finished while every tab was
    // closed completes during its boot, before this list can say which task is
    // first. So it leaves this marker, and whichever tab reads it first turns
    // it into the id of the task that was current.
    const ASK_CURRENT = 'current';

    let widget = null;
    let list = null;
    let input = null;
    let foot = null;
    let doneCount = null;
    let clearDoneBtn = null;
    let statusEl = null;
    let askEl = null;
    let askText = null;
    let nowEl = null;
    let nowText = null;
    let booted = false;

    let _tasksCache = null;
    // The row being edited, if any. A redraw would destroy the editor, so
    // anything that redraws from outside (another tab, a setting) waits.
    let editing = null;
    // Where focus should land after the next redraw. Rows are rebuilt on every
    // change, so focus is restored by id rather than by element.
    let pendingFocus = null;

    // ------------------------------
    // Data
    // ------------------------------

    function newId() {
        try {
            if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch (_) { /* fall through to the timestamp id */ }
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    }

    // One line, trimmed, capped. Enforced on every write and every read, not
    // just by the input's maxlength: a restored backup never passes through
    // the input.
    function cleanText(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_LEN);
    }

    // Whatever comes out of storage is untrusted. The importer checks only that
    // this key holds a string, never what the JSON inside it says, so a hand
    // edited or foreign file can carry any shape at all. The cap is load
    // bearing: without it a file with ten thousand entries would build ten
    // thousand rows and freeze the page.
    function normalizeTasks(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        const seen = new Set();
        for (const item of raw) {
            if (out.length >= MAX_TASKS) break;
            if (!item || typeof item !== 'object') continue;
            const text = cleanText(item.text);
            if (!text) continue;
            let id = (typeof item.id === 'string' && item.id) ? item.id : newId();
            // Two rows sharing an id would make deleting one remove the other.
            if (seen.has(id)) id = newId();
            seen.add(id);
            out.push({
                id,
                text,
                done: item.done === true,
                createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
            });
        }
        return out;
    }

    function getTasks() {
        if (_tasksCache) return _tasksCache;
        let raw = null;
        try { raw = JSON.parse(safeGet(STORAGE_KEYS.TASKS) || '[]'); } catch (_) { raw = null; }
        _tasksCache = normalizeTasks(raw);
        return _tasksCache;
    }

    // The cache follows the write, as savePlaylists does: a list the browser
    // refused to store must not look saved for the rest of this tab's life and
    // be gone in the next one.
    function saveTasks(next) {
        const ok = safeSet(STORAGE_KEYS.TASKS, JSON.stringify(next));
        if (ok) {
            _tasksCache = next;
        } else {
            showPush(t('tasks_toast_save_failed'), 'warning');
        }
        return ok;
    }

    // Every change goes through here: edit a copy, save it, and redraw from
    // the cache whatever happened. When the write is refused the redraw paints
    // the unchanged list, so the edit visibly undoes itself instead of looking
    // saved and quietly vanishing on the next tab.
    function mutate(fn) {
        const next = getTasks().map((task) => ({ ...task }));
        fn(next);
        const ok = saveTasks(next);
        render();
        return ok;
    }

    // The task being worked on is simply the first one not yet done, so
    // choosing what to work on is the same act as putting it first.
    function firstOpen(tasks) {
        return tasks.find((task) => !task.done) || null;
    }

    function announce(message) {
        if (!statusEl) return;
        statusEl.textContent = message;
    }

    // ------------------------------
    // Actions
    // ------------------------------

    function addTask(value) {
        const text = cleanText(value);
        if (!text) return false;
        if (getTasks().length >= MAX_TASKS) return false;
        const ok = mutate((tasks) => {
            tasks.push({ id: newId(), text, done: false, createdAt: Date.now() });
        });
        if (ok) announce(t('tasks_announce_added'));
        return ok;
    }

    // The row stays where it is. Sinking finished items to the bottom would
    // move rows out from under a pointer about to tick the next one, and the
    // order someone chose is information.
    function toggleTask(id, { fromKeyboard = false } = {}) {
        if (fromKeyboard) pendingFocus = id;
        return mutate((tasks) => {
            const task = tasks.find((task) => task.id === id);
            if (task) task.done = !task.done;
        });
    }

    function promoteTask(id, { fromKeyboard = false } = {}) {
        const index = getTasks().findIndex((task) => task.id === id);
        if (index <= 0) return false;
        if (fromKeyboard) pendingFocus = id;
        const ok = mutate((tasks) => {
            const [task] = tasks.splice(index, 1);
            tasks.unshift(task);
        });
        if (ok) announce(t('tasks_announce_moved_top'));
        return ok;
    }

    function deleteTask(id, { fromKeyboard = false } = {}) {
        const tasks = getTasks();
        const index = tasks.findIndex((task) => task.id === id);
        if (index === -1) return false;
        if (fromKeyboard) {
            // Focus goes to the next row, the one before if this was the last,
            // or the add box when nothing is left.
            const neighbour = tasks[index + 1] || tasks[index - 1];
            pendingFocus = neighbour ? neighbour.id : 'input';
        }
        const ok = mutate((next) => { next.splice(index, 1); });
        if (ok) announce(t('tasks_announce_deleted'));
        return ok;
    }

    function clearDone() {
        const count = getTasks().filter((task) => task.done).length;
        if (!count) return 0;
        const ok = mutate((tasks) => {
            for (let i = tasks.length - 1; i >= 0; i -= 1) {
                if (tasks[i].done) tasks.splice(i, 1);
            }
        });
        if (!ok) return 0;
        announce(t('tasks_announce_cleared', { count }));
        return count;
    }

    function clearAll() {
        const ok = mutate((tasks) => { tasks.length = 0; });
        if (ok) announce(t('tasks_toast_all_deleted'));
        return ok;
    }

    // ------------------------------
    // The question after a focus session
    // ------------------------------

    // Shared through storage, so every open tab shows the same question and
    // answering it in one answers it in all of them.
    function renderAsk() {
        if (!askEl || !askText) return;
        let id = safeGet(STORAGE_KEYS.TASKS_ASK);
        const tasks = getTasks();
        if (id === ASK_CURRENT) {
            const current = firstOpen(tasks);
            if (current) {
                id = current.id;
                safeSet(STORAGE_KEYS.TASKS_ASK, id);
            }
        }
        const task = id ? tasks.find((task) => task.id === id && !task.done) : null;
        if (!task) {
            // Answered in another tab, ticked or deleted by hand, or there was
            // nothing left to do when the session ended.
            if (id) safeRemove(STORAGE_KEYS.TASKS_ASK);
            askEl.hidden = true;
            askText.textContent = '';
            return;
        }
        askText.textContent = t('tasks_ask_done', { task: task.text });
        askEl.hidden = false;
    }

    function answerAsk(done) {
        const id = safeGet(STORAGE_KEYS.TASKS_ASK);
        let hadFocus = false;
        try {
            hadFocus = !!(document.activeElement && typeof askEl.contains === 'function' && askEl.contains(document.activeElement));
        } catch (_) { hadFocus = false; }

        safeRemove(STORAGE_KEYS.TASKS_ASK);
        if (done && id && id !== ASK_CURRENT) {
            // Set rather than toggled: a Yes must never untick a task.
            mutate((tasks) => {
                const task = tasks.find((task) => task.id === id);
                if (task) task.done = true;
            });
        }
        renderAsk();

        // The buttons just vanished. A keyboard user lands on the timer's own
        // start button instead of at the top of the page.
        if (hadFocus) {
            const start = document.getElementById('pomo-start');
            if (start && typeof start.focus === 'function') start.focus();
        }
    }

    // ------------------------------
    // The task under the timer
    // ------------------------------

    // The one line on the focus screen besides the time. A single button:
    // pressing it ticks the task off and the next one takes its place, so the
    // list on the left never has to be read during a session.
    function renderNow() {
        if (!nowEl || !nowText) return;
        const current = firstOpen(getTasks());
        if (!current) {
            nowEl.hidden = true;
            nowEl.setAttribute('data-id', '');
            nowText.textContent = '';
            return;
        }
        const changed = nowEl.getAttribute('data-id') !== current.id;
        nowEl.setAttribute('data-id', current.id);
        nowEl.setAttribute('aria-label', t('tasks_now_aria', { task: current.text }));
        nowEl.title = t('tasks_now_title');
        nowText.textContent = current.text;
        nowEl.hidden = false;
        // Replaying the entrance when another task takes over makes the change
        // visible without anything moving under the pointer.
        if (changed) {
            nowText.classList.remove('is-new');
            void nowText.offsetWidth;
            nowText.classList.add('is-new');
        }
    }

    function tickNow() {
        const id = nowEl && nowEl.getAttribute('data-id');
        const task = id ? getTasks().find((task) => task.id === id && !task.done) : null;
        if (!task) return false;
        // Set rather than toggled, like Yes: this button only ever finishes.
        const ok = mutate((tasks) => {
            const found = tasks.find((x) => x.id === id);
            if (found) found.done = true;
        });
        if (ok) announce(t('tasks_announce_done', { task: task.text }));
        // With nothing left, the button is gone; the add box is where the next
        // task comes from.
        if (nowEl.hidden && input && !input.disabled && typeof input.focus === 'function') input.focus();
        return ok;
    }

    // ------------------------------
    // Drawing
    // ------------------------------

    // Built with createElement and textContent only. Task text is typed by the
    // user or restored from a file, and it never goes near innerHTML.
    function buildRow(task, isCurrent) {
        const row = document.createElement('li');
        row.className = 'tasks-row' + (task.done ? ' is-done' : '') + (isCurrent ? ' is-current' : '');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', task.done ? 'true' : 'false');
        row.setAttribute('aria-label', isCurrent ? t('tasks_row_current_aria', { task: task.text }) : task.text);
        row.setAttribute('tabindex', '0');
        row.setAttribute('data-id', task.id);

        const check = document.createElement('span');
        check.className = 'tasks-check';
        check.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'tasks-text';
        text.textContent = task.text;

        row.appendChild(check);
        row.appendChild(text);

        // Both buttons stay out of the tab order: one stop per row, and the
        // keyboard has its own way to do each (Alt and the up arrow, Delete).
        if (!task.done && !isCurrent) {
            const promote = document.createElement('button');
            promote.className = 'tasks-promote';
            promote.type = 'button';
            promote.setAttribute('tabindex', '-1');
            const promoteLabel = t('tasks_promote_title');
            promote.setAttribute('aria-label', promoteLabel);
            promote.title = promoteLabel;
            promote.textContent = '↑';
            row.appendChild(promote);
        }

        const del = document.createElement('button');
        del.className = 'tasks-delete';
        del.type = 'button';
        del.setAttribute('tabindex', '-1');
        del.setAttribute('aria-label', t('tasks_delete_aria'));
        del.textContent = '×';
        row.appendChild(del);

        return row;
    }

    function render() {
        if (!list) return;
        const tasks = getTasks();
        const done = tasks.filter((task) => task.done).length;
        const current = firstOpen(tasks);

        list.replaceChildren();

        if (tasks.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'tasks-empty';
            empty.textContent = t('tasks_empty');
            list.appendChild(empty);
        }

        for (const task of tasks) {
            list.appendChild(buildRow(task, !!current && task.id === current.id));
        }

        if (foot) foot.hidden = done === 0;
        if (doneCount) doneCount.textContent = t('tasks_done_count', { count: done });

        if (input) {
            const full = tasks.length >= MAX_TASKS;
            input.disabled = full;
            input.placeholder = full ? t('tasks_list_full_placeholder', { count: MAX_TASKS }) : t('tasks_add_a_task_placeholder');
        }

        if (pendingFocus) {
            const target = pendingFocus;
            pendingFocus = null;
            const row = target === 'input'
                ? null
                : list.querySelector(`.tasks-row[data-id="${target}"]`);
            if (row) row.focus();
            else if (input && !input.disabled) input.focus();
        }

        renderAsk();
        renderNow();
    }

    // ------------------------------
    // Editing a row in place
    // ------------------------------

    function startEdit(id) {
        const row = list && list.querySelector(`.tasks-row[data-id="${id}"]`);
        const task = getTasks().find((task) => task.id === id);
        const label = row && row.querySelector('.tasks-text');
        if (!row || !task || !label || editing) return;

        const field = document.createElement('input');
        field.className = 'tasks-edit';
        field.type = 'text';
        field.setAttribute('maxlength', String(MAX_TASK_LEN));
        field.setAttribute('aria-label', t('tasks_edit_aria'));
        field.value = task.text;

        let settled = false;
        // `viaKey` decides whether focus comes back to the row afterwards.
        // Leaving the field with the mouse means the user is already somewhere
        // else, and pulling focus back would fight them.
        const finish = (commit, viaKey) => {
            if (settled) return;
            settled = true;
            editing = null;
            if (!commit) {
                if (viaKey) pendingFocus = id;
                render();
                return;
            }
            const text = cleanText(field.value);
            if (!text) {
                // Emptying a task is how you delete it while editing, so there
                // is no second delete control to find inside the editor.
                deleteTask(id, { fromKeyboard: viaKey });
                return;
            }
            if (viaKey) pendingFocus = id;
            if (text === task.text) {
                render();
                return;
            }
            mutate((tasks) => {
                const found = tasks.find((x) => x.id === id);
                if (found) found.text = text;
            });
        };

        field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true, true);
            } else if (e.key === 'Escape') {
                // Focus mode exits on Escape. Cancelling an edit must not also
                // end the session.
                e.preventDefault();
                e.stopPropagation();
                finish(false, true);
            }
        });
        field.addEventListener('blur', () => finish(true, false));
        field.addEventListener('click', (e) => { e.stopPropagation(); });

        row.insertBefore(field, label);
        label.remove();
        row.classList.add('is-editing');
        editing = { id, field };
        field.focus();
        if (typeof field.select === 'function') field.select();
    }

    function focusSibling(row, delta) {
        const rows = Array.from(list.querySelectorAll('.tasks-row'));
        const next = rows[rows.indexOf(row) + delta];
        if (next) next.focus();
        else if (delta > 0 && input && !input.disabled) input.focus();
    }

    // ------------------------------
    // Boot
    // ------------------------------

    function boot() {
        if (booted) return;
        widget = document.getElementById('tasks-widget');
        list = document.getElementById('tasks-list');
        input = document.getElementById('tasks-add');
        if (!widget || !list || !input) return;
        foot = document.getElementById('tasks-foot');
        doneCount = document.getElementById('tasks-done-count');
        clearDoneBtn = document.getElementById('tasks-clear-done');
        statusEl = document.getElementById('tasks-status');
        askEl = document.getElementById('pomo-ask');
        askText = document.getElementById('pomo-ask-text');
        nowEl = document.getElementById('pomo-now');
        nowText = document.getElementById('pomo-now-text');
        booted = true;

        // One listener for every row: the text edits, the arrow puts the task
        // first, the cross deletes, and anywhere else on the row ticks it,
        // which gives the small ring a target the size of the whole line.
        list.addEventListener('click', (e) => {
            const row = e.target && e.target.closest ? e.target.closest('.tasks-row') : null;
            if (!row || row.classList.contains('is-editing')) return;
            const id = row.getAttribute('data-id');
            if (e.target.closest('.tasks-delete')) { deleteTask(id); return; }
            if (e.target.closest('.tasks-promote')) { promoteTask(id); return; }
            if (e.target.closest('.tasks-text')) { startEdit(id); return; }
            toggleTask(id);
        });

        // Keys are handled on the widget rather than the document, so this
        // only ever reacts while focus is inside the list.
        widget.addEventListener('keydown', (e) => {
            const target = e.target;
            if (!target || !target.classList) return;
            // The row editor answers its own keys.
            if (target.classList.contains('tasks-edit')) return;

            if (target === input) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    // Kept in the box when the save is refused, so a full disk
                    // does not also cost the user what they typed.
                    if (addTask(input.value)) input.value = '';
                } else if (e.key === 'Escape') {
                    // Stopped here because focus mode exits on Escape, and
                    // clearing a half typed task must not end the session. The
                    // first press clears the box, the second leaves it, and
                    // only a third, from outside the box, exits focus mode.
                    e.stopPropagation();
                    if (input.value) input.value = '';
                    else if (typeof input.blur === 'function') input.blur();
                }
                return;
            }

            if (!target.classList.contains('tasks-row')) return;
            const id = target.getAttribute('data-id');
            switch (e.key) {
                case ' ':
                case 'Enter':
                    e.preventDefault();
                    toggleTask(id, { fromKeyboard: true });
                    break;
                case 'F2':
                    e.preventDefault();
                    startEdit(id);
                    break;
                case 'Delete':
                case 'Backspace':
                    e.preventDefault();
                    deleteTask(id, { fromKeyboard: true });
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    focusSibling(target, 1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (e.altKey) promoteTask(id, { fromKeyboard: true });
                    else focusSibling(target, -1);
                    break;
                default:
                    break;
            }
        });

        if (clearDoneBtn) {
            clearDoneBtn.addEventListener('click', (e) => {
                e.preventDefault();
                clearDone();
            });
        }

        const askYes = document.getElementById('pomo-ask-yes');
        const askNo = document.getElementById('pomo-ask-no');
        if (askYes) askYes.addEventListener('click', (e) => { e.preventDefault(); answerAsk(true); });
        if (askNo) askNo.addEventListener('click', (e) => { e.preventDefault(); answerAsk(false); });

        if (nowEl) nowEl.addEventListener('click', (e) => { e.preventDefault(); tickNow(); });

        // Another tab changed the list or the question. The list waits while a
        // row is being edited here, so typing is never thrown away; the
        // question lives outside the list and is redrawn either way.
        window.addEventListener('storage', (e) => {
            if (!e) return;
            if (e.key === STORAGE_KEYS.TASKS) {
                _tasksCache = null;
                if (!editing) {
                    render();
                } else {
                    renderAsk();
                    renderNow();
                }
            } else if (e.key === STORAGE_KEYS.TASKS_ASK) {
                renderAsk();
            }
        });

        render();
    }

    // Settings and the Pomodoro timer reach the list through these, the same
    // way other modules share state across files here.
    window.initializeTasksWidget = boot;
    window.wfGetTasks = function() { return getTasks().map((task) => ({ ...task })); };
    window.wfRenderTasks = function() { if (!editing) render(); };
    window.wfTasksRenderAsk = function() { renderAsk(); };
    window.wfClearAllTasks = clearAll;
    window.wfNormalizeTasks = normalizeTasks;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
