import { generateKeyPair, exportJWK, importJWK, type JWK } from "jose";

export interface KeyPairBundle {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
}

// Generate an ephemeral RS256 key pair for dev/test.
// PRODUCTION: load from a file outside the repo (keys/ is gitignored).
// Tests: always generate ephemeral — never write keys to disk in tests.
export async function generateDevKeyPair(): Promise<KeyPairBundle> {
  // jose 6 generates NON-extractable keys by default; the keystore must export the
  // private key to a JWK file to persist identity across reboots (I-9), so RS256 keys
  // must be extractable. This restores jose 5's default behavior explicitly.
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicKey, publicJwk };
}

// JWK set format — e12-discovery-trust-anchor-signoff.md §4:
// same key family as domain-2 signs the well-known document.
export function makeJwkSet(publicJwk: JWK): { keys: JWK[] } {
  return { keys: [{ ...publicJwk, use: "sig", alg: "RS256" }] };
}

// Re-import a JWK public key (used in validator when rotating keys)
export async function importPublicJwk(jwk: JWK): Promise<CryptoKey> {
  return importJWK(jwk, "RS256") as Promise<CryptoKey>;
}
