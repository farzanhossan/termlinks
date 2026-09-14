import assert from "node:assert/strict";
import { parseLoginQR } from "./qr-login";

const token = "a".repeat(43);
assert.deepEqual(parseLoginQR(token), { token });
const url = `https://portal.example/#termlinks-token=${token}&v=1`;
assert.deepEqual(parseLoginQR(url), { token, url });
assert.equal(new URL(parseLoginQR(url).url!).search, "");
for (const bad of ["", "wrong", "javascript:alert(1)", `https://user:pass@portal.example/#termlinks-token=${token}&v=1`, `https://portal.example/?token=${token}`, url.replace("v=1", "v=2"), `${url}&termlinks-token=${token}`]) {
  assert.throws(() => parseLoginQR(bad));
}
