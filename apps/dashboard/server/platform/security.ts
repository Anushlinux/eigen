import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { PlatformError } from "./types.js";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function encrypt(value: string, key: string) {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32)
    throw new Error("EIGEN_TOKEN_KEY must be a base64-encoded 32-byte key.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64",
  );
}
export function decrypt(value: string, key: string) {
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]).toString();
}
export function validWebhook(body: string, signature: string, secret: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return (
    Buffer.byteLength(signature) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
export function safeRepoPath(path: string) {
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === ".git" ||
          part === "node_modules" ||
          part === ".env" ||
          part.startsWith(".env."),
      ) ||
    path.startsWith(".github/workflows/") ||
    [...path].some((character) => character.charCodeAt(0) < 32)
  )
    throw new PlatformError(400, "Unsupported repository file path.");
  return path;
}
export function redact(message: string) {
  return message
    .replace(/(?:sk-|gh[opusr]_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(0, 6000);
}
