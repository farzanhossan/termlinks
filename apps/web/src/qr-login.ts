import jsQR from "jsqr";

export type QRLogin = { token: string; url?: string };
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

export function parseLoginQR(text: string): QRLogin {
  text = text.trim();
  if (tokenPattern.test(text)) return { token: text };
  if (text.length > 4096) throw new Error("This QR code is too large");
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Scan a Termlinks login QR code"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search) throw new Error("Unsupported portal URL");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("termlinks-token") || "";
  if (fragment.get("v") !== "1" || !tokenPattern.test(token) || fragment.getAll("termlinks-token").length !== 1) throw new Error("Invalid Termlinks login QR code");
  return { token, url: url.href };
}

export function consumeLoginFragment(): QRLogin | undefined {
  if (!new URLSearchParams(location.hash.slice(1)).has("termlinks-token")) return undefined;
  const link = location.href;
  history.replaceState(null, "", location.pathname + location.search);
  return parseLoginQR(link);
}

export function openQRScanner(onScan: (value: QRLogin) => void): void {
  const dialog = document.createElement("dialog");
  dialog.className = "profile-dialog scanner-dialog";
  dialog.setAttribute("aria-label", "Scan Termlinks QR");
  const title = document.createElement("h2"); title.textContent = "Scan Termlinks QR";
  const video = document.createElement("video"); video.playsInline = true; video.muted = true; video.autoplay = true;
  const message = document.createElement("p"); message.setAttribute("role", "status"); message.textContent = "Point your camera at the QR code in your terminal.";
  const start = document.createElement("button"); start.className = "primary-button"; start.textContent = "Start camera";
  const image = document.createElement("input"); image.type = "file"; image.accept = "image/*"; image.setAttribute("aria-label", "Choose a QR image");
  const close = document.createElement("button"); close.className = "ghost-button"; close.textContent = "Cancel";
  let stream: MediaStream | undefined;
  let timer = 0;
  let closed = false;
  let cameraGeneration = 0;
  const stopCamera = (): void => {
    cameraGeneration++;
    window.clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined; video.srcObject = null;
    start.disabled = false;
  };
  const cleanup = (): void => {
    if (closed) return; closed = true; stopCamera();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", cleanup);
    dialog.remove();
  };
  const visibility = (): void => { if (document.hidden) stopCamera(); };
  const accept = (data: string): void => {
    try { const value = parseLoginQR(data); cleanup(); onScan(value); }
    catch (error) { message.textContent = error instanceof Error ? error.message : "Invalid QR code"; }
  };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const decode = (source: CanvasImageSource, width: number, height: number): void => {
    if (!context || !width || !height) return;
    const scale = Math.min(1, 1280 / Math.max(width, height));
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height);
    if (result) accept(result.data);
  };
  start.addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      message.textContent = "Camera scanning needs HTTPS. Choose a QR image or enter the token instead."; return;
    }
    stopCamera(); const generation = cameraGeneration; start.disabled = true;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (closed || document.hidden || generation !== cameraGeneration) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired; video.srcObject = stream; await video.play();
      const scan = (): void => {
        if (closed || !stream || generation !== cameraGeneration) return;
        if (video.readyState >= 2) decode(video, video.videoWidth, video.videoHeight);
        if (!closed) timer = window.setTimeout(scan, 180);
      };
      scan();
    } catch { stopCamera(); message.textContent = "Camera unavailable or permission denied. Choose a QR image or enter the token instead."; }
  });
  image.addEventListener("change", async () => {
    const file = image.files?.[0]; if (!file) return;
    stopCamera();
    if (file.size > 20 * 1024 * 1024) { message.textContent = "Choose an image smaller than 20 MB."; return; }
    const objectURL = URL.createObjectURL(file);
    try {
      const picture = new Image(); picture.src = objectURL; await picture.decode();
      if (closed) return;
      message.textContent = "No valid Termlinks QR found. Try a clearer image.";
      decode(picture, picture.naturalWidth, picture.naturalHeight);
    } catch { message.textContent = "Could not read this image."; }
    finally { URL.revokeObjectURL(objectURL); }
  });
  close.addEventListener("click", cleanup);
  dialog.addEventListener("cancel", cleanup); dialog.addEventListener("close", cleanup);
  document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", cleanup);
  dialog.append(title, video, message, start, image, close); document.body.append(dialog); dialog.showModal();
  start.click();
}
