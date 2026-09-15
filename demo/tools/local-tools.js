// Deterministic tools the page runs itself: date arithmetic and a calculator.
// A language model counts days and multiplies in its head badly; these give it
// something to call instead. Pure functions, no DOM, unit-tested with node.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const LOCAL_TOOL_DEFS = {
  date_math: {
    type: "function",
    name: "date_math",
    description:
      "Exact calendar arithmetic in the user's time zone. Use it for how many days until or since a " +
      "date, what date is N days from a date, or which weekday a date falls on. Never count days " +
      "yourself. Dates are YYYY-MM-DD; omit `date` (or pass \"today\") for today.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["days_between", "add_days", "weekday"] },
        date: { type: "string", description: "Start date YYYY-MM-DD, or \"today\" (default)." },
        other_date: { type: "string", description: "End date YYYY-MM-DD for days_between." },
        days: { type: "integer", description: "Days to add for add_days (negative to go back)." },
      },
      required: ["operation"],
    },
  },
  calculate: {
    type: "function",
    name: "calculate",
    description:
      "Exact arithmetic. Use it for any calculation with numbers instead of working it out yourself. " +
      "Accepts + - * / % ^ and parentheses, e.g. \"17 * 23\" or \"(1200 - 350) / 4\".",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "The arithmetic expression." } },
      required: ["expression"],
    },
  },
};

/** @param {Date} d */
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
/** @param {number} y @param {number} m @param {number} d */
const longDate = (y, m, d) => `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
/** @param {number} y @param {number} m @param {number} d */
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Parse "YYYY-MM-DD" (or today/now/empty) into local calendar parts, or null.
 *  @param {unknown} value @param {Date} now @returns {[number, number, number] | null} */
export function parseDate(value, now = new Date()) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text || text === "today" || text === "now") return ymd(now);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return [y, mo, d];
}

/** Whole days from one calendar date to another (DST-safe: counted in UTC). */
const daysBetween = ([y1, m1, d1], [y2, m2, d2]) => Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);

/** @param {{operation?: string, date?: string, other_date?: string, days?: number}} args @param {Date} [now] */
export function dateMath(args, now = new Date()) {
  const op = String(args?.operation || "").toLowerCase();
  const start = parseDate(args?.date, now);
  if (!start) return `Could not read the date ${JSON.stringify(args?.date)}; give it as YYYY-MM-DD.`;
  const [y, m, d] = start;
  if (op === "days_between" || op === "days_until") {
    const end = parseDate(args?.other_date, now);
    if (!end) return `Could not read the date ${JSON.stringify(args?.other_date)}; give it as YYYY-MM-DD.`;
    const n = daysBetween(start, end);
    const from = longDate(y, m, d);
    const to = longDate(...end);
    if (n === 0) return `${from} and ${to} are the same day: 0 days.`;
    const span = Math.abs(n);
    const weeks = Math.floor(span / 7);
    const rest = span % 7;
    const detail = weeks ? ` (${weeks} week${weeks === 1 ? "" : "s"}${rest ? ` and ${rest} day${rest === 1 ? "" : "s"}` : ""})` : "";
    return n > 0
      ? `From ${from} to ${to} is ${n} days${detail}.`
      : `${to} was ${span} days before ${from}${detail}.`;
  }
  if (op === "add_days") {
    const days = Number(args?.days);
    if (!Number.isInteger(days)) return "add_days needs an integer `days`.";
    const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
    const [y2, m2, d2] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    const verb = days >= 0 ? `plus ${days} days` : `minus ${-days} days`;
    return `${longDate(y, m, d)} ${verb} is ${longDate(y2, m2, d2)} (${iso(y2, m2, d2)}).`;
  }
  if (op === "weekday") return `${d} ${MONTHS[m - 1]} ${y} is a ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}.`;
  return `Unknown operation ${JSON.stringify(args?.operation)}; use days_between, add_days or weekday.`;
}

/** @param {{expression?: string}} args */
export function calculate(args) {
  const expr = String(args?.expression ?? "").trim();
  if (!expr) return "No expression given.";
  if (!/^[\d\s+\-*/().%^]+$/.test(expr)) return "Only numbers, + - * / % ^ and parentheses are supported.";
  let value;
  try {
    // The allowlist above admits no identifiers, so this can only compute arithmetic.
    value = Function(`"use strict"; return (${expr.replace(/\^/g, "**")});`)();
  } catch {
    return `Could not evaluate ${JSON.stringify(expr)}.`;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return `${expr} has no finite result.`;
  return `${expr} = ${Number(value.toPrecision(12))}`;
}

/** Run one of the local tools by name; null when the name is not ours.
 *  @param {string} name @param {Record<string, unknown>} args @param {Date} [now] */
export function runLocalTool(name, args, now = new Date()) {
  if (name === "date_math") return dateMath(/** @type {any} */ (args), now);
  if (name === "calculate") return calculate(/** @type {any} */ (args));
  return null;
}
