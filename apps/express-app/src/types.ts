export type AuthUser = { sub: string; name?: string; email?: string; picture?: string; iss?: string };
export type AccessContext = { sub: string; clientId: string; access: "active"; roles: string[]; classScopes: { parent: string[]; teacher: string[]; effective: string[] } };
export type SessionData = { oidcFlow?: { codeVerifier: string; state: string; nonce: string }; user?: AuthUser; idToken?: string; accessToken?: string; refreshToken?: string };
