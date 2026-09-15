// Unit tests for the page's deterministic tools (demo/tools/local-tools.js), run with node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, dateMath, parseDate, runLocalTool } from "../tools/local-tools.js";

const NOW = new Date(2026, 8, 15, 7, 30); // Tuesday 15 September 2026, local time

test("days until Christmas from 15 September 2026", () => {
  assert.equal(dateMath({ operation: "days_between", other_date: "2026-12-25" }, NOW),
    "From Tuesday 15 September 2026 to Friday 25 December 2026 is 101 days (14 weeks and 3 days).");
  assert.equal(dateMath({ operation: "days_between", date: "today", other_date: "2026-10-31" }, NOW),
    "From Tuesday 15 September 2026 to Saturday 31 October 2026 is 46 days (6 weeks and 4 days).");
});

test("past dates, same day, and add_days across a month boundary", () => {
  assert.match(dateMath({ operation: "days_between", other_date: "2026-09-10" }, NOW), /^Thursday 10 September 2026 was 5 days before Tuesday 15 September 2026\.$/);
  assert.equal(dateMath({ operation: "days_between", other_date: "2026-09-15" }, NOW), "Tuesday 15 September 2026 and Tuesday 15 September 2026 are the same day: 0 days.");
  assert.equal(dateMath({ operation: "add_days", days: 16 }, NOW), "Tuesday 15 September 2026 plus 16 days is Thursday 1 October 2026 (2026-10-01).");
  assert.equal(dateMath({ operation: "add_days", date: "2026-03-01", days: -1 }, NOW), "Sunday 1 March 2026 minus 1 days is Saturday 28 February 2026 (2026-02-28).");
  assert.equal(dateMath({ operation: "weekday", date: "2027-01-01" }, NOW), "1 January 2027 is a Friday.");
});

test("bad input is reported, never guessed", () => {
  assert.equal(parseDate("2026-02-30"), null);
  assert.match(dateMath({ operation: "days_between", other_date: "Christmas" }, NOW), /Could not read the date "Christmas"/);
  assert.match(dateMath({ operation: "teleport" }, NOW), /Unknown operation/);
  assert.equal(dateMath({ operation: "add_days", days: 1.5 }, NOW), "add_days needs an integer `days`.");
});

test("calculator handles arithmetic and refuses anything else", () => {
  assert.equal(calculate({ expression: "17 * 23" }), "17 * 23 = 391");
  assert.equal(calculate({ expression: "(1200 - 350) / 4" }), "(1200 - 350) / 4 = 212.5");
  assert.equal(calculate({ expression: "2 ^ 10" }), "2 ^ 10 = 1024");
  assert.equal(calculate({ expression: "0.1 + 0.2" }), "0.1 + 0.2 = 0.3");
  assert.equal(calculate({ expression: "1 / 0" }), "1 / 0 has no finite result.");
  assert.match(calculate({ expression: "process.exit(1)" }), /Only numbers/);
  assert.match(calculate({ expression: "2 +* 3" }), /Could not evaluate/);
});

test("runLocalTool routes by name", () => {
  assert.equal(runLocalTool("calculate", { expression: "6 * 7" }), "6 * 7 = 42");
  assert.equal(runLocalTool("web_search", { query: "x" }), null);
});
