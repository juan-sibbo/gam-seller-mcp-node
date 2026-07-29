import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { exportJWK, importJWK, type JWK } from "jose";
import { generateDevKeyPair, type KeyPairBundle } from "./jwk.js";
import { keysPath } from "../config/paths.js";

// Persistent RS256 keypair — Fase A (resolves auditoría I-9).
// Ephemeral per-boot keys broke every outstanding token and well-known signature on
// restart, incompatible with the buyer-side cache TTL ratified in e12-signoff §6.
// The private key lives as a JWK file under keys/ (gitignored — hard rule #2).
//
// Rotation (domain2-signoff §5): EMERGENCY rotation in dev = delete the key file and
// restart (new pair, all outstanding tokens die — that is the point of an emergency).
// ponytail: no overlap-window machinery yet; add the two-key validator set when the
// first external consumer exists (periodic cadence is [[por definir]] Fase 1 anyway).

export const DEV_KEYSTORE_PATH = keysPath("node-rs256.private.jwk.json");

export async function loadOrCreateKeyPair(path = DEV_KEYSTORE_PATH): Promise<KeyPairBundle> {
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Missing file — legitimate first boot, generate below
  }

  if (raw !== undefined) {
    // Fail-closed: a corrupt key file must NOT be silently replaced — that would
    // rotate the node identity without an operator act (same posture as denylist).
    let privateJwk: JWK;
    try {
      privateJwk = JSON.parse(raw) as JWK;
      if (privateJwk.kty !== "RSA" || !privateJwk.d || !privateJwk.n || !privateJwk.e) {
        throw new Error("not an RSA private JWK");
      }
    } catch (err) {
      throw new Error(
        `[keystore] Corrupt key file at ${path} — refusing to overwrite (fail-closed). ` +
          `Emergency rotation = delete the file and restart. Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const privateKey = (await importJWK(privateJwk, "RS256")) as CryptoKey;
    // RSA private JWK contains the public components — derive the public JWK from them.
    const publicJwk: JWK = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e };
    const publicKey = (await importJWK(publicJwk, "RS256")) as CryptoKey;
    return { privateKey, publicKey, publicJwk };
  }

  const pair = await generateDevKeyPair();
  const privateJwk = await exportJWK(pair.privateKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(privateJwk, null, 2), "utf-8");
  return pair;
}
