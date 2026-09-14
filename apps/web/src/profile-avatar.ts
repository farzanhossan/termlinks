let seed: string | undefined;

export function createProfileAvatar(): SVGSVGElement {
  if (!seed) {
    try { seed = localStorage.getItem("termlinks-profile-avatar-v1") || undefined; } catch { /* Storage may be unavailable. */ }
    if (!seed || !/^[a-f0-9]{32}$/.test(seed)) {
      seed = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem("termlinks-profile-avatar-v1", seed); } catch { /* Keep the avatar stable for this page. */ }
    }
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("class", "profile-avatar");
  svg.setAttribute("aria-hidden", "true");
  const hue = parseInt(seed.slice(0, 4), 16) % 360;
  svg.style.background = `hsl(${hue} 24% 90%)`;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (parseInt(seed.charAt(4 + y * 3 + x), 16) % 2 === 0 && !(x === 2 && y === 2)) continue;
      for (const column of x === 2 ? [x] : [x, 4 - x]) {
        const cell = document.createElementNS(ns, "rect");
        cell.setAttribute("x", String(column + 1)); cell.setAttribute("y", String(y + 1));
        cell.setAttribute("width", "1"); cell.setAttribute("height", "1");
        cell.setAttribute("fill", `hsl(${hue} 48% 40%)`);
        svg.append(cell);
      }
    }
  }
  return svg;
}
