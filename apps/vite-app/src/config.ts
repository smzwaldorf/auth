export const issuer = import.meta.env.VITE_AUTH_ISSUER || "http://localhost:3000/api/auth";
export const authOrigin = new URL(issuer).origin;
export const appBOrigin = import.meta.env.VITE_APP_B_ORIGIN || "http://localhost:4000";
export const directoryResource = `${authOrigin}/api/directory/v1`;
