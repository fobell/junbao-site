import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { AppError } from "../shared/types.js";
const scrypt = promisify(scryptCallback);
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function seal(
  value: unknown,
  scope: string,
  key = config.encryptionKey,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function unseal<T>(
  value: string,
  scope: string,
  key = config.encryptionKey,
): T {
  const [v, iv, tag, body] = value.split(".");
  if (v !== "v1") throw new Error("Unsupported encrypted secret version");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(iv, "base64url"),
  );
  cipher.setAAD(Buffer.from(scope));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(body, "base64url")),
      cipher.final(),
    ]).toString(),
  );
}
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 256)
    throw new AppError("PASSWORD_LENGTH", "密码应为 12–256 个字符");
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function checkPassword(password: string, encoded: string) {
  if (password.length > 256) return false;
  const [v, salt, digest] = encoded.split(":");
  if (v !== "scrypt" || !salt || !digest) return false;
  return equal(
    ((await scrypt(password, salt, 64)) as Buffer).toString("hex"),
    digest,
  );
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Buffer) {
  let bits = "";
  for (const x of bytes) bits += x.toString(2).padStart(8, "0");
  return bits
    .match(/.{1,5}/g)!
    .map((s) => alphabet[parseInt(s.padEnd(5, "0"), 2)])
    .join("");
}
function decode32(s: string) {
  const bits = [...s.toUpperCase()]
    .map((c) => {
      const n = alphabet.indexOf(c);
      if (n < 0) throw new Error("Invalid TOTP secret");
      return n.toString(2).padStart(5, "0");
    })
    .join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((x) => parseInt(x, 2)));
}
export function totp(secret: string, step: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", decode32(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 15;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1e6)
    .toString()
    .padStart(6, "0");
}
export function verifyTotp(
  secret: string,
  code: string,
  lastStep = -1,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1])
    if (step + d > lastStep && equal(totp(secret, step + d), code))
      return step + d;
  return null;
}
export function newTotpSecret() {
  return base32(randomBytes(20));
}
export function safeFilename(s: string) {
  const clean = s
    .normalize("NFKC")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  let name = "";
  for (const c of clean) {
    if (Buffer.byteLength(name + c) > 140) break;
    name += c;
  }
  return !name || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)
    ? `_${name || "untitled"}`
    : name;
}
export function csvCell(s: unknown) {
  let value = String(s ?? "");
  if (/^[=+@\-\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replace(/"/g, '""')}"`;
}
