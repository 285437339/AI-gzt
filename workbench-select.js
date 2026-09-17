(() => {
  'use strict';
  // Keep the existing selects and change handlers as the data source. Only the
  // popup is replaced, so dynamically rendered canvas controls work as well.
  if (!HTMLElement.prototype.showPopover) return;
  const popup = document.createElement('div');
  popup.className = 'workbench-select-popup';
  popup.setAttribute('popover', 'manual');
  const search = document.createElement('input');
  search.className = 'workbench-select-search';
  search.type = 'search';
  search.placeholder = '搜索选项…';
  search.setAttribute('aria-label', '搜索下拉选项');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-expanded', 'true');
  const list = document.createElement('div');
  list.className = 'workbench-select-options';
  list.id = 'workbench-select-options';
  list.setAttribute('role', 'listbox');
  search.setAttribute('aria-controls', list.id);
  const paging = document.createElement('div');
  paging.className = 'workbench-select-paging';
  const previous = document.createElement('button'), next = document.createElement('button');
  previous.type = next.type = 'button'; previous.textContent = '上一页'; next.textContent = '更多选项';
  paging.append(previous, next);
  popup.append(search, list, paging);
  let owner = null, entries = [], matches = [], active = -1, start = 0;
  let previousExpanded = null, previousControls = null;
  let typeAhead = '', typeAheadAt = 0;
  const PAGE_SIZE = 60;
  const usable = element => element instanceof HTMLSelectElement && !element.disabled && !element.multiple && element.size <= 1;
  const observer = new MutationObserver(() => {
    if (!owner?.isConnected || owner.disabled) return close(false);
    readOptions();
    filterOptions();
  });

  function close(restoreFocus = true) {
    const select = owner;
    if (!select) return;
    owner = null;
    observer.disconnect();
    popup.hidePopover();
    for (const [name, value] of [['aria-expanded', previousExpanded], ['aria-controls', previousControls]]) {
      if (value === null) select.removeAttribute(name); else select.setAttribute(name, value);
    }
    if (restoreFocus && select.isConnected) select.focus({preventScroll: true});
    entries = []; matches = [];
  }

  function readOptions() {
    entries = Array.from(owner.options, (option, index) => ({
      index, option, text: option.label || option.textContent || '',
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
    })).filter(entry => !entry.option.hidden && !entry.option.parentElement.hidden);
  }

  function filterOptions() {
    const query = search.value.trim().toLocaleLowerCase();
    matches = entries.filter(entry => !query || (entry.text + ' ' + entry.group).toLocaleLowerCase().includes(query));
    active = matches.findIndex(entry => entry.index === owner.selectedIndex && !entry.disabled);
    if (active < 0) active = matches.findIndex(entry => !entry.disabled);
    start = Math.max(0, Math.floor(Math.max(active, 0) / PAGE_SIZE) * PAGE_SIZE);
    render();
  }

  function render() {
    const fragment = document.createDocumentFragment();
    let group = '';
    for (let i = start; i < Math.min(matches.length, start + PAGE_SIZE); i++) {
      const entry = matches[i];
      if (entry.group && entry.group !== group) {
        const heading = document.createElement('div');
        heading.className = 'workbench-select-group'; heading.textContent = entry.group;
        heading.setAttribute('role', 'presentation'); fragment.append(heading);
      }
      group = entry.group;
      const option = document.createElement('button');
      option.type = 'button'; option.tabIndex = -1; option.className = 'workbench-select-option';
      option.id = 'workbench-select-option-' + entry.index;
      option.dataset.matchIndex = String(i); option.textContent = entry.text || '（未选择）';
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(entry.index === owner.selectedIndex));
      option.setAttribute('aria-posinset', String(i + 1)); option.setAttribute('aria-setsize', String(matches.length));
      option.disabled = entry.disabled; option.classList.toggle('is-active', i === active); fragment.append(option);
    }
    if (!matches.length) {
      const empty = document.createElement('div'); empty.className = 'workbench-select-empty';
      empty.textContent = '没有匹配的选项'; empty.setAttribute('role', 'status'); fragment.append(empty);
    }
    list.replaceChildren(fragment);
    paging.hidden = matches.length <= PAGE_SIZE;
    previous.disabled = start === 0; next.disabled = start + PAGE_SIZE >= matches.length;
    if (active >= start && active < start + PAGE_SIZE) {
      search.setAttribute('aria-activedescendant', 'workbench-select-option-' + matches[active].index);
    } else search.removeAttribute('aria-activedescendant');
  }

  function open(select) {
    close(false); owner = select;
    previousExpanded = select.getAttribute('aria-expanded'); previousControls = select.getAttribute('aria-controls');
    select.setAttribute('aria-expanded', 'true'); select.setAttribute('aria-controls', list.id);
    select.focus({preventScroll: true});
    (select.closest('dialog') || document.body).append(popup);
    search.value = ''; typeAhead = ''; readOptions(); filterOptions();
    const rect = select.getBoundingClientRect(), margin = 8;
    const width = Math.min(Math.max(rect.width, 250), innerWidth - margin * 2);
    const below = innerHeight - rect.bottom - margin, above = rect.top - margin;
    const down = below >= Math.min(300, above), space = Math.max(80, down ? below : above);
    const height = Math.min(360, space);
    popup.style.width = width + 'px'; popup.style.maxHeight = height + 'px';
    popup.style.left = Math.max(margin, Math.min(rect.left, innerWidth - width - margin)) + 'px';
    popup.style.top = down ? rect.bottom + 4 + 'px' : 'auto';
    popup.style.bottom = down ? 'auto' : innerHeight - rect.top + 4 + 'px';
    list.style.maxHeight = Math.max(34, height - 95) + 'px';
    popup.showPopover(); list.scrollTop = 0; search.focus({preventScroll: true});
    list.querySelector('.is-active')?.scrollIntoView({block: 'nearest'});
    observer.observe(select, {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label', 'hidden', 'value', 'selected']});
  }

  function choose(index) {
    const select = owner, entry = matches[index];
    if (!select?.isConnected || select.disabled) return close(false);
    if (!entry || entry.disabled || entry.option.disabled || entry.option.parentElement.disabled || !select.contains(entry.option)) return;
    const changed = select.selectedIndex !== entry.index;
    select.selectedIndex = entry.index; close();
    if (changed) {
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }

  function move(direction, edge) {
    let next = edge === 'first' ? 0 : edge === 'last' ? matches.length - 1 : active + direction;
    while (next >= 0 && next < matches.length && matches[next].disabled) next += direction;
    if (next < 0 || next >= matches.length) return;
    active = next; start = Math.floor(active / PAGE_SIZE) * PAGE_SIZE;
    render(); list.querySelector('.is-active')?.scrollIntoView({block: 'nearest'});
  }

  search.addEventListener('input', event => { event.stopPropagation(); filterOptions(); list.scrollTop = 0; });
  search.addEventListener('change', event => event.stopPropagation());
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-match-index]');
    if (option) choose(Number(option.dataset.matchIndex));
  });
  // Bound DOM size even when thousands of templates have been imported.
  function changePage(direction) {
    start = Math.max(0, Math.min(Math.floor((matches.length - 1) / PAGE_SIZE) * PAGE_SIZE, start + direction * PAGE_SIZE));
    active = matches.findIndex((entry, index) => index >= start && index < start + PAGE_SIZE && !entry.disabled);
    render(); list.scrollTop = 0; search.focus({preventScroll: true});
  }
  previous.onclick = () => changePage(-1); next.onclick = () => changePage(1);
  popup.addEventListener('keydown', event => {
    if (!owner) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close();}
    else if (event.key === 'Enter') {event.preventDefault(); choose(active);}
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1);}
    else if ((event.key === 'Home' || event.key === 'End') && event.ctrlKey) {event.preventDefault(); move(event.key === 'Home' ? 1 : -1, event.key === 'Home' ? 'first' : 'last');}
    else if (event.key === 'Tab') {close();}
  });
  document.addEventListener('pointerdown', event => {
    const select = event.target.closest('select');
    if (usable(select) && event.button === 0) {
      event.preventDefault(); event.stopPropagation();
      if (owner === select) close(); else open(select);
    } else if (owner && !popup.contains(event.target)) close(false);
  }, true);
  // Prevent compatibility mouse events from opening a second, native popup.
  document.addEventListener('mousedown', event => {
    if (usable(event.target.closest('select')) && event.button === 0) event.preventDefault();
  }, true);
  document.addEventListener('click', event => {
    const select = event.target.closest('select');
    if (usable(select)) {event.preventDefault(); if (event.detail === 0) open(select);}
  }, true);
  document.addEventListener('keydown', event => {
    const select = event.target.closest('select');
    if (!usable(select)) return;
    if (['ArrowDown', 'ArrowUp', ' ', 'Enter', 'F4'].includes(event.key)) {
      event.preventDefault(); open(select);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); const now = Date.now();
      const query = (now - typeAheadAt < 700 ? typeAhead : '') + event.key;
      open(select); typeAhead = query; typeAheadAt = now; search.value = query; filterOptions();
    }
  }, true);
  document.addEventListener('scroll', event => {if (owner && !popup.contains(event.target)) close(false);}, true);
  window.addEventListener('resize', () => close(false));
  window.addEventListener('blur', () => close(false));
})();
