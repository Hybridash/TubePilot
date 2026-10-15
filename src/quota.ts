import { QUOTA_FILE, readJson, writeJson } from "./config.js";

// Google's free daily limit. It resets at midnight Pacific time.
export const DAILY_LIMIT = Number(process.env.TUBEPILOT_DAILY_QUOTA || 10000);

// Approximate unit costs from Google's quota table.
export const COST = {
  read: 1,
  write: 50,
  upload: 1600,
  thumbnail: 50,
  analytics: 0, // the Analytics API has its own separate quota
} as const;

type QuotaState = { day: string; used: number };

function pacificDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function load(): QuotaState {
  const s = readJson<QuotaState>(QUOTA_FILE);
  const day = pacificDay();
  return s && s.day === day ? s : { day, used: 0 };
}

export function spend(units: number) {
  const s = load();
  s.used += units;
  writeJson(QUOTA_FILE, s);
}

export function remaining() {
  const s = load();
  return { day: s.day, used: s.used, limit: DAILY_LIMIT, left: Math.max(0, DAILY_LIMIT - s.used) };
}

/** Throws before a call that would blow the daily limit, so we never waste a request. */
export function check(units: number) {
  const r = remaining();
  if (units > r.left) {
    throw new Error(
      `Not enough YouTube quota today: this needs ~${units} units but only ${r.left} of ${r.limit} are left. It resets at midnight Pacific time.`
    );
  }
}
