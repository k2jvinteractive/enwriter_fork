// Shared building blocks: link fields (pick characters, places, tags, notes, scenes),
// chip input, the small rich-text editor, and image helpers.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  emw.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Longer text (note bodies, thumbnails) lives in its own file, keyed by id.
  emw.files = { read: (key) => window.api.readChapter(key), write: (key, text) => window.api.writeChapter(key, text) };

  // Reads an image file and returns a resized data URL.
  emw.imageToDataUrl = (file, maxSide = 1000) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/webp', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // ---- link fields ----------------------------------------------------------------
  const sceneName = (s) => s.title.trim() || 'Untitled scene';
  const chapterName = (c) => c.title.trim() || `Chapter ${S.data.chapters.indexOf(c) + 1}`;
  const catName = (kind, id) => S.data.categories[kind].find((c) => c.id === id)?.name || 'Uncategorised';

  const ADAPTERS = {
    scenes: {
      one: 'scene', create: false,
      items: () => S.data.chapters.flatMap((c) => c.scenes.map((s) => ({ id: s.id, name: sceneName(s), group: chapterName(c) }))),
      find: (id) => { const f = S.find.scene(id); return f && { id, name: sceneName(f.scene), group: chapterName(f.chapter) }; }
    }
  };
  for (const kind of S.KINDS) {
    const one = S.KIND_ONE[kind];
    const toItem = (e) => ({ id: e.id, name: e.name || `Unnamed ${one}`, group: catName(kind, e.category), color: e.color, preview: e.preview });
    ADAPTERS[kind] = { one, create: true, items: () => S.data[kind].map(toItem), find: (id) => { const e = S.entity(kind, id); return e && toItem(e); } };
  }

  const fields = [];
  let raf = 0;
  S.on(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; fields.forEach((f) => { if (f.host.isConnected) f.refresh(); }); });
  });

  // opts: { kind, get(): ids, set(ids), list?: bool, disabled?: bool, onOpen?(kind,id), onCreated?(id) }
  emw.linkField = (host, opts) => {
    const ad = ADAPTERS[opts.kind];
    host.classList.add('link-field');
    const items = make('div', opts.list ? 'lf-list' : 'lf-chips');
    const sel = make('select', 'lf-add');
    sel.setAttribute('aria-label', `Add ${ad.one}`);
    host.append(items, sel);

    const open = (id) => {
      if (opts.onOpen) opts.onOpen(opts.kind, id);
      else if (opts.kind === 'scenes') emw.openScene(id);
      else emw.openEntity(opts.kind, id);
    };
    const detach = (id) => opts.set((opts.get() || []).filter((x) => x !== id));

    function itemEl(item) {
      if (opts.list) {
        const row = make('div', 'lf-row');
        const b = make('button', 'lf-open');
        b.type = 'button';
        b.append(make('b', '', item.name), make('span', '', item.preview || ''));
        b.addEventListener('click', () => open(item.id));
        const x = make('button', 'lf-x', '×');
        x.type = 'button';
        x.title = `Remove ${item.name}`;
        x.setAttribute('aria-label', `Remove ${item.name}`);
        x.addEventListener('click', () => detach(item.id));
        row.append(b, x);
        return row;
      }
      const chip = make('span', 'chip');
      if (item.color) { chip.classList.add('colored'); chip.style.setProperty('--tc', item.color); }
      const b = make('button', 'chip-name', item.name);
      b.type = 'button';
      b.title = `Open ${item.name}`;
      b.addEventListener('click', () => open(item.id));
      const x = make('button', 'chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${item.name}`);
      x.addEventListener('click', () => detach(item.id));
      chip.append(b, x);
      return chip;
    }

    const f = {
      host, opts,
      refresh() {
        if (!S.data) return;
        const ids = opts.get() || [];
        items.replaceChildren(...ids.map((id) => ad.find(id)).filter(Boolean).map(itemEl));
        const taken = new Set(ids);
        const groups = new Map();
        for (const it of ad.items()) {
          if (taken.has(it.id)) continue;
          if (!groups.has(it.group)) groups.set(it.group, []);
          groups.get(it.group).push(it);
        }
        const first = make('option', '', `+ Add ${ad.one}…`);
        first.value = '';
        const nodes = [first];
        for (const [name, list] of groups) {
          const g = make('optgroup');
          g.label = name;
          for (const it of list) { const o = make('option', '', it.name); o.value = it.id; g.append(o); }
          nodes.push(g);
        }
        if (ad.create) { const o = make('option', '', `New ${ad.one}…`); o.value = '__new'; nodes.push(o); }
        sel.replaceChildren(...nodes);
        sel.value = '';
        sel.disabled = !!opts.disabled;
      }
    };

    sel.addEventListener('change', async () => {
      const v = sel.value;
      sel.value = '';
      if (!v) return;
      if (v !== '__new') { opts.set([...(opts.get() || []), v]); return; }
      const name = await emw.ask({ message: `Name for the new ${ad.one}`, input: '', okLabel: 'Create' });
      if (!name || !name.trim()) return;
      let id;
      S.batch(`add ${ad.one}`, () => {
        id = S.addEntity(opts.kind, { name: name.trim() });
        opts.set([...(opts.get() || []), id]);
      });
      if (opts.onCreated) opts.onCreated(id);
    });

    fields.push(f);
    f.refresh();
    return f;
  };

  // A row of text chips with a box to add more (used for aliases).
  emw.chipInput = (host, { get, set, placeholder = 'Add and press Enter' }) => {
    host.classList.add('chip-input');
    const chips = make('div', 'lf-chips');
    const input = make('input');
    input.placeholder = placeholder;
    input.spellcheck = false;
    host.append(chips, input);
    const add = () => {
      const v = input.value.trim();
      input.value = '';
      if (v && !(get() || []).includes(v)) set([...(get() || []), v]);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && (get() || []).length) set(get().slice(0, -1));
    });
    input.addEventListener('blur', add);
    const f = {
      host,
      refresh() {
        chips.replaceChildren(...(get() || []).map((v) => {
          const chip = make('span', 'chip');
          chip.append(make('span', 'chip-label', v));
          const x = make('button', 'chip-x', '×');
          x.type = 'button';
          x.setAttribute('aria-label', `Remove ${v}`);
          x.addEventListener('click', () => set(get().filter((a) => a !== v)));
          chip.append(x);
          return chip;
        }));
      }
    };
    fields.push(f);
    f.refresh();
    return f;
  };

  // ---- small rich-text editor ---------------------------------------------------------
  const TOOLS = [
    ['bold', '<b>B</b>', 'Bold'], ['italic', '<i>I</i>', 'Italic'], ['underline', '<u>U</u>', 'Underline'], ['strikeThrough', '<s>S</s>', 'Strikethrough'],
    '|', ['h2', 'Title', 'Title'], ['h3', 'Subtitle', 'Subtitle'], ['quote', '<svg class="ic"><use href="#i-quote"/></svg>', 'Quote'],
    '|', ['insertOrderedList', '<svg class="ic"><use href="#i-ol"/></svg>', 'Numbered list'], ['insertUnorderedList', '<svg class="ic"><use href="#i-ul"/></svg>', 'Bulleted list'],
    ['outdent', '<svg class="ic"><use href="#i-outdent"/></svg>', 'Decrease indent'], ['indent', '<svg class="ic"><use href="#i-indent"/></svg>', 'Increase indent'],
    '|', ['link', '<svg class="ic"><use href="#i-link"/></svg>', 'Insert link'], ['image', '<svg class="ic"><use href="#i-image"/></svg>', 'Insert image']
  ];

  emw.mini = (host, { onInput }) => {
    host.classList.add('mini');
    const bar = make('div', 'mini-bar');
    for (const t of TOOLS) {
      if (t === '|') { bar.append(make('span', 'mini-sep')); continue; }
      const b = make('button', 'rb txt');
      b.type = 'button';
      b.dataset.cmd = t[0];
      b.title = t[2];
      b.innerHTML = t[1];
      bar.append(b);
    }
    const colorLabel = make('label', 'rb color');
    colorLabel.title = 'Text colour';
    colorLabel.innerHTML = '<svg class="ic"><use href="#i-textcolor"/></svg><span class="swatch"></span>';
    const colorIn = make('input');
    colorIn.type = 'color';
    colorIn.value = '#e8caa4';
    colorLabel.append(colorIn);
    colorLabel.querySelector('.swatch').style.setProperty('--c', colorIn.value);
    bar.append(colorLabel);
    const file = make('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    const area = make('div', 'mini-area');
    area.contentEditable = 'true';
    area.spellcheck = true;
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    host.append(bar, area, file);

    let saved = null;
    document.addEventListener('selectionchange', () => {
      const s = getSelection();
      if (s.rangeCount && area.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
    });
    const restore = () => {
      area.focus();
      if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
    };
    const run = (cmd, value = null, css = false) => {
      restore();
      document.execCommand('styleWithCSS', false, css);
      document.execCommand(cmd, false, value);
    };
    const insertImage = async (f) => {
      try {
        const url = await emw.imageToDataUrl(f, 1000);
        run('insertImage', url);
      } catch (err) { emw.toast(err.message); }
    };

    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'h2' || cmd === 'h3') run('formatBlock', `<${cmd}>`);
      else if (cmd === 'quote') run('formatBlock', '<blockquote>');
      else if (cmd === 'image') file.click();
      else if (cmd === 'link') {
        const url = await emw.ask({ message: 'Link address', input: 'https://', okLabel: 'Add link' });
        const href = emw.safeUrl(url === 'https://' ? '' : url);
        if (!href) return;
        restore();
        if (saved && !saved.collapsed) run('createLink', href);
        else run('insertHTML', `<a href="${emw.esc(href)}">${emw.esc(href)}</a>`);
      } else run(cmd);
    });
    colorIn.addEventListener('input', () => colorLabel.querySelector('.swatch').style.setProperty('--c', colorIn.value));
    colorIn.addEventListener('change', () => run('foreColor', colorIn.value, true));
    file.addEventListener('change', () => { if (file.files[0]) insertImage(file.files[0]); file.value = ''; });

    area.addEventListener('input', () => onInput && onInput());
    area.addEventListener('paste', (e) => {
      const img = [...(e.clipboardData.files || [])].find((f) => f.type.startsWith('image/'));
      e.preventDefault();
      if (img) { insertImage(img); return; }
      const html = e.clipboardData.getData('text/html');
      const clean = html ? emw.sanitize(html) : '';
      document.execCommand('styleWithCSS', false, false);
      if (clean) document.execCommand('insertHTML', false, clean);
      else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    area.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    area.addEventListener('drop', (e) => {
      const img = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith('image/'));
      if (!img) return;
      e.preventDefault();
      insertImage(img);
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand(e.shiftKey ? 'outdent' : 'insertText', false, '\t'); }
    });

    return {
      el: area,
      load(html) { area.innerHTML = html || '<p><br></p>'; saved = null; },
      html: () => area.innerHTML,
      text: () => area.innerText,
      focus: () => area.focus()
    };
  };
})();
