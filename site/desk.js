/* Shared by ANU's pages: reads the site settings (config/*.yaml, published as
   api/v1/config.json) and draws the tab switcher. Pages work with built-in defaults
   when the settings can't load. */
window.ANU = (() => {
  const FALLBACK = {
    desks: [
      { id: "defense", label: "Defense", page: "./", enabled: true },
      { id: "housing", label: "Housing", page: "housing.html", enabled: true },
      { id: "videos", label: "Watch", page: "videos.html", enabled: true },
      { id: "docs", label: "Docs", page: "docs.html", enabled: true },
    ],
    flags: {},
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let cached;
  async function config() {
    cached ??= fetch("api/v1/config.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : FALLBACK))
      .catch(() => FALLBACK);
    return cached;
  }
  /** A flag is on unless the config sets it to false. */
  const flag = (cfg, name) => cfg.flags?.[name] !== false;
  function renderDesks(el, cfg, current) {
    el.innerHTML =
      (cfg.desks || FALLBACK.desks)
        .filter((d) => d.enabled !== false)
        .map((d) => `<a href="${esc(d.page)}"${d.id === current ? ' aria-current="page"' : ""}>${esc(d.label)}</a>`)
        .join("") + '<a class="ask" href="app/">Ask ANU →</a>';
  }
  return { config, flag, renderDesks, esc };
})();
