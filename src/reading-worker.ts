import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { config } from "./config.js";
import { ReadingIntake, searchReading } from "./reading.js";
import { log } from "./log.js";
import { prepareReadingShares, readingSharingStatus } from "./reading-sharing.js";

const integer = (name: string, fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).parse(process.env[name] ?? fallback);
const sources = process.env.INKLING_READING_SOURCES_FILE ? z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/).refine(id => !["constructor", "prototype"].includes(id)),
  url: z.url().refine(raw => { const url = new URL(raw); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }),
  minutes: z.number().int().min(15).max(1440), category: z.enum(["tech", "other"]),
})).min(1).max(50).refine(list => new Set(list.map(s => s.id)).size === list.length, "Source IDs must be unique")
  .parse(JSON.parse(readFileSync(process.env.INKLING_READING_SOURCES_FILE, "utf8"))) : undefined;
const mode = process.argv[2] || "run";
if (mode === "search") {
  console.log(JSON.stringify(searchReading(process.argv.slice(3).join(" ")), null, 2));
} else {
  const options = { sources, daily: integer("INKLING_READING_DAILY", 10, 1, 50), browserDaily: integer("INKLING_READING_BROWSER_DAILY", 2, 0, 10),
    timezone: process.env.INKLING_READING_TIMEZONE || "UTC", interests: (process.env.INKLING_READING_INTERESTS || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 30) };
  new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
  if (mode === "status") {
    console.log(JSON.stringify({ ...new ReadingIntake(options).status(), sharing: readingSharingStatus() }, null, 2));
  } else if (mode !== "run" && mode !== "once") {
    throw new Error("Use run, once, status or search");
  } else if (process.env.INKLING_READING_ENABLED !== "true") {
    log.info("reading intake disabled");
  } else {
    const root = path.join(config.dataDir, "reading");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(root, { stale: 120_000, update: 10_000 });
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
    try {
      const intake = new ReadingIntake(options);
      do {
        await intake.tick();
        await prepareReadingShares().catch(() => log.warn("reading share preparation delayed"));
        const status = intake.status();
        log.info({ ...status.counts, articlesAttempted: status.articlesAttempted, modelCalls: status.modelCalls,
          browserAttempts: status.browsers, feedFailures: status.sources.filter(s => s.failures > 0).length }, "reading intake tick");
        if (mode === "once" || stopping) break;
        // Short waits allow prompt shutdown without interrupting an atomic state write.
        for (let i = 0; i < 60 && !stopping; i++) await new Promise(resolve => setTimeout(resolve, 1000));
      } while (!stopping);
    } finally { await release(); }
  }
}
