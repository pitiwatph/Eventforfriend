/* flags.js — team flag rendering. Emoji is DISABLED by request: flags are
   pre-defined images (URLs from the team registry) with a clean monogram
   fallback when no image is set or an image fails to load. */
(function () {
  // mutable registry: team name -> flag (image URL). Filled from GET /teams.
  const REG = {};
  const norm = (s) => (s || '').toString().trim().toLowerCase();

  window.setTeamFlags = function (list) {
    (list || []).forEach((t) => { REG[norm(t.name)] = t.flag || ''; });
  };
  window.teamRegistryFlag = function (name) { return REG[norm(name)] || ''; };
  // admin auto-fill suggestion (registry URL, or '')
  window.suggestFlag = function (name) { return REG[norm(name)] || ''; };

  function monogram(name) {
    const parts = (name || '?').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }
  window.teamMonogram = monogram;

  function isUrl(s) {
    return typeof s === 'string' && /^(https?:\/\/|data:image\/|blob:|\/|\.\.?\/)/i.test(s.trim());
  }
  window.isFlagUrl = isUrl;

  // flagHTML(name, override?) — override is a per-match stored flag (URL).
  // Resolution: explicit override URL → registry URL → monogram. No emoji.
  window.flagHTML = function (name, override) {
    let src = (override == null ? '' : String(override)).trim();
    if (!isUrl(src)) src = REG[norm(name)] || '';   // fall back to registry image
    if (isUrl(src)) {
      const safe = src.replace(/"/g, '&quot;');
      const mono = monogram(name);
      return `<span class="flag flag-img"><img src="${safe}" alt="${(name || '').replace(/"/g, '&quot;')}" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('img-fail');this.parentNode.dataset.mono='${mono}';this.remove();"></span>`;
    }
    return `<span class="flag mono-flag">${monogram(name) || '⚽'}</span>`;
  };
})();
