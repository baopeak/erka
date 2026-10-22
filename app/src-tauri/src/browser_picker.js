// Design mode for Erka's browser pane, injected into every page (main frame) before its own
// scripts. While on, hovering outlines an element and clicking it reports the element — its
// selector, text, trimmed HTML, allowlisted attributes (secret-looking values redacted), box
// and key styles — to Erka. The report travels as a window.open() of a sentinel URL that
// Erka intercepts and cancels, carrying a per-page nonce the page cannot read: no IPC is
// exposed to the page, and no navigation (or beforeunload prompt) happens.
(() => {
  if (window.top !== window || window.__erkaDesign) return;
  const NONCE = "__ERKA_NONCE__";
  const open = window.open.bind(window);
  const B64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const send = (kind, data) => open(`http://erka-pick.invalid/#${NONCE}.${B64(JSON.stringify({ kind, data }))}`, "_blank");

  const SECRET_NAME = /(token|secret|passw|api[-_]?key|session|csrf|xsrf|auth|signature|sig$|credential|cookie)/i;
  const SECRET_VALUE = /^(?:[A-Za-z0-9+/_-]{32,}={0,2}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
  const ATTR = /^(id|class|name|type|role|href|src|alt|title|placeholder|for|action|method|data-testid|aria-[\w-]+)$/;
  const STYLES = ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "margin", "padding", "border", "border-radius", "width", "height", "gap", "opacity"];
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

  /** Query strings lose the values of secret-looking parameters. */
  const scrubUrl = (u) => {
    try {
      const url = new URL(u, location.href);
      for (const [k, v] of [...url.searchParams]) if (SECRET_NAME.test(k) || SECRET_VALUE.test(v)) url.searchParams.set(k, "[redacted]");
      if (/access_token|id_token/.test(url.hash)) url.hash = "#[redacted]";
      return url.toString();
    } catch {
      return u;
    }
  };
  const scrubValue = (name, v) => (SECRET_NAME.test(name) || SECRET_VALUE.test(v) ? "[redacted]" : name === "href" || name === "src" || name === "action" ? scrubUrl(v) : clip(v, 300));

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  function selectorOf(el) {
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 7; cur = cur.parentElement) {
      if (cur !== el && cur.id && unique(`#${CSS.escape(cur.id)}`)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let p = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => !/^(hover|active|focus|is-|has-)/.test(c)).slice(0, 2);
      if (cls.length) p += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(p);
      if (unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  }
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");

  function payload(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attributes = {};
    for (const a of el.attributes) if (ATTR.test(a.name)) attributes[a.name] = scrubValue(a.name, a.value);
    const ancestors = [];
    for (let p = el.parentElement; p && p !== document.body && ancestors.length < 8; p = p.parentElement) ancestors.push(describe(p));
    const nearby = [];
    for (const s of [el.previousElementSibling, el.nextElementSibling, el.parentElement]) {
      const t = s && s !== el && (s.innerText || "").trim();
      if (t) nearby.push(clip(t.replace(/\s+/g, " "), 160));
    }
    return {
      page: { url: scrubUrl(location.href), title: document.title, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY },
      selector: clip(selectorOf(el), 700),
      tag: el.tagName.toLowerCase(),
      element: describe(el),
      text: clip((el.innerText || el.textContent || "").trim().replace(/\s+\n/g, "\n"), 400),
      html: clip(el.outerHTML.replace(/\s(value|data-[\w-]*token[\w-]*)="[^"]*"/gi, ' $1="[redacted]"'), 4096),
      attributes,
      ancestors,
      nearby,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      styles: Object.fromEntries(STYLES.map((k) => [k, cs.getPropertyValue(k)])),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: clip(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "", 200),
    };
  }

  let on = false;
  let box = null;
  let tag = null;
  let current = null;
  const isOurs = (n) => n === box || n === tag;
  function ensureBox() {
    if (box) return;
    box = document.createElement("div");
    tag = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6cb6ff;background:rgba(108,182,255,.14);border-radius:3px;display:none;box-sizing:border-box";
    tag.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;background:#6cb6ff;color:#0b0d12;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:3px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis";
    document.documentElement.append(box, tag);
  }
  function show(el) {
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = `${describe(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${r.top > 22 ? r.top - 20 : r.bottom + 2}px` });
  }
  const target = (e) => {
    const el = (e.composedPath ? e.composedPath()[0] : e.target) || null;
    return el && el.nodeType === 1 && !isOurs(el) ? el : null;
  };
  const onMove = (e) => {
    const el = target(e);
    if (el && el !== current) show(el);
  };
  const swallow = (e) => {
    if (!on) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e) => {
    swallow(e);
    const el = target(e) || current;
    if (el) send("pick", payload(el));
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      swallow(e);
      set(false);
      send("cancel", null);
    }
  };
  function set(next) {
    if (next === on) return;
    on = next;
    ensureBox();
    const opts = { capture: true };
    for (const [type, fn] of [["mousemove", onMove], ["click", onClick], ["mousedown", swallow], ["mouseup", swallow], ["pointerdown", swallow], ["keydown", onKey]]) {
      if (on) window.addEventListener(type, fn, opts);
      else window.removeEventListener(type, fn, opts);
    }
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) {
      box.style.display = "none";
      tag.style.display = "none";
      current = null;
    }
  }
  Object.defineProperty(window, "__erkaDesign", { value: Object.freeze({ set }), configurable: false });

  // A link meant for a new window (target=_blank, Ctrl/Shift/middle click) opens here, in the
  // same pane, as an ordinary navigation: a browser pane has no other windows. (Scripted
  // window.open calls arrive as "popup" events and open here too.) Bubble phase, so a page
  // handling the click itself (preventDefault) keeps it.
  const newWindowLink = (e) => {
    if (on || e.defaultPrevented || (e.type === "click" && e.button !== 0) || (e.type === "auxclick" && e.button !== 1)) return;
    const a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || !/^https?:/i.test(a.href)) return;
    const t = (a.getAttribute("target") || "").toLowerCase();
    if ((t && !["_self", "_parent", "_top"].includes(t)) || e.ctrlKey || e.metaKey || e.shiftKey || e.type === "auxclick") {
      e.preventDefault();
      // On the next task, once this click's dispatch is over.
      const href = a.href;
      setTimeout(() => { window.location.href = href; }, 0);
    }
  };
  window.addEventListener("click", newWindowLink);
  window.addEventListener("auxclick", newWindowLink);
})();
