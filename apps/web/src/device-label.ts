type DeviceNavigator = {
  userAgent: string;
  maxTouchPoints: number;
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ model?: string }> };
};

export function fallbackDeviceLabel(navigator: DeviceNavigator, standalone: boolean, model = ""): string {
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Firefox|FxiOS/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /OPR\//.test(ua) ? "Opera" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  // Older Android browsers may include a model; reduced UAs use the placeholder K.
  const legacyModel = /Android[^;)]*;\s*(?:[a-z]{2}[-_][A-Z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?\)/.exec(ua)?.[1] || "";
  const candidate = (model || (/Android/.test(ua) ? legacyModel : "")).trim().replace(/\s+/g, " ");
  const name = candidate && !/^(K|unknown|generic|mobile)$/i.test(candidate) ? candidate : platform;
  return `${name} · ${browser}${standalone ? " app" : ""}`;
}

export async function detectDeviceLabel(navigator: DeviceNavigator, standalone: boolean, timeoutMS = 500): Promise<string> {
  const fallback = fallbackDeviceLabel(navigator, standalone);
  if (!navigator.userAgentData) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.userAgentData.getHighEntropyValues(["model"]).then(({ model }) => fallbackDeviceLabel(navigator, standalone, model)),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMS); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
