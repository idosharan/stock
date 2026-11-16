/**
 * סריקת חדשות: מושך כותרות מ-RSS של עיתונות כלכלית ישראלית, מסנן לפי שם המניה
 * ומעריך סנטימנט בסיסי לפי מילות מפתח (חיובי/שלילי) כדי לאמוד השפעה אפשרית.
 */
import Parser from "rss-parser";
import { GEO_FEEDS, NEWS_FEEDS, type StockDef } from "./config.js";
import type { Candle } from "./data.js";
import { sma, trendChangeSetup, type TrendChangeSetup } from "./indicators.js";

const parser = new Parser({ timeout: 15000 });

export interface NewsItem {
  source: string;
  title: string;
  link?: string;
  pubDate?: string;
  /** ניקוד סנטימנט: חיובי > 0, שלילי < 0 (משוקלל לפי כותרת וטריות). */
  sentiment: number;
  /** גיל הכתבה בשעות — null כשאין תאריך פרסום. */
  ageHours: number | null;
}

const POSITIVE_WORDS = [
  "זינוק",
  "מזנקת",
  "עלייה",
  "עולה",
  "רווח",
  "שיא",
  "צמיחה",
  "המלצת קנייה",
  "שדרוג",
  "חוזה",
  "עסקה",
  "דיבידנד",
  "הכנסות שיא",
  "מפתיעה לטובה",
  "התרחבות",
];

const NEGATIVE_WORDS = [
  "צניחה",
  "צונחת",
  "ירידה",
  "יורדת",
  "הפסד",
  "אזהרת רווח",
  "המלצת מכירה",
  "הורדת דירוג",
  "חקירה",
  "תביעה",
  "פיטורים",
  "מאכזבת",
  "קריסה",
  "אזהרה",
];

function scoreSentiment(text: string): number {
  let score = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) score -= 1;
  return score;
}

/** משקל טריות: כתבה מהיממים האחרונים משפיעה יותר מכתבה בת שלושה ימים. */
function recencyWeight(ageHours: number | null): number {
  if (ageHours == null) return 0.8;
  if (ageHours <= 12) return 1.5;
  if (ageHours <= 24) return 1.2;
  if (ageHours <= 72) return 0.8;
  return 0.4;
}

function parseAgeHours(pubDate?: string): number | null {
  if (!pubDate) return null;
  const t = Date.parse(pubDate);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

/** מושך את כל פריטי החדשות מכל הפידים. */
export async function fetchAllNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  await Promise.all(
    NEWS_FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        for (const entry of parsed.items ?? []) {
          const title = (entry.title ?? "").trim();
          if (!title) continue;
          const snippet = entry.contentSnippet ?? "";
          const ageHours = parseAgeHours(entry.pubDate);
          // הכותרת משקפת את עיקר המסר — משקל כפול מגוף הכתבה
          const rawScore = scoreSentiment(title) * 1.5 + scoreSentiment(snippet) * 0.5;
          items.push({
            source: feed.name,
            title,
            link: entry.link,
            pubDate: entry.pubDate,
            sentiment: Number((rawScore * recencyWeight(ageHours)).toFixed(2)),
            ageHours,
          });
        }
      } catch (err) {
        console.warn(`אזהרה: כשל במשיכת פיד ${feed.name}: ${(err as Error).message}`);
      }
    })
  );
  return items;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** World headlines for the geopolitical index (some feeds reject requests without a browser User-Agent). */
export async function fetchGeoNews(): Promise<NewsItem[]> {
  const batches = await Promise.all(
    GEO_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const parsed = await parser.parseString(await res.text());
        return (parsed.items ?? []).flatMap((entry): NewsItem[] => {
          const title = (entry.title ?? "").trim();
          return title ? [{ source: feed.name, title, link: entry.link, pubDate: entry.pubDate, sentiment: 0, ageHours: parseAgeHours(entry.pubDate) }] : [];
        });
      } catch (err) {
        console.warn(`אזהרה: כשל במשיכת פיד ${feed.name}: ${(err as Error).message}`);
        return [];
      }
    })
  );
  return batches.flat();
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((n) => {
    const key = n.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface StockNews {
  items: NewsItem[];
  /** סך הסנטימנט עבור המניה. */
  totalSentiment: number;
  /** כותרות שליליות מהיומיים האחרונים — התראה מיידית על החזקה. */
  freshNegative: NewsItem[];
}

/**
 * מסנן כתבות הרלוונטיות למניה לפי שם תצוגה ומילים נרדפות.
 */
export function matchNewsForStock(
  allNews: NewsItem[],
  stockName: string,
  aliases: string[] = []
): StockNews {
  const keys = [stockName, ...aliases].map((k) => k.trim()).filter(Boolean);
  const items = allNews.filter((n) => keys.some((k) => n.title.includes(k)));
  const totalSentiment = Number(items.reduce((s, n) => s + n.sentiment, 0).toFixed(2));
  const freshNegative = items.filter((n) => n.sentiment < 0 && (n.ageHours ?? 999) <= 48);
  return { items, totalSentiment, freshNegative };
}

/* -------- Followed creators (YouTube RSS): new videos, mentions, and their chart method -------- */
/* Feed text is untrusted — rendered escaped, never executed. */

export interface FollowedChannel {
  name: string;
  channelId: string;
}

export interface CreatorVideo {
  channel: string;
  id: string;
  title: string;
  published: string;
  url: string;
  /** The per-video part of the description (boilerplate removed); empty when the creator left a placeholder. */
  blurb: string;
  chapters: string[];
  isNew?: boolean;
  /** Where the entry came from; "channel" = title and approximate date only (no description). */
  source?: "rss" | "watch" | "channel";
}

export interface CreatorMention {
  symbol: string;
  name: string;
  tracked: boolean;
  held: boolean;
  videoIds: string[];
}

const XML_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return XML_ENTITY[code.toLowerCase()] ?? match;
  });
}

const xmlTag = (block: string, name: string): string => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeXml(m[1]).trim() : "";
};

const VIDEO_MARKER = "על הסרטון הזה:";
/** Channel boilerplate blocks of the description (intro, course, free-channel list, scam warning, links, disclaimer, hashtags). */
const BOILERPLATE_BLOCK = /^(?:🎓|🏆|📈|🛡|🌐|⚠|🎙|💼|#|אני מיכה)/u;
const CHAPTER_LINE = /\d{1,2}:\d{2}(?::\d{2})?\s*-\s/;

/**
 * Per-video part of a Micha-style description. Old layout: between "על הסרטון הזה:" and the next "⸻".
 * Layout since November 2026: the "⸻" block that is not channel boilerplate (preferably the one with chapters).
 */
export function splitDescription(description: string): { blurb: string; chapters: string[] } {
  const start = description.indexOf(VIDEO_MARKER);
  let raw: string;
  if (start >= 0) {
    const rest = description.slice(start + VIDEO_MARKER.length);
    const end = rest.indexOf("⸻");
    raw = end >= 0 ? rest.slice(0, end) : rest;
  } else {
    if (!description.includes("⸻")) return { blurb: "", chapters: [] };
    const blocks = description.split("⸻").map((b) => b.trim()).filter((b) => b && !BOILERPLATE_BLOCK.test(b));
    raw = blocks.find((b) => CHAPTER_LINE.test(b)) ?? blocks[0] ?? "";
  }
  const own = raw.replace(/\s+/g, " ").trim();
  if (!own || own.startsWith("[")) return { blurb: "", chapters: [] };
  const parts = own.split(/\s(?=\d{1,2}:\d{2}(?::\d{2})?\s*-\s)/);
  return {
    blurb: parts[0].trim(),
    chapters: parts.slice(1).map((p) => p.trim()).filter(Boolean),
  };
}

export function parseYoutubeFeed(xml: string, channel: string): CreatorVideo[] {
  const videos: CreatorVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const id = xmlTag(block, "yt:videoId");
    const title = xmlTag(block, "title");
    if (!/^[\w-]{6,20}$/.test(id) || !title) continue;
    const { blurb, chapters } = splitDescription(xmlTag(block, "media:description"));
    videos.push({ channel, id, title, published: xmlTag(block, "published"), url: `https://www.youtube.com/watch?v=${id}`, blurb, chapters, source: "rss" });
  }
  return videos;
}

/** English so the channel page gives relative dates as "3 days ago". */
const YOUTUBE_HEADERS = { "User-Agent": BROWSER_UA, "Accept-Language": "en" };
/** He publishes daily and the report shows seven days. */
const CHANNEL_PAGE_VIDEOS = 10;
/** Watch pages answer 429 after a burst — only videos without a cached description are fetched, one at a time. */
const MAX_WATCH_FETCHES = 6;
/** The whole feed step shares one 30-second collection slot. */
const FEED_BUDGET_MS = 22_000;

async function youtubeText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { headers: YOUTUBE_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`status ${res.status}`);
  }
  return res.text();
}

const jsonText = (raw: string | undefined): string => {
  if (raw == null) return "";
  try {
    return String(JSON.parse(`"${raw}"`));
  } catch {
    return "";
  }
};

const AGO_MS: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

function agoToIso(label: unknown, nowMs: number): string {
  const m = typeof label === "string" ? /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(label) : null;
  return m ? new Date(nowMs - Number(m[1]) * AGO_MS[m[2].toLowerCase()]).toISOString() : "";
}

/**
 * Videos listed on a channel's /videos page, newest first: id, title and a date derived from "N days ago".
 * Reads both page layouts (lockupViewModel and the older videoRenderer). No descriptions on this page.
 */
export function parseChannelPage(html: string, channel: string, nowMs: number): CreatorVideo[] {
  const raw = /<script[^>]*id="yt-initial-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
    ?? /ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html)?.[1];
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const videos = new Map<string, CreatorVideo>();
  const add = (id: unknown, title: unknown, age: unknown): void => {
    if (typeof id !== "string" || !/^[\w-]{6,20}$/.test(id) || typeof title !== "string" || !title || videos.has(id)) return;
    videos.set(id, { channel, id, title, published: agoToIso(age, nowMs), url: `https://www.youtube.com/watch?v=${id}`, blurb: "", chapters: [], source: "channel" });
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, any>;
    const lockup = o.lockupViewModel;
    if (lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const meta = lockup.metadata?.lockupMetadataViewModel;
      const parts: any[] = (meta?.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap((row: any) => row?.metadataParts ?? []);
      const age = parts.map((p) => p?.accessibilityLabel ?? p?.text?.content).find((t) => typeof t === "string" && /\bago\b/i.test(t));
      add(lockup.contentId, meta?.title?.content, age);
      return;
    }
    const renderer = o.videoRenderer ?? o.gridVideoRenderer;
    if (renderer?.videoId) {
      add(renderer.videoId, renderer.title?.runs?.[0]?.text ?? renderer.title?.simpleText, renderer.publishedTimeText?.simpleText);
      return;
    }
    for (const value of Object.values(o)) walk(value);
  };
  walk(data);
  return [...videos.values()];
}

/** Title, publish date and description from the player data embedded in a watch page. */
export function parseWatchPage(html: string, id: string, channel: string): CreatorVideo | null {
  const details = /"videoDetails":\{"videoId":"([\w-]{6,20})","title":"((?:[^"\\]|\\.)*)"/.exec(html);
  const title = jsonText(details?.[2]);
  if (!details || details[1] !== id || !title) return null;
  const description = jsonText(/"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1]);
  const published = /"publishDate":"([^"]+)"/.exec(html)?.[1] ?? "";
  return { channel, id, title, published, url: `https://www.youtube.com/watch?v=${id}`, ...splitDescription(description), source: "watch" };
}

/** Descriptions already fetched (RSS or watch page), by video id — a video is described once and never refetched. */
export type VideoCache = Record<string, CreatorVideo>;

export function rememberVideos(cache: VideoCache, videos: CreatorVideo[], keep = 60): VideoCache {
  const next: VideoCache = { ...cache };
  for (const { isNew: _isNew, ...video } of videos) if (video.source !== "channel") next[video.id] = video;
  const newest = Object.values(next).sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0)).slice(0, keep);
  return Object.fromEntries(newest.map((v) => [v.id, v]));
}

/**
 * Fallback when the RSS feed is unavailable (YouTube answers 404 for it most of the time since November 2026):
 * the channel page lists the videos; the description comes from the cache or, for a new video, from its watch page.
 * A blocked watch page leaves the video with its title only.
 */
async function fetchChannelPageVideos(c: FollowedChannel, known: VideoCache, deadline: number): Promise<CreatorVideo[]> {
  const page = await youtubeText(`https://www.youtube.com/channel/${encodeURIComponent(c.channelId)}/videos`, 10_000);
  const listed = parseChannelPage(page, c.name, Date.now()).slice(0, CHANNEL_PAGE_VIDEOS);
  const videos: CreatorVideo[] = [];
  let fetches = 0;
  let blocked = false;
  for (const base of listed) {
    const cached = known[base.id];
    if (cached) {
      videos.push({ ...cached, channel: c.name });
      continue;
    }
    if (!blocked && fetches < MAX_WATCH_FETCHES && Date.now() < deadline) {
      if (fetches++ > 0) await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const detailed = parseWatchPage(await youtubeText(base.url, 6_000), base.id, c.name);
        if (detailed) {
          videos.push(detailed);
          continue;
        }
      } catch {
        // 429 / captcha redirect: stop asking, keep the titles
      }
      blocked = true;
    }
    videos.push(base);
  }
  return videos;
}

export async function fetchFollowedVideos(channels: FollowedChannel[], known: VideoCache = {}): Promise<CreatorVideo[]> {
  const deadline = Date.now() + FEED_BUDGET_MS;
  const batches = await Promise.all(channels.map(async (c) => {
    try {
      const rss = parseYoutubeFeed(await youtubeText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.channelId)}`, 8_000), c.name);
      if (rss.length) return rss;
      throw new Error("empty feed");
    } catch (rssError) {
      try {
        const videos = await fetchChannelPageVideos(c, known, deadline);
        if (!videos.length) throw new Error("no videos on the channel page");
        const titleOnly = videos.filter((v) => v.source === "channel").length;
        console.warn(`אזהרה: פיד ה-RSS של ${c.name} לא זמין (${(rssError as Error).message}) — ${videos.length} סרטונים נמשכו מעמוד הערוץ${titleOnly ? `, ${titleOnly} מהם עם כותרת בלבד` : ""}.`);
        return videos;
      } catch (err) {
        console.warn(`אזהרה: כשל במשיכת ערוץ ${c.name}: RSS ${(rssError as Error).message}; עמוד הערוץ ${(err as Error).message}`);
        return [];
      }
    }
  }));
  return batches.flat();
}

/** New = never seen, or first seen today (a same-day rerun keeps the flag). Keeps the newest 300 ids. */
export function markNewVideos(videos: CreatorVideo[], seen: Record<string, string>, nowIso: string): { videos: CreatorVideo[]; seen: Record<string, string> } {
  const next = { ...seen };
  const today = nowIso.slice(0, 10);
  const marked = videos.map((v) => {
    if (!(v.id in next)) next[v.id] = nowIso;
    return { ...v, isNew: next[v.id].slice(0, 10) === today };
  });
  const kept = Object.entries(next).sort(([, a], [, b]) => b.localeCompare(a)).slice(0, 300);
  return { videos: marked, seen: Object.fromEntries(kept) };
}

const NOT_TICKERS = new Set([
  "AI", "ATR", "CEO", "CFO", "ETF", "EPS", "GDP", "PCE", "CPI", "IPO", "PC", "USA", "US", "VWAP", "RSI", "MACD", "FED", "PLUS", "OFF",
  "ARR", "AH", "PM", "LIVE", "NEW", "SEC", "OK", "TV", "YTD", "ATH", "EU", "UK", "OPEC", "FOMC", "DXY", "CNBC", "MAG", "HP",
]);

/** Whole-word Hebrew match; allows only the "ו" (and) prefix, so "וגוגל" matches but "מבזק" is not "בזק" and "אל עליות" is not "אל על". */
export function containsHebrewWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z\\u0590-\\u05FF])ו?${escaped}(?![A-Za-z\\u0590-\\u05FF])`).test(text);
}

/** Instruments a video talks about: explicit US tickers, Hebrew watchlist names and Hebrew aliases. */
export function findMentions(
  videos: CreatorVideo[],
  watchlist: StockDef[],
  held: Set<string>,
  aliases: Record<string, string>,
): CreatorMention[] {
  const names = new Map(watchlist.map((s) => [s.symbol, s.name]));
  const found = new Map<string, CreatorMention>();
  const add = (symbol: string, videoId: string, label?: string) => {
    const entry = found.get(symbol) ?? { symbol, name: names.get(symbol) ?? symbol, tracked: names.has(symbol), held: held.has(symbol), videoIds: [] };
    if (label && entry.name === symbol) entry.name = label;
    if (!entry.videoIds.includes(videoId)) entry.videoIds.push(videoId);
    found.set(symbol, entry);
  };
  for (const v of videos) {
    const text = [v.title, v.blurb, ...v.chapters].join(" ");
    for (const m of text.matchAll(/(?<![A-Za-z])[A-Z]{2,5}(?![A-Za-z])/g)) {
      if (!NOT_TICKERS.has(m[0])) add(m[0], v.id);
    }
    for (const s of watchlist) {
      if (s.symbol.endsWith(".TA") && s.name.length >= 3 && containsHebrewWord(text, s.name)) add(s.symbol, v.id);
    }
    for (const [alias, symbol] of Object.entries(aliases)) if (containsHebrewWord(text, alias)) add(symbol, v.id, alias);
  }
  return [...found.values()].sort((a, b) => Number(b.held) - Number(a.held) || Number(b.tracked) - Number(a.tracked) || b.videoIds.length - a.videoIds.length);
}

const level = (n: number): string => String(Number(n.toFixed(2)));

const EARNINGS_WAIT_DAYS = 7;
const CHASE_PCT = 8;

/** One-line verdict by his rules: no entry before earnings, wait 3 days after a crash, don't chase, trigger levels. */
export function methodVerdict(row: { setup: TrendChangeSetup; earningsInDays: number | null }): string {
  const s = row.setup;
  if (row.earningsInDays != null && row.earningsInDays >= 0 && row.earningsInDays <= EARNINGS_WAIT_DAYS) return `דוח בעוד ${row.earningsInDays} ימים — לא נכנסים לפני דוח (מה אם תרד 15%?)`;
  if (s.waitThreeDays) return "חוק 3 הימים — נפילה חדה בימים האחרונים, הנר הירוק הראשון הוא לרוב מלכודת; להמתין";
  if (s.status === "breakout") {
    return (s.extendedPct ?? 0) > CHASE_PCT
      ? `פרצה, אבל ${level(s.extendedPct!)}% מעל נקודת הפריצה — לא לרדוף, לחכות לחזרה ל-${level(s.trigger!)}`
      : `כניסה אפשרית: פריצה מעל ${level(s.trigger!)} · סטופ ${level(s.stop!)} · יעד ${level(s.target!)}`;
  }
  if (s.status === "line-break") return `חצתה את הקו; אישור בסגירה מעל ${level(s.trigger!)} · סטופ ${level(s.stop!)}`;
  if (s.status === "base") return `בסיס עם שפל עולה; מעקב — חציית הקו ב-${level(s.line ?? s.trigger ?? 0)}, אישור מעל ${level(s.trigger ?? 0)}`;
  return "אין מבנה שינוי מגמה";
}

/* -------- His rules applied to the recommendations (buy gate + holdings) -------- */

/** The rules and what each one does in this report. Source: his video descriptions, not transcripts. */
export const METHOD_RULES: { rule: string; source: string; effect: string }[] = [
  { rule: "לא נכנסים לפני דוח", source: "כלל קבוע בערוץ", effect: `מועמדת קנייה נפסלת כשהדוח בתוך ${EARNINGS_WAIT_DAYS} ימים` },
  { rule: "חוק 3 הימים אחרי נפילה חדה", source: "כלל קבוע בערוץ", effect: "נפסלת אחרי יום ירידה של 2×ATR ומעלה בשלושת ימי המסחר האחרונים" },
  { rule: "לא רודפים אחרי פריצה", source: "כלל קבוע בערוץ", effect: `נפסלת כשהמחיר יותר מ-${CHASE_PCT}% מעל נקודת הפריצה` },
  { rule: "ממוצע 150 הוא נורת האזהרה; \"חברה טובה, זה יסתדר\" היא טעות", source: "5 לקחים ממשבר אנבידיה, 13.11.2026", effect: "נפסלת מתחת לממוצע 150, אלא אם פרצה במבנה שינוי מגמה; בהחזקה — לא מחזקים" },
  { rule: "סטופ מחוץ לתנועה היומית: מתחת ל-1 ATR הוא קופץ ב-61%–87% מהמקרים", source: "למה הסטופ לוס קופץ מוקדם מדי, 6.11.2026", effect: "סטופ מבני קרוב מ-1.5 ATR לא נבחר; ברירת המחדל 2 ATR" },
  { rule: "שינוי מגמה לפי Edwards & Magee", source: "שיטת הערוץ", effect: "טבלת המבנים בהמשך המקטע" },
  { rule: "לא מתזמנים מדד; מניה בודדת חייבת סטופ", source: "מ-16.4% רווח למינוס 9.5%, 9.11.2026", effect: "להקשר בלבד; קרנות ממונפות נשארות עם טריגר ממוצע 200 של המנוע" },
  { rule: "ריכוזיות: 60% מההון במניה אחת = פגיעה של 18%", source: "5 לקחים ממשבר אנבידיה, 13.11.2026", effect: "שורת ריכוזיות לפי סקטור (לפי מספר החזקות; אין כמויות בתיק)" },
];

export interface MethodCheck {
  sma150: number | null;
  /** Close against the 150-day average, in percent; null with fewer than 150 bars. */
  sma150Pct: number | null;
  /** Consecutive closes below the 150-day average, ending at the last bar. */
  sessionsBelow: number;
  waitThreeDays: boolean;
  earningsInDays: number | null;
  setup: TrendChangeSetup["status"];
  /** Reasons that forbid a new buy by his rules; empty = the candidate passes. */
  blocks: string[];
}

export function methodCheck(candles: Candle[], earningsInDays: number | null): MethodCheck | null {
  if (!candles.length) return null;
  const closes = candles.map((c) => c.close);
  const averages = sma(closes, 150);
  const sma150 = averages.at(-1) ?? null;
  const sma150Pct = sma150 != null && sma150 > 0 ? (closes.at(-1)! / sma150 - 1) * 100 : null;
  let sessionsBelow = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const average = averages[i];
    if (average == null || closes[i] >= average) break;
    sessionsBelow++;
  }
  const setup = trendChangeSetup(candles);
  const status = setup?.status ?? "none";
  const blocks: string[] = [];
  if (earningsInDays != null && earningsInDays >= 0 && earningsInDays <= EARNINGS_WAIT_DAYS) blocks.push(`דוח בעוד ${earningsInDays} ימים — לא נכנסים לפני דוח`);
  if (setup?.waitThreeDays) blocks.push("חוק 3 הימים — נפילה חדה בימים האחרונים, להמתין");
  if (status === "breakout" && (setup!.extendedPct ?? 0) > CHASE_PCT) blocks.push(`${level(setup!.extendedPct!)}% מעל נקודת הפריצה — לא רודפים`);
  if (sma150Pct != null && sma150Pct < 0 && status !== "breakout") blocks.push(`מתחת לממוצע 150 (${sma150Pct.toFixed(1)}%) — נורת אזהרה; קנייה רק אחרי פריצת שינוי מגמה`);
  return { sma150, sma150Pct, sessionsBelow, waitThreeDays: setup?.waitThreeDays ?? false, earningsInDays, setup: status, blocks };
}

/** Why a candidate that passed is acceptable by his rules — shown next to the pick. */
export function methodPassLine(check: MethodCheck): string {
  const parts = [
    check.sma150Pct == null ? "ממוצע 150 לא זמין (פחות מ-150 ימי מסחר)"
      : check.sma150Pct >= 0 ? `מעל ממוצע 150 (+${check.sma150Pct.toFixed(1)}%)`
      : `פריצת שינוי מגמה מתחת לממוצע 150 (${check.sma150Pct.toFixed(1)}%)`,
    check.earningsInDays != null && check.earningsInDays >= 0 ? `דוח בעוד ${check.earningsInDays} ימים` : "אין דוח קרוב",
    "אין נפילה חדה ב-3 הימים האחרונים",
    "סטופ מחוץ לתנועה היומית (1 ATR ומעלה)",
  ];
  return parts.join(" · ");
}

/** The same rules for a position that is already held; `index` = judged by the fund's reference index. */
export function holdingVerdict(check: MethodCheck, basis: "own" | "index"): string {
  const subject = basis === "index" ? "מדד הייחוס " : "";
  const parts: string[] = [];
  if (check.sma150Pct == null) parts.push("פחות מ-150 ימי מסחר — ממוצע 150 לא זמין");
  else if (check.sma150Pct < 0) parts.push(`${subject}מתחת לממוצע 150 (${check.sma150Pct.toFixed(1)}%, ${check.sessionsBelow} ימי מסחר) — נורת אזהרה: לא מחזקים עד חזרה מעל הממוצע`);
  else parts.push(`${subject}מעל ממוצע 150 (+${check.sma150Pct.toFixed(1)}%) — המגמה תקינה`);
  if (check.earningsInDays != null && check.earningsInDays >= 0 && check.earningsInDays <= EARNINGS_WAIT_DAYS) parts.push(`דוח בעוד ${check.earningsInDays} ימים — לא מוסיפים לפני הדוח`);
  if (check.waitThreeDays) parts.push("חוק 3 הימים — לא לחזק על הנר הירוק הראשון");
  return parts.join(" · ");
}

/** His concentration lesson, by number of holdings (the portfolio carries no quantities). */
export function sectorConcentration(sectors: Array<string | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const sector of sectors) if (sector) counts.set(sector, (counts.get(sector) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2 || top[1] / sectors.length < 0.4) return null;
  return `${top[1]} מתוך ${sectors.length} החזקות בסקטור ${top[0]} — תנועה אחת בסקטור פוגעת ברוב התיק`;
}

export interface HoldingRuleInput {
  name: string;
  /** Yahoo symbol or TASE security number. */
  id: string;
  basis: "own" | "index";
  /** Reference index symbol when the fund has no chart of its own. */
  basisName?: string;
  candles: Candle[] | undefined;
  earningsInDays: number | null;
  sector?: string;
}

export interface HoldingRuleRow {
  name: string;
  id: string;
  basis: "own" | "index";
  basisName?: string;
  price: number;
  check: MethodCheck;
  verdict: string;
}

export interface CreatorRow {
  symbol: string;
  name: string;
  held: boolean;
  tracked: boolean;
  price: number;
  setup: TrendChangeSetup;
  earningsInDays: number | null;
  score: number | null;
  combined: number | null;
  verdict: string;
  videoIds?: string[];
}

export interface CreatorView {
  channels: string[];
  videos: CreatorVideo[];
  mentions: CreatorRow[];
  /** Mentioned names without price history in this run. */
  otherMentions: string[];
  setups: CreatorRow[];
  /** The portfolio read by his rules (own chart, or the reference index for funds). */
  holdings: HoldingRuleRow[];
  /** Holdings named in the portfolio that had no price history in this run. */
  holdingsWithoutData: string[];
  concentration: string | null;
}

export interface CreatorContext {
  candles: Map<string, Candle[]>;
  names: Map<string, string>;
  held: Set<string>;
  results: Map<string, { score: number; earningsInDays: number | null }>;
  combined: Map<string, number>;
  portfolio?: HoldingRuleInput[];
}

function creatorRow(symbol: string, name: string, ctx: CreatorContext): CreatorRow | null {
  const candles = ctx.candles.get(symbol);
  const setup = candles ? trendChangeSetup(candles) : null;
  if (!candles?.length || !setup) return null;
  const r = ctx.results.get(symbol);
  const earningsInDays = r?.earningsInDays ?? null;
  return {
    symbol, name, held: ctx.held.has(symbol), tracked: ctx.names.has(symbol), price: candles.at(-1)!.close, setup, earningsInDays,
    score: r?.score ?? null, combined: ctx.combined.get(symbol) ?? null, verdict: methodVerdict({ setup, earningsInDays }),
  };
}

const STATUS_ORDER: Record<TrendChangeSetup["status"], number> = { breakout: 0, "line-break": 1, base: 2, none: 3 };

export function buildCreatorView(channels: string[], videos: CreatorVideo[], mentions: CreatorMention[], ctx: CreatorContext): CreatorView {
  const mentionRows: CreatorRow[] = [];
  const otherMentions: string[] = [];
  for (const m of mentions) {
    const r = creatorRow(m.symbol, m.name, ctx);
    if (r) mentionRows.push({ ...r, videoIds: m.videoIds });
    else otherMentions.push(m.name === m.symbol ? m.symbol : `${m.name} (${m.symbol})`);
  }
  const setups = [...ctx.names].flatMap(([symbol, name]) => {
    const r = creatorRow(symbol, name, ctx);
    return r && r.setup.status !== "none" ? [r] : [];
  }).sort((a, b) => STATUS_ORDER[a.setup.status] - STATUS_ORDER[b.setup.status]
    || Number(a.setup.waitThreeDays) - Number(b.setup.waitThreeDays)
    || (b.combined ?? -999) - (a.combined ?? -999));
  const holdings: HoldingRuleRow[] = [];
  const holdingsWithoutData: string[] = [];
  for (const h of ctx.portfolio ?? []) {
    const check = h.candles ? methodCheck(h.candles, h.earningsInDays) : null;
    if (!check) {
      holdingsWithoutData.push(h.name);
      continue;
    }
    holdings.push({ name: h.name, id: h.id, basis: h.basis, basisName: h.basisName, price: h.candles!.at(-1)!.close, check, verdict: holdingVerdict(check, h.basis) });
  }
  const concentration = sectorConcentration((ctx.portfolio ?? []).map((h) => h.sector));
  return { channels, videos, mentions: mentionRows, otherMentions, setups, holdings, holdingsWithoutData, concentration };
}
