import { ConvexClient } from "convex/browser";

const url = import.meta.env.VITE_CONVEX_URL;

/**
 * Null when VITE_CONVEX_URL isn't set — the app still runs as the original
 * offline diagram viewer (drop a .mmd, paste source). Only the "generate from
 * YouTube" panel is disabled. Keeps `npm run dev` useful before the backend
 * is provisioned.
 */
export const convex = url ? new ConvexClient(url) : null;
export const backendReady = Boolean(url);
