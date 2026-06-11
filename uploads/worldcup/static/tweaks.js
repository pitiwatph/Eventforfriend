/* tweaks.js — vanilla Tweaks panel speaking the host edit-mode protocol.
   No framework deps so it ships inside the deployable static bundle. */
(function () {
  'use strict';

  // EDITMODE-BEGIN
  const DEFAULTS = {
    "accent": "classic",
    "density": "regular",
    "cardstyle": "solid",
    "headingFont": "kanit"
  };
  // EDITMODE-END

  const LS = 'wc26_tweaks';
  let values = Object.assign({}, DEFAULTS);
  try { Object.assign(values, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}

  // option tables
  const ACCENTS = {
    classic: { gold: '#C9A82C', bright: '#ECCA47', sw: '#C9A82C' },
    amber:   { gold: '#E0A100', bright: '#FFC633', sw: '#E0A100' },
    copper:  { gold: '#C77B3B', bright: '#E89B59', sw: '#C77B3B' },
    lime:    { gold: '#A7B72A', bright: '#CFE34A', sw: '#A7B72A' },
  };
  const HEADING = {
    kanit: "'Kanit', system-ui, sans-serif",
    notothai: "'Noto Sans Thai','Kanit', system-ui, sans-serif",
  };

  function apply() {
    const root = document.documentElement;
    const a = ACCENTS[values.accent] || ACCENTS.classic;
    root.style.setProperty('--gold', a.gold);
    root.style.setProperty('--gold-bright', a.bright);
    root.style.setProperty('--font-display', HEADING[values.headingFont] || HEADING.kanit);
    root.setAttribute('data-density', values.density);
    root.setAttribute('data-cardstyle', values.cardstyle);
  }

  function persist(edits) {
    try { localStorage.setItem(LS, JSON.stringify(values)); } catch (e) {}
    try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*'); } catch (e) {}
  }

  function set(key, val) {
    values[key] = val;
    apply();
    persist({ [key]: val });
    render();
  }

  // ── UI ───────────────────────────────────────────────────────────
  function seg(key, opts) {
    return `<div class="tw-seg">` + opts.map((o) =>
      `<button class="${values[key] === o.v ? 'on' : ''}" onclick="Tweaks.set('${key}','${o.v}')">${o.l}</button>`
    ).join('') + `</div>`;
  }

  function render() {
    const body = document.getElementById('twBody');
    if (!body) return;
    body.innerHTML = `
      <div class="tw-sec">สีหลัก · Accent</div>
      <div class="tw-row">
        <div class="tw-swatches">
          ${Object.entries(ACCENTS).map(([k, a]) =>
            `<div class="tw-sw ${values.accent === k ? 'on' : ''}" style="background:${a.sw}" title="${k}" onclick="Tweaks.set('accent','${k}')"></div>`
          ).join('')}
        </div>
      </div>

      <div class="tw-sec">ความหนาแน่น · Density</div>
      <div class="tw-row">${seg('density', [{ v: 'regular', l: 'ปกติ' }, { v: 'compact', l: 'กระชับ' }])}</div>

      <div class="tw-sec">สไตล์การ์ด · Cards</div>
      <div class="tw-row">${seg('cardstyle', [{ v: 'solid', l: 'ทึบ' }, { v: 'glassy', l: 'กระจก' }])}</div>

      <div class="tw-sec">ฟอนต์หัวข้อ · Heading font</div>
      <div class="tw-row">${seg('headingFont', [{ v: 'kanit', l: 'Kanit' }, { v: 'notothai', l: 'Noto Thai' }])}</div>
    `;
  }

  function toggle() {
    const p = document.getElementById('tweaks');
    const open = p.classList.toggle('open');
    if (!open) { try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {} }
  }

  // host protocol
  window.addEventListener('message', (e) => {
    const t = e && e.data && e.data.type;
    if (t === '__activate_edit_mode') { document.getElementById('tweaks').classList.add('open'); }
    else if (t === '__deactivate_edit_mode') { document.getElementById('tweaks').classList.remove('open'); }
  });
  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}

  // draggable panel
  function makeDraggable() {
    const panel = document.getElementById('tweaks'), head = document.getElementById('twHead');
    if (!panel || !head) return;
    let sx, sy, ox, oy, drag = false;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(8, oy + e.clientY - sy) + 'px';
    });
    head.addEventListener('pointerup', () => (drag = false));
  }

  window.Tweaks = { set, toggle, get: (k) => values[k] };

  document.addEventListener('DOMContentLoaded', () => { apply(); render(); makeDraggable(); });
  apply(); // apply ASAP to avoid flash
})();
