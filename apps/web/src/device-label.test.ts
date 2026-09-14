import assert from "node:assert/strict";
import { detectDeviceLabel, fallbackDeviceLabel } from "./device-label";

const android = { userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36", maxTouchPoints: 5 };
assert.equal(fallbackDeviceLabel(android, false), "Android · Chrome");
assert.equal(await detectDeviceLabel({ ...android, userAgentData: { getHighEntropyValues: async () => ({ model: "OnePlus 12" }) } }, false), "OnePlus 12 · Chrome");
assert.equal(await detectDeviceLabel({ ...android, userAgentData: { getHighEntropyValues: async () => ({ model: "" }) } }, false), "Android · Chrome");
assert.equal(await detectDeviceLabel({ ...android, userAgentData: { getHighEntropyValues: async () => { throw new Error("Denied"); } } }, false), "Android · Chrome");
assert.equal(await detectDeviceLabel({ ...android, userAgentData: { getHighEntropyValues: () => new Promise(() => {}) } }, false, 5), "Android · Chrome");
assert.equal(await detectDeviceLabel({ ...android, userAgentData: { getHighEntropyValues: () => { throw new Error("Unavailable"); } } }, false), "Android · Chrome");
assert.equal(fallbackDeviceLabel({ ...android, userAgent: android.userAgent.replace("Android 10; K", "Android 12; OnePlus 9 Pro Build/SKQ1") }, false), "OnePlus 9 Pro · Chrome");
assert.equal(await detectDeviceLabel({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 }, true), "iPhone · Safari app");
assert.equal(fallbackDeviceLabel({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", maxTouchPoints: 5 }, false), "iPad · Safari");
assert.equal(fallbackDeviceLabel({ ...android, userAgent: android.userAgent + " EdgA/140.0" }, false), "Android · Edge");
assert.equal(fallbackDeviceLabel({ userAgent: "Unknown", maxTouchPoints: 0 }, false), "Device · Browser");
console.log("Device label tests passed");
