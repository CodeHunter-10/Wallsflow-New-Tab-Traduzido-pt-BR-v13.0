(function() {
    'use strict';

    // ==============================
    // BOOKMARKS WIDGET
    // ==============================

    let widget, btn, dropdown, listEl, searchEl;
    let isOpen = false;
    let treeBuilt = false;
    let outsideClickHandler = null;
    let booted = false;

    // The tree as Chrome handed it over, kept so typing in the search box
    // filters in memory instead of asking Chrome again on every keystroke.
    let rawTree = null;
    let searchTimer = null;
    const SEARCH_DEBOUNCE_MS = 120;
    const SEARCH_MAX_RESULTS = 50;

    // ==============================
    // OPEN / CLOSE
    // ==============================

    function openDropdown() {
        if (!widget || !dropdown) return;
        if (isOpen) return;
        if (!treeBuilt) {
            buildTree();
            treeBuilt = true;
        }
        widget.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        dropdown.setAttribute('aria-hidden', 'false');
        isOpen = true;
        if (searchEl && !searchEl.hidden) searchEl.focus();

        // Attach outside-click handler (deferred so the opening click doesn't close it).
        // Defensive: detach any previous handler first to prevent stacking if openDropdown
        // is called multiple times in rapid succession before the close path runs.
        setTimeout(() => {
            if (outsideClickHandler) {
                document.removeEventListener('click', outsideClickHandler);
            }
            outsideClickHandler = function(e) {
                if (!widget.contains(e.target)) {
                    closeDropdown();
                }
            };
            document.addEventListener('click', outsideClickHandler);
        }, 0);
    }

    function closeDropdown() {
        if (!widget || !dropdown) return;
        widget.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        dropdown.setAttribute('aria-hidden', 'true');
        isOpen = false;
        // A query is transient: the next open starts from the whole tree.
        if (searchEl && searchEl.value) {
            searchEl.value = '';
            renderTree();
        }

        if (outsideClickHandler) {
            document.removeEventListener('click', outsideClickHandler);
            outsideClickHandler = null;
        }
    }

    function toggleDropdown() {
        if (isOpen) closeDropdown();
        else openDropdown();
    }

    // ==============================
    // TREE BUILDING
    // ==============================

    function buildTree() {
        if (!listEl) return;
        listEl.innerHTML = '';
        rawTree = null;

        if (typeof chrome === 'undefined' || !chrome.bookmarks) {
            setSearchAvailable(false);
            renderEmptyState(t('bookmarks_api_unavailable'));
            return;
        }

        chrome.bookmarks.getTree((tree) => {
            if (chrome.runtime.lastError) {
                setSearchAvailable(false);
                renderEmptyState(t('bookmarks_unreadable'));
                return;
            }

            const rootChildren = (tree && tree[0] && tree[0].children) || [];
            if (!rootChildren.length || !hasAnyBookmarkOrFolder(rootChildren)) {
                setSearchAvailable(false);
                renderEmptyState(t('bookmarks_empty'));
                return;
            }

            rawTree = rootChildren;
            setSearchAvailable(true);
            renderTree();
        });
    }

    // Paints the list from the cached tree: the folders as Chrome has them,
    // or a flat list of matches while the search box has a query.
    function renderTree() {
        if (!listEl || !rawTree) return;
        listEl.innerHTML = '';

        const query = searchEl ? searchEl.value.trim() : '';
        if (query) {
            renderMatches(query);
            return;
        }

        const frag = document.createDocumentFragment();
        rawTree.forEach((topFolder) => {
            if (!topFolder.children || topFolder.children.length === 0) return;
            const section = renderFolder(topFolder, 0, true);
            if (section) frag.appendChild(section);
        });

        if (frag.childNodes.length === 0) {
            renderEmptyState(t('bookmarks_empty'));
        } else {
            listEl.appendChild(frag);
        }
    }

    function renderMatches(query) {
        const needle = query.toLowerCase();
        const matches = [];
        const walk = (nodes) => {
            for (const node of nodes) {
                if (matches.length >= SEARCH_MAX_RESULTS) return;
                if (node.url) {
                    const title = (node.title || '').toLowerCase();
                    if (title.includes(needle) || node.url.toLowerCase().includes(needle)) matches.push(node);
                } else if (node.children) {
                    walk(node.children);
                }
            }
        };
        walk(rawTree);

        if (!matches.length) {
            renderEmptyState(t('bookmarks_no_match'), { manageLink: false });
            return;
        }
        const frag = document.createDocumentFragment();
        matches.forEach((node) => {
            const row = renderLink(node, 0);
            if (row) frag.appendChild(row);
        });
        listEl.appendChild(frag);
    }

    function setSearchAvailable(available) {
        if (!searchEl) return;
        searchEl.hidden = !available;
        if (!available) {
            searchEl.value = '';
            return;
        }
        // The tree arrives after the panel opened, so the focus that
        // openDropdown() could not give a hidden box is given here.
        if (isOpen) searchEl.focus();
    }

    function scheduleSearch() {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchTimer = null;
            renderTree();
        }, SEARCH_DEBOUNCE_MS);
    }

    function hasAnyBookmarkOrFolder(nodes) {
        for (const n of nodes) {
            if (n.url) return true;
            if (n.children && hasAnyBookmarkOrFolder(n.children)) return true;
        }
        return false;
    }

    function renderEmptyState(message, { manageLink = true } = {}) {
        const empty = document.createElement('div');
        empty.className = 'bookmarks-empty';
        const msg = document.createElement('div');
        msg.className = 'bookmarks-empty-msg';
        msg.textContent = message;
        empty.appendChild(msg);
        if (!manageLink) {
            listEl.appendChild(empty);
            return;
        }
        // Firefox has no chrome://bookmarks page and no API that opens its
        // Library window, so there the panel says which shortcut opens it.
        if (/firefox/i.test(navigator.userAgent || '')) {
            const hint = document.createElement('div');
            hint.className = 'bookmarks-empty-hint';
            hint.textContent = t('bookmarks_firefox_library_hint');
            empty.appendChild(hint);
            return;
        }
        const link = document.createElement('a');
        link.className = 'bookmarks-empty-link';
        link.textContent = t('bookmarks_open_manager');
        link.href = 'chrome://bookmarks/';
        link.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // chrome.tabs is always defined inside an extension page (MV3
            // surface). The previous `window.open` fallback was unreachable.
            chrome.tabs.create({ url: 'chrome://bookmarks/' });
            closeDropdown();
        });
        empty.appendChild(link);
        listEl.appendChild(empty);
    }

    function renderFolder(node, depth, expandedByDefault) {
        if (!node) return null;

        const folder = document.createElement('div');
        folder.className = 'bookmarks-folder-wrap';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'bookmarks-folder';
        if (expandedByDefault) row.classList.add('expanded');
        row.style.paddingLeft = (12 + depth * 14) + 'px';

        const chevron = document.createElement('span');
        chevron.className = 'material-symbols-outlined chevron';
        chevron.textContent = 'chevron_right';

        const folderIcon = document.createElement('span');
        folderIcon.className = 'material-symbols-outlined bookmarks-row-icon';
        folderIcon.textContent = 'folder';

        const label = document.createElement('span');
        label.className = 'bookmarks-row-label';
        label.textContent = node.title || t('bookmarks_untitled_folder');

        row.appendChild(chevron);
        row.appendChild(folderIcon);
        row.appendChild(label);

        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'bookmarks-children';
        if (expandedByDefault) childrenWrap.classList.add('expanded');

        row.addEventListener('click', function(e) {
            e.stopPropagation();
            const nowExpanded = !row.classList.contains('expanded');
            row.classList.toggle('expanded', nowExpanded);
            childrenWrap.classList.toggle('expanded', nowExpanded);
        });

        if (node.children && node.children.length) {
            node.children.forEach((child) => {
                const childEl = child.url ? renderLink(child, depth + 1) : renderFolder(child, depth + 1, false);
                if (childEl) childrenWrap.appendChild(childEl);
            });
        }

        folder.appendChild(row);
        folder.appendChild(childrenWrap);
        return folder;
    }

    function renderLink(node, depth) {
        if (!node || !node.url) return null;

        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'bookmarks-link';
        link.style.paddingLeft = (12 + depth * 14) + 'px';
        link.title = node.url;

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined bookmarks-row-icon';
        icon.textContent = 'link';

        const label = document.createElement('span');
        label.className = 'bookmarks-row-label';
        label.textContent = node.title || node.url;

        link.appendChild(icon);
        link.appendChild(label);

        link.addEventListener('click', function(e) {
            e.stopPropagation();
            openBookmark(node.url);
        });

        return link;
    }

    // ==============================
    // OPEN URL (respect shortcuts setting)
    // ==============================

    function openBookmark(url) {
        if (!url) return;
        // utils.js (which defines getBookmarksOpenMode) loads before
        // bookmarks.js per the script order in newtabpage.html.
        const mode = getBookmarksOpenMode() || '_blank';
        if (mode === '_self') {
            window.location.assign(url);
        } else {
            window.open(url, '_blank');
        }
        closeDropdown();
    }

    // ==============================
    // BOOT
    // ==============================

    // Invalidate the cached tree when Chrome bookmarks change. Without this,
    // a user who adds/removes a bookmark in another tab keeps seeing stale
    // results from the first dropdown open until the page is reloaded. Cheap
    // listeners — Chrome only fires them on actual mutations.
    function invalidateTreeCache() {
        treeBuilt = false;
        // If the dropdown is currently open, rebuild immediately so the user
        // sees the change right away. Otherwise the next openDropdown() call
        // will pick it up.
        if (isOpen && listEl) {
            buildTree();
            treeBuilt = true;
        }
    }

    function boot() {
        if (booted) return;

        widget = document.getElementById('bookmarks-widget');
        btn = document.getElementById('bookmarks-widget-btn');
        dropdown = document.getElementById('bookmarks-dropdown');
        listEl = document.getElementById('bookmarks-dropdown-list');
        searchEl = document.getElementById('bookmarks-search');

        if (!widget || !btn || !dropdown || !listEl) return;

        booted = true;

        if (searchEl) {
            searchEl.addEventListener('input', scheduleSearch);
        }

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleDropdown();
        });

        // Prevent clicks inside the dropdown from closing it
        dropdown.addEventListener('click', function(e) {
            e.stopPropagation();
        });

        // Escape clears a query first, and closes the panel when there is
        // none to clear.
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape' || !isOpen) return;
            if (searchEl && searchEl.value) {
                searchEl.value = '';
                if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
                renderTree();
                searchEl.focus();
                return;
            }
            closeDropdown();
            btn.focus();
        });

        if (typeof chrome !== 'undefined' && chrome.bookmarks) {
            try {
                chrome.bookmarks.onCreated.addListener(invalidateTreeCache);
                chrome.bookmarks.onRemoved.addListener(invalidateTreeCache);
                chrome.bookmarks.onChanged.addListener(invalidateTreeCache);
                chrome.bookmarks.onMoved.addListener(invalidateTreeCache);
            } catch (_) { /* event API not available — cache stays static */ }
        }
    }

    // Exposed for widgets.js
    window.initializeBookmarksWidget = function() {
        boot();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
