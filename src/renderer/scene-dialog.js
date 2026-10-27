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
  const colorEl = $('#sd-color');
  const wordsEl = $('#sd-words');

  let id = null;
  const scene = () => S.find.scene(id)?.scene;
  const edit = (patch, key) => S.updateScene(id, patch, { coalesce: `scene:${id}:${key}` });
  const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
  // Following a link from inside the window closes it first.
  const onOpen = (kind, targetId) => { dlg.close(); emw.openEntity(kind, targetId); };

  const link = (host, kind, extra = {}) => emw.linkField($(host), {
    kind, onOpen,
    get: () => scene()?.[S.SCENE_FIELD[kind]],
    set: (ids) => S.updateScene(id, { [S.SCENE_FIELD[kind]]: ids }),
    ...extra
  });
  const fields = [
    link('#sd-characters', 'characters'),
    link('#sd-places', 'places'),
    link('#sd-tags', 'tags'),
    link('#sd-notes', 'notes', { list: true })
  ];

  function fill() {
    const found = S.find.scene(id);
    if (!found) { if (dlg.open) dlg.close(); return; }
    const { scene: s, chapter } = found;
    const plot = S.find.plotline(s.plotline);
    const setValue = (el, v) => { if (document.activeElement !== el) el.value = v; };
    setValue(titleEl, s.title);
    setValue(descEl, s.description);
    plotSel.replaceChildren(...S.data.plotlines.map((p) => option(p.id, p.name || 'Untitled plotline')));
    plotSel.value = s.plotline;
    chapSel.replaceChildren(...S.data.chapters.map((c, i) => option(c.id, c.title.trim() || `Chapter ${i + 1}`)));
    chapSel.value = chapter.id;
    statusSel.value = s.status;
    colorEl.value = s.color || plot.color;
    dlg.style.setProperty('--sc', s.color || plot.color);
    const words = (s.description.match(/\S+/g) || []).length;
    wordsEl.textContent = `Description: ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    fields.forEach((f) => f.refresh());
  }

  emw.openScene = (sceneId, { focusTitle = false } = {}) => {
    id = sceneId;
    fill();
    if (!dlg.open) dlg.showModal();
    if (focusTitle) { titleEl.focus(); titleEl.select(); }
  };

  titleEl.addEventListener('input', () => edit({ title: titleEl.value }, 'title'));
  descEl.addEventListener('input', () => edit({ description: descEl.value }, 'description'));
  plotSel.addEventListener('change', () => S.updateScene(id, { plotline: plotSel.value }));
  statusSel.addEventListener('change', () => S.updateScene(id, { status: statusSel.value }));
  chapSel.addEventListener('change', () => S.moveScene(id, chapSel.value));
  colorEl.addEventListener('input', () => edit({ color: colorEl.value }, 'color'));
  $('#sd-color-reset').addEventListener('click', () => S.updateScene(id, { color: '' }));

  dlg.querySelectorAll('.sd-tabs button').forEach((tab) => tab.addEventListener('click', () => {
    dlg.querySelectorAll('.sd-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    descEl.hidden = tab.dataset.tab !== 'description';
    $('#sd-notes').hidden = tab.dataset.tab !== 'notes';
    if (!descEl.hidden) descEl.focus();
  }));

  $('#sd-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#sd-delete').addEventListener('click', () => { const sceneId = id; dlg.close(); emw.actions.deleteScene(sceneId); });
  $('#sd-duplicate').addEventListener('click', async () => { const sceneId = id; dlg.close(); await emw.actions.duplicateScene(sceneId); });
  $('#sd-open').addEventListener('click', () => { const sceneId = id; dlg.close(); emw.actions.openScene(sceneId); });

  S.on(() => { if (dlg.open) fill(); });
})();
