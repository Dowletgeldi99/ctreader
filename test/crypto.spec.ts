import { describe, expect, it } from "vitest";
import {
  createAgentToken,
  createPairingCode,
  decryptSecret,
  encryptSecret,
  hashSecret,
  secretsEqual,
} from "../src/common/crypto";

describe("crypto helpers", () => {
  it("creates human-safe pairing codes", () => {
    const code = createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("creates unique opaque agent tokens", () => {
    const first = createAgentToken();
    const second = createAgentToken();
    expect(first).toMatch(/^mt5_[A-Za-z0-9_-]{40,}$/);
    expect(first).not.toBe(second);
  });

  it("hashes secrets with a server-side pepper", () => {
    expect(hashSecret("token", "pepper-a")).not.toBe(hashSecret("token", "pepper-b"));
  });

  it("compares secrets without accepting prefixes", () => {
    expect(secretsEqual("same", "same")).toBe(true);
    expect(secretsEqual("same", "same-but-longer")).toBe(false);
    expect(secretsEqual("same", "diff")).toBe(false);
  });

  it("encrypts OAuth tokens with authenticated encryption", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("secret-access-token", key);
    expect(encrypted).not.toContain("secret-access-token");
    expect(decryptSecret(encrypted, key)).toBe("secret-access-token");
  });

  it("rejects a modified encrypted OAuth token", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("secret-access-token", key);
    const parts = encrypted.split(":");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] ^= 1;
    parts[3] = ciphertext.toString("base64url");
    const modified = parts.join(":");
    expect(() => decryptSecret(modified, key)).toThrow();
  });
});
