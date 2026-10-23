// What the tour draws over the app while it records: a pointer that follows
// the real mouse (headless Chromium paints none), a ripple on each click, a
// caption naming what is on screen, and full-screen title cards. Injected into
// every page; only the top frame draws.

export const OVERLAY = `(() => {
  if (window.top !== window || window.__tour) return;
  const css = \`
    #tour-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    #tour-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px, -100px); will-change: transform; filter: drop-shadow(0 2px 4px rgba(0,0,0,.55)); }
    #tour-cursor.touch { width: 44px; height: 44px; margin: -22px 0 0 -22px; }
    .tour-ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid rgba(255,255,255,.9); background: rgba(255,255,255,.18); animation: tour-ripple .55s ease-out forwards; }
    @keyframes tour-ripple { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }
    #tour-caption { position: absolute; left: 50%; bottom: 34px; transform: translate(-50%, 18px); opacity: 0; transition: opacity .45s ease, transform .45s ease; padding: 12px 24px 13px; border-radius: 14px; background: rgba(18,18,22,.86); border: 1px solid rgba(255,255,255,.14); backdrop-filter: blur(14px); box-shadow: 0 18px 50px rgba(0,0,0,.5); text-align: center; max-width: 76%; }
    #tour-caption.show { opacity: 1; transform: translate(-50%, 0); }
    #tour-caption.top { bottom: auto; top: 22px; transform: translate(-50%, -18px); }
    #tour-caption.top.show { transform: translate(-50%, 0); }
    #tour-caption .t { color: #fff; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
    #tour-caption .s { color: rgba(255,255,255,.72); font-size: 14px; margin-top: 3px; }
    #tour-card { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 18px; opacity: 0; transition: opacity .6s ease; background: radial-gradient(1200px 700px at 50% 38%, #1d1b29 0%, #0b0b0f 70%); color: #fff; text-align: center; }
    #tour-card.show { opacity: 1; }
    #tour-card img { width: 112px; height: 112px; border-radius: 26px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
    #tour-card h1 { margin: 0; font-size: 64px; font-weight: 750; letter-spacing: -.03em; }
    #tour-card p { margin: 0; font-size: 24px; color: rgba(255,255,255,.72); }
    #tour-card code { margin-top: 10px; font: 500 22px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 12px 22px; border-radius: 12px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); color: #fff; }
    #tour-card small { font-size: 18px; color: rgba(255,255,255,.55); }
  \`;
  const POINTER = '<svg viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><path d="M5 2.5v18.2l4.6-4.4 3 6.6 3.1-1.4-3-6.5 6.4-.3z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const TOUCH = '<svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg"><circle cx="22" cy="22" r="17" fill="rgba(255,255,255,.28)" stroke="rgba(255,255,255,.9)" stroke-width="2"/></svg>';
  const mount = () => {
    if (document.getElementById("tour-layer")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const layer = document.createElement("div");
    layer.id = "tour-layer";
    layer.innerHTML = '<div id="tour-card"></div><div id="tour-caption"><div class="t"></div><div class="s"></div></div><div id="tour-cursor">' + POINTER + '</div>';
    document.documentElement.appendChild(layer);
  };
  let x = -100, y = -100, touch = false;
  const place = () => {
    const c = document.getElementById("tour-cursor");
    if (c) c.style.transform = "translate(" + (x - (touch ? 0 : 5)) + "px," + (y - (touch ? 0 : 3)) + "px)";
  };
  const ripple = () => {
    const layer = document.getElementById("tour-layer");
    if (!layer) return;
    const r = document.createElement("div");
    r.className = "tour-ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    layer.appendChild(r);
    setTimeout(() => r.remove(), 700);
  };
  window.addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; place(); }, true);
  window.addEventListener("mousedown", () => ripple(), true);
  window.__tour = {
    mount,
    at(px, py) { x = px; y = py; place(); },
    tap(px, py) { x = px; y = py; place(); ripple(); },
    touch(on) { touch = on; const c = document.getElementById("tour-cursor"); if (c) { c.classList.toggle("touch", on); c.innerHTML = on ? TOUCH : POINTER; } place(); },
    hideCursor(hidden) { const c = document.getElementById("tour-cursor"); if (c) c.style.opacity = hidden ? "0" : "1"; },
    caption(title, sub, where) {
      const el = document.getElementById("tour-caption");
      if (!el) return;
      el.classList.toggle("top", where === "top");
      el.querySelector(".t").textContent = title;
      el.querySelector(".s").textContent = sub || "";
      el.querySelector(".s").style.display = sub ? "" : "none";
      el.classList.add("show");
    },
    hideCaption() { document.getElementById("tour-caption")?.classList.remove("show"); },
    card(html) { const el = document.getElementById("tour-card"); if (!el) return; el.innerHTML = html; el.classList.add("show"); },
    hideCard() { document.getElementById("tour-card")?.classList.remove("show"); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();`;
