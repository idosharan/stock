/**
 * סריקת חדשות: מושך כותרות מ-RSS של עיתונות כלכלית ישראלית, מסנן לפי שם המניה
 * ומעריך סנטימנט בסיסי לפי מילות מפתח (חיובי/שלילי) כדי לאמוד השפעה אפשרית.
 */
import Parser from "rss-parser";
import { NEWS_FEEDS } from "./config.js";

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
