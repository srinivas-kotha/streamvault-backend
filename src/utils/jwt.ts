import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config";
import type { TokenPayload } from "../types/api.types";

// RFC 7519 §4.1.7: `jti` ensures each signed token is unique even when iat/exp
// collide at the 1-second JWT precision. Without it, a refresh called within the
// same clock second as login produced byte-identical tokens → identical sha256
// hash → unique-constraint violation on sv_refresh_tokens.token_hash_key.
export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessExpiresIn,
    jwtid: crypto.randomUUID(),
  });
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
    jwtid: crypto.randomUUID(),
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwt.secret) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as TokenPayload;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
