// The scene detail window opened from the Timeline.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const $ = (s) => document.querySelector(s);

  const dlg = $('#scene-dialog');
  const titleEl = $('#sd-title');
  const plotSel = $('#sd-plotline');
  const chapSel = $('#sd-chapter');
  const statusSel = $('#sd-status');
  const descEl = $('#sd-description');
  const notesEl = $('#sd-notes');
  const colorEl = $('#sd-color');
  const wordsEl = $('#sd-words');
  const chipBoxes = [...dlg.querySelectorAll('.chips-field')].map((box) => ({
    field: box.dataset.field, list: box.querySelector('.chips'), input: box.querySelector('input')
  }));

  let id = null;
  const edit = (patch, key) => S.updateScene(id, patch, { coalesce: `scene:${id}:${key}` });
  const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };

  function fillChips(scene) {
    for (const { field, list } of chipBoxes) {
      list.replaceChildren(...scene[field].map((value, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.append(document.createTextNode(value));
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', `Remove ${value}`);
        x.addEventListener('click', () => S.updateScene(id, { [field]: scene[field].filter((_, j) => j !== i) }));
        chip.append(x);
        return chip;
      }));
      const names = new Set();
      for (const ch of S.data.chapters) for (const s of ch.scenes) s[field].forEach((v) => names.add(v));
      $('#dl-' + field).replaceChildren(...[...names].map((n) => option(n, '')));
    }
  }

  function fill() {
    const found = S.find.scene(id);
    if (!found) { if (dlg.open) dlg.close(); return; }
    const { scene, chapter } = found;
    const plot = S.find.plotline(scene.plotline);
    const setValue = (el, v) => { if (document.activeElement !== el) el.value = v; };
    setValue(titleEl, scene.title);
    setValue(descEl, scene.description);
    setValue(notesEl, scene.notes);
    plotSel.replaceChildren(...S.data.plotlines.map((p) => option(p.id, p.name || 'Untitled plotline')));
    plotSel.value = scene.plotline;
    chapSel.replaceChildren(...S.data.chapters.map((c, i) => option(c.id, c.title.trim() || `Chapter ${i + 1}`)));
    chapSel.value = chapter.id;
    statusSel.value = scene.status;
    colorEl.value = scene.color || plot.color;
    dlg.style.setProperty('--sc', scene.color || plot.color);
    const words = (scene.description.match(/\S+/g) || []).length;
    wordsEl.textContent = `Description: ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    fillChips(scene);
  }

  emw.openScene = (sceneId, { focusTitle = false } = {}) => {
    id = sceneId;
    fill();
    if (!dlg.open) dlg.showModal();
    if (focusTitle) { titleEl.focus(); titleEl.select(); }
  };

  titleEl.addEventListener('input', () => edit({ title: titleEl.value }, 'title'));
  descEl.addEventListener('input', () => edit({ description: descEl.value }, 'description'));
  notesEl.addEventListener('input', () => edit({ notes: notesEl.value }, 'notes'));
  plotSel.addEventListener('change', () => S.updateScene(id, { plotline: plotSel.value }));
  statusSel.addEventListener('change', () => S.updateScene(id, { status: statusSel.value }));
  chapSel.addEventListener('change', () => S.moveScene(id, chapSel.value));
  colorEl.addEventListener('input', () => edit({ color: colorEl.value }, 'color'));
  $('#sd-color-reset').addEventListener('click', () => S.updateScene(id, { color: '' }));

  for (const { field, input } of chipBoxes) {
    input.addEventListener('keydown', (e) => {
      const scene = S.find.scene(id)?.scene;
      if (!scene) return;
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = input.value.trim();
        if (v && !scene[field].includes(v)) S.updateScene(id, { [field]: [...scene[field], v] });
        input.value = '';
      } else if (e.key === 'Backspace' && !input.value && scene[field].length) {
        S.updateScene(id, { [field]: scene[field].slice(0, -1) });
      }
    });
  }

  dlg.querySelectorAll('.sd-tabs button').forEach((tab) => tab.addEventListener('click', () => {
    dlg.querySelectorAll('.sd-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    descEl.hidden = tab.dataset.tab !== 'description';
    notesEl.hidden = tab.dataset.tab !== 'notes';
    (descEl.hidden ? notesEl : descEl).focus();
  }));

  $('#sd-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#sd-delete').addEventListener('click', () => {
    const sceneId = id;
    dlg.close();
    emw.actions.deleteScene(sceneId);
  });
  $('#sd-duplicate').addEventListener('click', async () => {
    const sceneId = id;
    dlg.close();
    await emw.actions.duplicateScene(sceneId);
  });
  $('#sd-open').addEventListener('click', () => { const sceneId = id; dlg.close(); emw.actions.openScene(sceneId); });

  S.on(() => { if (dlg.open) fill(); });
})();
