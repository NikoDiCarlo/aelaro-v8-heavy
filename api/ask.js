// api/ask.js
// Aelaro v8-lite
// Browser-orchestrated full S&P 500 scan + ranked top 3 filing changelog.
// Deploys on Vercel as /api/ask.
// Required env var for analysis: OPENAI_API_KEY

import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EDGAR_EMAIL = process.env.EDGAR_EMAIL || "nikovdicarlo@gmail.com";
const USER_AGENT = `Aelaro/8-lite contact:${EDGAR_EMAIL}`;

const SEC_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Encoding": "gzip, deflate",
  "Accept": "application/json,text/html,application/atom+xml,text/xml,*/*"
};

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = clampNumber(process.env.RATE_MAX_REQUESTS, 20, 300, 120);
const ipHits = new Map();

const SEC_SCAN_CONCURRENCY = clampNumber(process.env.SEC_SCAN_CONCURRENCY, 1, 6, 2);
const SEC_MAX_RETRIES = clampNumber(process.env.SEC_MAX_RETRIES, 0, 5, 3);
const SEC_RETRY_BASE_MS = clampNumber(process.env.SEC_RETRY_BASE_MS, 250, 5000, 900);
const SEC_REQUEST_SPACING_MS = clampNumber(process.env.SEC_REQUEST_SPACING_MS, 0, 2000, 125);

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const TOP_FILINGS_TO_ANALYZE = clampNumber(process.env.TOP_FILINGS_TO_ANALYZE, 1, 5, 3);
const RANK_PREVIEW_LIMIT = clampNumber(process.env.RANK_PREVIEW_LIMIT, 3, 75, 45);
const RANKING_PREVIEW_CHARS = clampNumber(process.env.RANKING_PREVIEW_CHARS, 2000, 18000, 7000);
const ANALYSIS_TEXT_CHARS = clampNumber(process.env.ANALYSIS_TEXT_CHARS, 8000, 30000, 18000);

const ALLOWED_FORMS = new Set(["10-K", "10-Q"]);

const FALLBACK_SP500_TICKERS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "GOOG", "BRK.B", "LLY", "AVGO",
  "JPM", "TSLA", "UNH", "XOM", "V", "MA", "PG", "JNJ", "COST", "HD",
  "ABBV", "NFLX", "BAC", "KO", "MRK", "CRM", "WMT", "PEP", "AMD", "ADBE",
  "LIN", "MCD", "CSCO", "TMO", "ABT", "ACN", "QCOM", "GE", "INTU", "IBM",
  "CAT", "NOW", "AMAT", "TXN", "ISRG", "VZ", "DIS", "PM", "NEE", "DHR",
  "RTX", "SPGI", "LOW", "PFE", "UBER", "GS", "HON", "UNP", "T", "BKNG",
  "BLK", "ELV", "ETN", "LMT", "SYK", "COP", "TJX", "VRTX", "C", "MDT",
  "BSX", "REGN", "CB", "ADP", "PLD", "PANW", "ADI", "MU", "KLAC", "MMC",
  "AMGN", "DE", "LRCX", "NKE", "SO", "UPS", "FI", "GILD", "ANET", "SBUX",
  "BA", "SCHW", "INTC", "CI", "MDLZ", "ZTS", "MO", "DUK", "EQIX", "ICE",
  "SHW", "CL", "WM", "MCO", "ORCL", "CMCSA", "MS", "USB", "PNC", "APD",
  "EOG", "HCA", "AON", "MAR", "GD", "CDNS", "SNPS", "MCK", "CTAS", "PH"
];

const LARGE_CAP_PRIORITY = new Map([
  ["AAPL", 35], ["MSFT", 35], ["NVDA", 35], ["AMZN", 32], ["META", 32],
  ["GOOGL", 32], ["GOOG", 32], ["BRK.B", 30], ["LLY", 30], ["AVGO", 30],
  ["JPM", 28], ["TSLA", 28], ["UNH", 27], ["XOM", 26], ["V", 25],
  ["MA", 25], ["COST", 24], ["HD", 24], ["PG", 23], ["JNJ", 23],
  ["ABBV", 23], ["NFLX", 23], ["BAC", 22], ["KO", 21], ["MRK", 21],
  ["CRM", 21], ["WMT", 21], ["PEP", 20], ["AMD", 20], ["ADBE", 20],
  ["ABNB", 18], ["AES", 16], ["DE", 18], ["APD", 16], ["ABT", 20]
]);

const submissionsCache = new Map();

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  return realIp || (forwarded ? forwarded.split(",")[0].trim() : "") || req.socket?.remoteAddress || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = ipHits.get(ip) || [];
  const recent = hits.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  recent.push(now);
  ipHits.set(ip, recent);
  return recent.length > RATE_MAX_REQUESTS;
}

function normalizeTicker(ticker) {
  return String(ticker || "").trim().toUpperCase().replace(".", "-");
}

function secTickerVariant(ticker) {
  return String(ticker || "").trim().toUpperCase().replace("-", ".");
}

function cikPad(cik) {
  return String(cik || "").replace(/\D/g, "").padStart(10, "0");
}

function cikNoZeros(cik) {
  return String(cik || "").replace(/\D/g, "").replace(/^0+/, "");
}

function accessionNoDashes(accession) {
  return String(accession || "").replace(/-/g, "");
}

function todayISODateET() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function nowETStamp() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * Math.min(500, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 18000) {
  let lastError;

  for (let attempt = 0; attempt <= SEC_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (SEC_REQUEST_SPACING_MS > 0) {
        await sleep(SEC_REQUEST_SPACING_MS);
      }

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...SEC_HEADERS,
          ...(options.headers || {})
        }
      });

      clearTimeout(timeout);

      if (response.ok) {
        return response;
      }

      const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
      const error = new Error(`Fetch failed ${response.status} for ${url}`);
      error.status = response.status;
      lastError = error;

      if (!retryable || attempt >= SEC_MAX_RETRIES) {
        throw error;
      }

      const waitMs = jitter(SEC_RETRY_BASE_MS * Math.pow(2, attempt));
      console.warn(`SEC fetch retry ${attempt + 1}/${SEC_MAX_RETRIES} after ${response.status}. Waiting ${waitMs}ms.`);
      await sleep(waitMs);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      const retryable =
        error?.name === "AbortError" ||
        error?.status === 429 ||
        error?.status === 403 ||
        error?.status >= 500;

      if (!retryable || attempt >= SEC_MAX_RETRIES) {
        throw error;
      }

      const waitMs = jitter(SEC_RETRY_BASE_MS * Math.pow(2, attempt));
      console.warn(`SEC fetch retry ${attempt + 1}/${SEC_MAX_RETRIES} after error: ${error.message}. Waiting ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error(`Fetch failed for ${url}`);
}

async function fetchText(url, timeoutMs = 18000) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  return response.text();
}

async function fetchJSON(url, timeoutMs = 18000) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  return response.json();
}

async function batchMap(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker(workerId) {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex, workerId);
      } catch (error) {
        results[currentIndex] = { __error: error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    (_, workerId) => worker(workerId)
  );

  await Promise.all(workers);
  return results;
}

async function getSp500Tickers() {
  try {
    const html = await fetchText("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", 18000);
    const firstTable = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i)?.[0] || html;

    const tickerMatches = [...firstTable.matchAll(/<tr[\s\S]*?<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi)];
    const tickers = tickerMatches
      .map((match) => normalizeTicker(match[1]))
      .filter(Boolean);

    const unique = [...new Set(tickers)];

    if (unique.length > 300) {
      return unique;
    }
  } catch (error) {
    console.warn("S&P 500 Wikipedia fetch failed; using fallback universe.", error.message);
  }

  return FALLBACK_SP500_TICKERS;
}

async function getTickerCikMap() {
  const data = await fetchJSON("https://www.sec.gov/files/company_tickers.json", 18000);
  const map = new Map();

  for (const row of Object.values(data)) {
    const normalizedTicker = normalizeTicker(row.ticker);
    const dotTicker = secTickerVariant(row.ticker);

    const payload = {
      ticker: dotTicker,
      normalizedTicker,
      cik: cikPad(row.cik_str),
      title: row.title
    };

    map.set(normalizedTicker, payload);
    map.set(dotTicker, payload);

    if (normalizedTicker.includes("-")) {
      map.set(normalizedTicker.replace("-", "."), payload);
    }

    if (dotTicker.includes(".")) {
      map.set(dotTicker.replace(".", "-"), payload);
    }
  }

  return map;
}

async function buildUniverse() {
  const [tickers, tickerCikMap] = await Promise.all([
    getSp500Tickers(),
    getTickerCikMap()
  ]);

  const byCik = new Map();

  for (const ticker of tickers) {
    const normalized = normalizeTicker(ticker);
    const dotVariant = secTickerVariant(ticker);
    const info = tickerCikMap.get(normalized) || tickerCikMap.get(dotVariant);

    if (info?.cik) {
      byCik.set(info.cik, {
        ticker: info.ticker,
        normalizedTicker: info.normalizedTicker,
        cik: info.cik,
        title: info.title
      });
    }
  }

  return [...byCik.values()].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
}

async function getCompanySubmissions(cik) {
  const padded = cikPad(cik);

  if (submissionsCache.has(padded)) {
    return submissionsCache.get(padded);
  }

  const submissions = await fetchJSON(`https://data.sec.gov/submissions/CIK${padded}.json`, 18000);
  submissionsCache.set(padded, submissions);
  return submissions;
}

function buildArchiveFolderUrl(cik, accession) {
  return `https://www.sec.gov/Archives/edgar/data/${cikNoZeros(cik)}/${accessionNoDashes(accession)}/`;
}

function getRecentFilingsFromSubmissions(submissions, company, options = {}) {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const exactDate = options.exactDate || null;

  const forms = recent.form || [];
  const accessionNumbers = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDocs = recent.primaryDocument || [];

  const filings = [];

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const filingDate = filingDates[i];
    const accession = accessionNumbers[i];

    if (!ALLOWED_FORMS.has(form)) continue;
    if (exactDate && filingDate !== exactDate) continue;
    if (!accession) continue;

    filings.push({
      ticker: company.ticker,
      normalizedTicker: company.normalizedTicker || normalizeTicker(company.ticker),
      companyName: company.title || company.companyName,
      title: company.title || company.companyName,
      cik: cikPad(company.cik),
      form,
      accession,
      filingDate,
      reportDate: reportDates[i] || "",
      primaryDocument: primaryDocs[i] || null,
      filingDetailUrl: buildArchiveFolderUrl(company.cik, accession),
      sourceMode: "batch-exact-date",
      importanceScore: 0,
      importanceReasons: []
    });
  }

  return filings;
}

function dedupeFilings(filings) {
  const deduped = [];
  const seen = new Set();

  for (const filing of filings) {
    const key = `${filing.cik}:${filing.accession}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(filing);
    }
  }

  return deduped;
}

function baseSortFilings(filings) {
  const formRank = { "10-K": 1, "10-Q": 2 };

  return [...filings].sort((a, b) => {
    const byDate = String(b.filingDate || "").localeCompare(String(a.filingDate || ""));
    if (byDate !== 0) return byDate;

    const byForm = (formRank[a.form] || 9) - (formRank[b.form] || 9);
    if (byForm !== 0) return byForm;

    const aCap = LARGE_CAP_PRIORITY.get(normalizeTicker(a.ticker || a.normalizedTicker)) || 0;
    const bCap = LARGE_CAP_PRIORITY.get(normalizeTicker(b.ticker || b.normalizedTicker)) || 0;
    if (bCap !== aCap) return bCap - aCap;

    return String(a.companyName || "").localeCompare(String(b.companyName || ""));
  });
}

async function scanBatch({ filingDate, companies }) {
  const startedAt = Date.now();
  const safeCompanies = Array.isArray(companies) ? companies.slice(0, 75) : [];

  const results = await batchMap(safeCompanies, SEC_SCAN_CONCURRENCY, async (company, index) => {
    if (index > 0 && index % 15 === 0) {
      await sleep(500);
    }

    const submissions = await getCompanySubmissions(company.cik);
    const matches = getRecentFilingsFromSubmissions(submissions, company, { exactDate: filingDate });

    return {
      company,
      matches,
      scanned: true
    };
  });

  const filings = [];
  let scanErrors = 0;

  for (const result of results) {
    if (result?.__error) {
      scanErrors += 1;
      continue;
    }

    if (Array.isArray(result?.matches)) {
      filings.push(...result.matches);
    }
  }

  return {
    product: "Aelaro",
    version: "v8-lite",
    action: "scanBatch",
    filingDate,
    scannedCompanies: safeCompanies.length,
    scanErrors,
    elapsedMs: Date.now() - startedAt,
    filings: baseSortFilings(dedupeFilings(filings))
  };
}

function normalizeForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\n\r\t]+/g, " ")
    .replace(/[.,;:()[\]{}"'`]/g, "")
    .replace(/\$\s*/g, "$")
    .trim();
}

function signalScoreFromText(value) {
  const text = normalizeForComparison(value);
  const signals = [
    ["agreement and plan of merger", 110, "merger agreement"],
    ["merger", 85, "merger"],
    ["acquisition", 75, "acquisition"],
    ["acquired", 45, "acquisition"],
    ["business combination", 65, "business combination"],
    ["license agreement", 70, "license agreement"],
    ["collaboration agreement", 55, "collaboration agreement"],
    ["milestone payment", 50, "milestone payment"],
    ["upfront payment", 50, "upfront payment"],
    ["senior notes", 80, "senior notes"],
    ["credit agreement", 75, "credit agreement"],
    ["revolving credit", 65, "revolving credit"],
    ["term loan", 65, "term loan"],
    ["letter of credit", 50, "letter of credit"],
    ["interest rate swap", 65, "interest rate swaps"],
    ["cash flow hedge", 58, "cash flow hedging"],
    ["foreign exchange", 35, "foreign exchange exposure"],
    ["liquidity", 45, "liquidity"],
    ["going concern", 100, "going concern"],
    ["material weakness", 100, "material weakness"],
    ["impairment", 70, "impairment"],
    ["restructuring", 60, "restructuring"],
    ["investigation", 55, "investigation"],
    ["settlement", 50, "settlement"],
    ["customer concentration", 70, "customer concentration"],
    ["supplier concentration", 60, "supplier concentration"],
    ["share repurchase", 45, "share repurchase"],
    ["repurchase program", 45, "share repurchase"],
    ["noncontrolling interest", 42, "noncontrolling interest"],
    ["joint venture", 42, "joint venture"],
    ["tax equity", 40, "tax equity"],
    ["project exit", 60, "project exit"],
    ["cybersecurity incident", 80, "cybersecurity incident"],
    ["restatement", 100, "restatement"],
    ["substantial doubt", 100, "going concern"]
  ];

  let score = 0;
  const reasons = [];

  for (const [keyword, points, reason] of signals) {
    if (text.includes(keyword)) {
      score += points;
      reasons.push(reason);
    }
  }

  const penaltySignals = [
    "signature",
    "signatures",
    "principal financial officer",
    "chief financial officer",
    "10b5-1",
    "no director",
    "no section 16 officer",
    "did not maintain a share repurchase program",
    "no share repurchase program",
    "not changed materially",
    "no material changes",
    "no legal proceedings",
    "no environmental matters"
  ];

  for (const phrase of penaltySignals) {
    if (text.includes(phrase)) {
      score -= 15;
    }
  }

  return {
    score: Math.max(0, score),
    reasons: [...new Set(reasons)].slice(0, 8)
  };
}

function scoreFilingMetadata(filing) {
  let score = 0;
  const reasons = [];

  if (filing.form === "10-K") {
    score += 25;
    reasons.push("10-K");
  }

  if (filing.form === "10-Q") {
    score += 15;
    reasons.push("10-Q");
  }

  const normalizedTicker = normalizeTicker(filing.ticker || filing.normalizedTicker);
  const capScore = LARGE_CAP_PRIORITY.get(normalizedTicker) || 0;

  if (capScore > 0) {
    score += capScore;
    reasons.push("large-cap priority");
  }

  const metadataSignals = signalScoreFromText([
    filing.companyName,
    filing.title,
    filing.form,
    filing.primaryDocument,
    filing.filingDetailUrl
  ].join(" "));

  score += metadataSignals.score;
  reasons.push(...metadataSignals.reasons);

  return {
    score,
    reasons: [...new Set(reasons)].slice(0, 10)
  };
}

async function getPrimaryDocumentUrl(cik, accession, hintedPrimaryDocument) {
  const cikShort = cikNoZeros(cik);
  const accNoDash = accessionNoDashes(accession);

  if (hintedPrimaryDocument) {
    return `https://www.sec.gov/Archives/edgar/data/${cikShort}/${accNoDash}/${hintedPrimaryDocument}`;
  }

  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikShort}/${accNoDash}/index.json`;
  const index = await fetchJSON(indexUrl, 18000);
  const files = index?.directory?.item || [];

  const primary =
    files.find((file) =>
      /\.(htm|html|txt)$/i.test(file.name || "") &&
      !/index|xsl|xml|xsd|jpg|jpeg|png|gif|css/i.test(file.name || "")
    ) ||
    files.find((file) => /\.(htm|html|txt)$/i.test(file.name || ""));

  if (!primary?.name) {
    throw new Error("Primary document not found");
  }

  return `https://www.sec.gov/Archives/edgar/data/${cikShort}/${accNoDash}/${primary.name}`;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<ix:[^>]+>/gi, " ")
    .replace(/<\/ix:[^>]+>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(text, maxChars = 18000) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxChars) return cleaned;

  const beginning = cleaned.slice(0, Math.floor(maxChars * 0.46));
  const middleStart = Math.max(0, Math.floor(cleaned.length * 0.39));
  const middle = cleaned.slice(middleStart, middleStart + Math.floor(maxChars * 0.30));
  const end = cleaned.slice(-Math.floor(maxChars * 0.24));

  return `${beginning}\n\n[...middle excerpt...]\n\n${middle}\n\n[...ending excerpt...]\n\n${end}`;
}

async function fetchFilingText(url, maxChars = 18000) {
  const raw = await fetchText(url, 25000);
  return compactText(stripHtml(raw), maxChars);
}

async function rankFilings({ filingDate, filings }) {
  const startedAt = Date.now();
  const deduped = baseSortFilings(dedupeFilings(Array.isArray(filings) ? filings : []));

  const ranked = deduped.map((filing) => {
    const base = scoreFilingMetadata(filing);
    return {
      ...filing,
      importanceScore: base.score,
      importanceReasons: base.reasons
    };
  });

  const candidates = ranked
    .sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0))
    .slice(0, Math.min(RANK_PREVIEW_LIMIT, ranked.length));

  await batchMap(candidates, SEC_SCAN_CONCURRENCY, async (filing) => {
    try {
      const currentUrl = await getPrimaryDocumentUrl(filing.cik, filing.accession, filing.primaryDocument);
      const previewText = await fetchFilingText(currentUrl, RANKING_PREVIEW_CHARS);
      const previewSignals = signalScoreFromText(previewText);

      filing.importanceScore += previewSignals.score;
      filing.importanceReasons = [...new Set([
        ...(filing.importanceReasons || []),
        ...previewSignals.reasons
      ])].slice(0, 10);

      filing.currentUrl = currentUrl;
    } catch (error) {
      filing.importanceReasons = [...new Set([
        ...(filing.importanceReasons || []),
        "preview unavailable"
      ])].slice(0, 10);
    }

    return filing;
  });

  const finalRanked = ranked.sort((a, b) => {
    if ((b.importanceScore || 0) !== (a.importanceScore || 0)) {
      return (b.importanceScore || 0) - (a.importanceScore || 0);
    }

    const formRank = { "10-K": 1, "10-Q": 2 };
    const byForm = (formRank[a.form] || 9) - (formRank[b.form] || 9);
    if (byForm !== 0) return byForm;

    return String(a.companyName || "").localeCompare(String(b.companyName || ""));
  });

  return {
    product: "Aelaro",
    version: "v8-lite",
    action: "rankFilings",
    filingDate,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    rankedFilings: finalRanked.map((filing, index) => ({
      ...publicFiling(filing),
      rank: index + 1,
      importanceScore: filing.importanceScore || 0,
      importanceReasons: filing.importanceReasons || [],
      currentUrl: filing.currentUrl || ""
    }))
  };
}

function publicFiling(filing) {
  return {
    ticker: filing.ticker,
    normalizedTicker: filing.normalizedTicker || normalizeTicker(filing.ticker),
    companyName: filing.companyName || filing.title,
    title: filing.title || filing.companyName,
    cik: cikPad(filing.cik),
    form: filing.form,
    accession: filing.accession,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate || "",
    primaryDocument: filing.primaryDocument || null,
    filingDetailUrl: filing.filingDetailUrl || buildArchiveFolderUrl(filing.cik, filing.accession)
  };
}

function findPreviousSameForm(submissions, currentAccession, form) {
  const recent = submissions?.filings?.recent;
  if (!recent) return null;

  const forms = recent.form || [];
  const accessionNumbers = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDocs = recent.primaryDocument || [];

  const currentIndex = accessionNumbers.findIndex((accession) => accession === currentAccession);

  if (currentIndex >= 0) {
    for (let i = currentIndex + 1; i < forms.length; i++) {
      if (forms[i] !== form) continue;
      if (accessionNumbers[i] === currentAccession) continue;

      return {
        form: forms[i],
        accession: accessionNumbers[i],
        filingDate: filingDates[i],
        reportDate: reportDates[i] || "",
        primaryDocument: primaryDocs[i] || null,
        comparisonBasis: `previous ${form}`
      };
    }
  }

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === form && accessionNumbers[i] !== currentAccession) {
      return {
        form: forms[i],
        accession: accessionNumbers[i],
        filingDate: filingDates[i],
        reportDate: reportDates[i] || "",
        primaryDocument: primaryDocs[i] || null,
        comparisonBasis: `nearest available previous ${form}`
      };
    }
  }

  return null;
}

function findLatestTenKBeforeCurrent(submissions, currentAccession) {
  const recent = submissions?.filings?.recent;
  if (!recent) return null;

  const forms = recent.form || [];
  const accessionNumbers = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDocs = recent.primaryDocument || [];

  const currentIndex = accessionNumbers.findIndex((accession) => accession === currentAccession);

  if (currentIndex >= 0) {
    for (let i = currentIndex + 1; i < forms.length; i++) {
      if (forms[i] !== "10-K") continue;
      if (accessionNumbers[i] === currentAccession) continue;

      return {
        form: forms[i],
        accession: accessionNumbers[i],
        filingDate: filingDates[i],
        reportDate: reportDates[i] || "",
        primaryDocument: primaryDocs[i] || null,
        comparisonBasis: "latest prior 10-K context"
      };
    }
  }

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === "10-K" && accessionNumbers[i] !== currentAccession) {
      return {
        form: forms[i],
        accession: accessionNumbers[i],
        filingDate: filingDates[i],
        reportDate: reportDates[i] || "",
        primaryDocument: primaryDocs[i] || null,
        comparisonBasis: "nearest available 10-K context"
      };
    }
  }

  return null;
}

function findPriorComparable(submissions, currentAccession, form) {
  const previousSameForm = findPreviousSameForm(submissions, currentAccession, form);

  if (previousSameForm) {
    return previousSameForm;
  }

  if (form === "10-Q") {
    const latestTenK = findLatestTenKBeforeCurrent(submissions, currentAccession);
    if (latestTenK) return latestTenK;
  }

  return null;
}

function findSecondaryContext(submissions, currentAccession, form, primaryPriorAccession) {
  if (form !== "10-Q") return null;

  const latestTenK = findLatestTenKBeforeCurrent(submissions, currentAccession);
  if (!latestTenK) return null;
  if (latestTenK.accession === primaryPriorAccession) return null;

  return latestTenK;
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  throw new Error("Model did not return valid JSON");
}

function clampString(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizeSection(section) {
  const text = String(section || "").trim();
  const allowed = [
    "Risk Factors",
    "MD&A",
    "Liquidity and Capital Resources",
    "Business Combinations",
    "M&A / Strategic Transactions",
    "Licensing / Pipeline / R&D",
    "Debt and Financing",
    "Credit Agreements",
    "Capital Allocation",
    "Share Repurchases",
    "Executive / Governance Changes",
    "Project / Joint Venture Exposure",
    "Market Risk / Hedging",
    "Goodwill and Intangibles",
    "Legal Proceedings",
    "Revenue / Segment Commentary",
    "Customer / Supplier Concentration",
    "Accounting / Controls",
    "Other"
  ];

  const direct = allowed.find((item) => item.toLowerCase() === text.toLowerCase());
  if (direct) return direct;

  const lower = text.toLowerCase();

  if (lower.includes("risk factor")) return "Risk Factors";
  if (lower.includes("md&a") || lower.includes("management")) return "MD&A";
  if (lower.includes("liquidity") || lower.includes("cash") || lower.includes("capital resources")) return "Liquidity and Capital Resources";
  if (lower.includes("license") || lower.includes("collaboration") || lower.includes("pipeline") || lower.includes("r&d") || lower.includes("ipr&d")) return "Licensing / Pipeline / R&D";
  if (lower.includes("merger") || lower.includes("acquisition") || lower.includes("business combination")) return "M&A / Strategic Transactions";
  if (lower.includes("revolving") || lower.includes("credit agreement") || lower.includes("term loan")) return "Credit Agreements";
  if (lower.includes("debt") || lower.includes("financing") || lower.includes("senior notes")) return "Debt and Financing";
  if (lower.includes("repurchase") || lower.includes("buyback") || lower.includes("dividend")) return "Capital Allocation";
  if (lower.includes("executive") || lower.includes("governance") || lower.includes("chief financial officer") || lower.includes("principal financial officer")) return "Executive / Governance Changes";
  if (lower.includes("joint venture") || lower.includes("project") || lower.includes("noncontrolling") || lower.includes("tax equity")) return "Project / Joint Venture Exposure";
  if (lower.includes("hedging") || lower.includes("swap") || lower.includes("foreign exchange") || lower.includes("market risk")) return "Market Risk / Hedging";
  if (lower.includes("goodwill") || lower.includes("intangible")) return "Goodwill and Intangibles";
  if (lower.includes("legal") || lower.includes("litigation") || lower.includes("proceeding")) return "Legal Proceedings";
  if (lower.includes("revenue") || lower.includes("segment") || lower.includes("sales")) return "Revenue / Segment Commentary";
  if (lower.includes("customer") || lower.includes("supplier") || lower.includes("supply")) return "Customer / Supplier Concentration";
  if (lower.includes("accounting") || lower.includes("control")) return "Accounting / Controls";

  return text ? clampString(text, 80) : "Other";
}

function wordSet(value) {
  return new Set(
    normalizeForComparison(value)
      .split(" ")
      .filter((word) => word.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);

  if (!setA.size || !setB.size) return 0;

  let intersection = 0;

  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }

  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function containsNoChangeLanguage(value) {
  const text = normalizeForComparison(value);

  return [
    "not changed materially",
    "have not changed materially",
    "has not changed materially",
    "no material change",
    "no material changes",
    "there were no material changes",
    "there are no material changes",
    "there are no environmental matters to disclose",
    "there were no environmental matters to disclose",
    "no environmental matters to disclose",
    "nothing to disclose",
    "no proceedings to disclose",
    "no legal proceedings to disclose",
    "no material legal proceedings",
    "no changes were made",
    "unchanged from",
    "same as",
    "no further updates",
    "not materially different",
    "no director or section 16 officer",
    "no section 16 officer"
  ].some((phrase) => text.includes(phrase));
}

function containsRoutineBoilerplate(value) {
  const text = normalizeForComparison(value);

  return [
    "signature",
    "signatures",
    "exhibit index",
    "cover page",
    "document and entity information",
    "pursuant to the requirements",
    "certification",
    "interactive data file",
    "inline xbrl",
    "filed herewith",
    "furnished herewith"
  ].some((phrase) => text.includes(phrase));
}

function isWeakOrUnchangedChange(change) {
  const section = normalizeSection(change.section);
  const materiality = change.materiality || "Medium";
  const summary = String(change.summary || "");
  const beforeExcerpt = String(change.beforeExcerpt || "");
  const afterExcerpt = String(change.afterExcerpt || "");

  const beforeNorm = normalizeForComparison(beforeExcerpt);
  const afterNorm = normalizeForComparison(afterExcerpt);
  const summaryNorm = normalizeForComparison(summary);

  if (!beforeNorm || !afterNorm) return false;

  const exactSame = beforeNorm === afterNorm;
  const similarity = jaccardSimilarity(beforeExcerpt, afterExcerpt);
  const highlySimilar = similarity >= 0.88;
  const verySimilar = similarity >= 0.78;

  const saysNoChange =
    containsNoChangeLanguage(summary) ||
    containsNoChangeLanguage(beforeExcerpt) ||
    containsNoChangeLanguage(afterExcerpt);

  const routineBoilerplate =
    containsRoutineBoilerplate(summary) ||
    containsRoutineBoilerplate(beforeExcerpt) ||
    containsRoutineBoilerplate(afterExcerpt);

  const routineNoChangeSection =
    section === "Risk Factors" ||
    section === "Legal Proceedings" ||
    section === "Accounting / Controls" ||
    section === "Executive / Governance Changes";

  if (exactSame) return true;
  if (highlySimilar && saysNoChange) return true;
  if (routineNoChangeSection && saysNoChange) return true;
  if (section === "Executive / Governance Changes" && highlySimilar) return true;
  if (section === "Executive / Governance Changes" && routineBoilerplate) return true;
  if (materiality === "Low" && highlySimilar) return true;
  if (materiality === "Low" && verySimilar && (saysNoChange || routineBoilerplate)) return true;

  if (
    materiality === "Low" &&
    (
      summaryNorm.includes("no material") ||
      summaryNorm.includes("not changed") ||
      summaryNorm.includes("no environmental") ||
      summaryNorm.includes("nothing to disclose") ||
      summaryNorm.includes("unchanged")
    )
  ) {
    return true;
  }

  return false;
}

function filterMeaningfulChanges(changes) {
  return changes.filter((change) => !isWeakOrUnchangedChange(change));
}

function normalizeModelItem(parsed, fallback) {
  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : [];
  const analystQuestions = Array.isArray(parsed.analystQuestions) ? parsed.analystQuestions : [];

  const normalizedChanges = rawChanges.slice(0, 8).map((change) => ({
    section: normalizeSection(change.section),
    materiality: ["High", "Medium", "Low"].includes(change.materiality) ? change.materiality : "Medium",
    summary: clampString(change.summary || "", 750),
    beforeExcerpt: clampString(change.beforeExcerpt || "Not available from the extracted filing text.", 780),
    afterExcerpt: clampString(change.afterExcerpt || "Not available from the extracted filing text.", 780)
  }));

  const filteredChanges = filterMeaningfulChanges(normalizedChanges).slice(0, 6);

  const reviewPriority =
    filteredChanges.some((change) => change.materiality === "High")
      ? "High"
      : filteredChanges.some((change) => change.materiality === "Medium")
        ? "Medium"
        : "Low";

  const hasMeaningfulChanges = filteredChanges.length > 0;

  const executiveSummary = hasMeaningfulChanges
    ? parsed.executiveSummary || "Meaningful non-routine disclosure changes were detected for analyst review."
    : "No meaningful non-routine disclosure changes were detected after filtering unchanged boilerplate and routine confirmations.";

  const filteredQuestions = hasMeaningfulChanges
    ? analystQuestions.slice(0, 5).map((q) => clampString(q, 240))
    : [
        "Were any omitted changes purely routine, unchanged, or boilerplate?",
        "Should the filing still be reviewed manually for company-specific context?"
      ];

  return {
    ticker: fallback.ticker,
    companyName: clampString(parsed.companyName || fallback.companyName, 140),
    form: parsed.form || fallback.form,
    filingDate: parsed.filingDate || fallback.filingDate,
    priorForm: parsed.priorForm || fallback.priorForm,
    priorFilingDate: parsed.priorFilingDate || fallback.priorFilingDate,
    reviewPriority,
    executiveSummary: clampString(executiveSummary, 1000),
    changes: filteredChanges,
    analystQuestions: filteredQuestions
  };
}

async function analyzeFilingPair({
  filing,
  tickerInfo,
  prior,
  currentUrl,
  priorUrl,
  currentText,
  priorText,
  secondaryContext
}) {
  const system = `
You are Aelaro, an evidence-first SEC filing changelog analyst for institutional public-market research.

Your job:
Compare a current public-company 10-K or 10-Q against the prior comparable filing.
Find meaningful disclosure language changes for hedge fund / equity research triage.

Non-negotiable rules:
- Do not give investment advice.
- Do not make buy/sell/hold recommendations.
- Do not provide price targets, trading timing, or predictions.
- Suppress routine date changes, signature changes, generic accounting boilerplate, filing mechanics, formatting noise, harmless wording edits, exhibit-only noise, and unchanged confirmations.
- Do not include unchanged confirmations as changes.
- If Risk Factors say they have not changed materially in both filings, suppress that item entirely.
- If Legal Proceedings or environmental proceedings say there is nothing to disclose in both filings, suppress that item entirely.
- If director/Section 16 officer trading plans say none were adopted or terminated in both filings, suppress that item entirely.
- If the same executive signs both filings and only the signature date changed, suppress that item entirely.
- If beforeExcerpt and afterExcerpt are effectively the same, suppress that item entirely.
- Be skeptical. If the provided excerpts do not support a claimed change, do not invent it.
- Prefer concrete disclosure changes: new risks, removed risks, softened/hardened language, acquisitions, financing, liquidity changes, customer/supplier concentration, legal/regulatory changes, segment/revenue commentary, margin/cost commentary, debt, goodwill/intangibles, executive/governance changes, capital allocation changes, hedging/market risk, project/JV exposure, and management discussion changes.
- Return strict JSON only. No markdown.
- If no meaningful non-routine changes are visible, return an empty changes array and Low reviewPriority.

Use one of these section labels when possible:
- Risk Factors
- MD&A
- Liquidity and Capital Resources
- Business Combinations
- M&A / Strategic Transactions
- Licensing / Pipeline / R&D
- Debt and Financing
- Credit Agreements
- Capital Allocation
- Share Repurchases
- Executive / Governance Changes
- Project / Joint Venture Exposure
- Market Risk / Hedging
- Goodwill and Intangibles
- Legal Proceedings
- Revenue / Segment Commentary
- Customer / Supplier Concentration
- Accounting / Controls
- Other

JSON schema:
{
  "ticker": "string",
  "companyName": "string",
  "form": "10-Q or 10-K",
  "filingDate": "YYYY-MM-DD",
  "priorForm": "10-Q or 10-K",
  "priorFilingDate": "YYYY-MM-DD",
  "reviewPriority": "High | Medium | Low",
  "executiveSummary": "2-4 sentence neutral summary, no advice. Explain why an analyst may review it.",
  "changes": [
    {
      "section": "Risk Factors | MD&A | Liquidity and Capital Resources | Business Combinations | M&A / Strategic Transactions | Licensing / Pipeline / R&D | Debt and Financing | Credit Agreements | Capital Allocation | Share Repurchases | Executive / Governance Changes | Project / Joint Venture Exposure | Market Risk / Hedging | Goodwill and Intangibles | Legal Proceedings | Revenue / Segment Commentary | Customer / Supplier Concentration | Accounting / Controls | Other",
      "materiality": "High | Medium | Low",
      "summary": "Plain-English description of the disclosure change",
      "beforeExcerpt": "Short prior filing excerpt or direct paraphrase from provided text",
      "afterExcerpt": "Short current filing excerpt or direct paraphrase from provided text"
    }
  ],
  "analystQuestions": ["question 1", "question 2", "question 3"]
}
`;

  const user = `
Company: ${tickerInfo.title}
Ticker: ${tickerInfo.ticker}

Current filing:
- Form: ${filing.form}
- Filing date: ${filing.filingDate}
- Report date: ${filing.reportDate || "not provided"}
- Accession: ${filing.accession}
- Source URL: ${currentUrl}
- Rank score: ${filing.importanceScore || 0}
- Rank reasons: ${(filing.importanceReasons || []).join(", ") || "none"}

Primary comparison filing:
- Form: ${prior.form}
- Filing date: ${prior.filingDate}
- Report date: ${prior.reportDate || "not provided"}
- Accession: ${prior.accession}
- Comparison basis: ${prior.comparisonBasis || "previous comparable filing"}
- Source URL: ${priorUrl}

Secondary context:
${secondaryContext || "No secondary 10-K context was provided."}

PRIOR COMPARABLE FILING TEXT EXCERPTS:
${priorText}

CURRENT FILING TEXT EXCERPTS:
${currentText}
`;

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const content = response.choices?.[0]?.message?.content || "{}";
  const parsed = safeJsonParse(content);

  const normalized = normalizeModelItem(parsed, {
    ticker: tickerInfo.ticker,
    companyName: tickerInfo.title || filing.companyName,
    form: filing.form,
    filingDate: filing.filingDate,
    priorForm: prior.form,
    priorFilingDate: prior.filingDate
  });

  return {
    ...normalized,
    comparisonBasis: prior.comparisonBasis || "previous comparable filing",
    importanceScore: filing.importanceScore || 0,
    importanceReasons: filing.importanceReasons || [],
    sources: [
      { label: "Current SEC filing", url: currentUrl },
      { label: "Prior comparable filing", url: priorUrl }
    ]
  };
}

async function analyzeOneFiling(filing) {
  const tickerInfo = {
    ticker: filing.ticker,
    title: filing.companyName || filing.title,
    cik: cikPad(filing.cik)
  };

  const submissions = await getCompanySubmissions(filing.cik);
  const recent = submissions?.filings?.recent || {};
  const currentIndex = (recent.accessionNumber || []).findIndex((a) => a === filing.accession);

  const hintedPrimaryDocument =
    filing.primaryDocument ||
    (currentIndex >= 0 ? recent.primaryDocument?.[currentIndex] : null);

  const prior = findPriorComparable(submissions, filing.accession, filing.form);

  if (!prior) {
    return {
      ticker: tickerInfo.ticker,
      companyName: tickerInfo.title || filing.companyName,
      form: filing.form,
      filingDate: filing.filingDate,
      priorForm: filing.form,
      priorFilingDate: "",
      reviewPriority: "Low",
      executiveSummary:
        "A current filing was found, but a prior comparable filing was not located in the recent SEC submissions index.",
      changes: [],
      analystQuestions: [
        "Is the company newly public or missing comparable filing history?",
        "Should the analyst manually compare against the closest annual or quarterly filing?"
      ],
      importanceScore: filing.importanceScore || 0,
      importanceReasons: filing.importanceReasons || [],
      sources: filing.filingDetailUrl
        ? [{ label: "Current SEC filing detail", url: filing.filingDetailUrl }]
        : []
    };
  }

  const secondary = findSecondaryContext(submissions, filing.accession, filing.form, prior.accession);

  const currentUrl =
    filing.currentUrl ||
    await getPrimaryDocumentUrl(filing.cik, filing.accession, hintedPrimaryDocument);

  const priorUrl = await getPrimaryDocumentUrl(filing.cik, prior.accession, prior.primaryDocument);

  let secondaryContext = "";

  if (secondary) {
    secondaryContext =
      `Latest prior 10-K context exists: ${secondary.form} filed ${secondary.filingDate}, ` +
      `report date ${secondary.reportDate || "not provided"}, accession ${secondary.accession}. ` +
      `Use it only as context for whether a 10-Q change may already have been disclosed annually.`;
  }

  const [currentText, priorText] = await Promise.all([
    fetchFilingText(currentUrl, ANALYSIS_TEXT_CHARS),
    fetchFilingText(priorUrl, ANALYSIS_TEXT_CHARS)
  ]);

  if (!currentText || currentText.length < 1000) {
    throw new Error("Current filing text extraction returned too little text.");
  }

  if (!priorText || priorText.length < 1000) {
    throw new Error("Prior filing text extraction returned too little text.");
  }

  return analyzeFilingPair({
    filing,
    tickerInfo,
    prior,
    currentUrl,
    priorUrl,
    currentText,
    priorText,
    secondaryContext
  });
}

async function analyzeTop({ filingDate, filings, scanSummary }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  const startedAt = Date.now();
  const topFilings = baseSortFilings(dedupeFilings(Array.isArray(filings) ? filings : []))
    .sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0))
    .slice(0, TOP_FILINGS_TO_ANALYZE);

  const items = [];
  let skipped = 0;

  for (const filing of topFilings) {
    try {
      const item = await analyzeOneFiling(filing);
      items.push(item);
    } catch (error) {
      skipped += 1;
      items.push({
        ticker: filing.ticker,
        companyName: filing.companyName || filing.title,
        form: filing.form,
        filingDate: filing.filingDate,
        priorForm: filing.form,
        priorFilingDate: "",
        reviewPriority: "Low",
        executiveSummary: `A top-ranked filing was found, but automated comparison failed: ${error.message}`,
        changes: [],
        analystQuestions: [
          "Open the SEC source filing manually and verify whether the filing contains unusual disclosure changes.",
          "Check Vercel logs to see whether the failure came from SEC fetch, filing text extraction, or OpenAI.",
          "Retry the run if SEC EDGAR throttling or network timing is suspected."
        ],
        importanceScore: filing.importanceScore || 0,
        importanceReasons: filing.importanceReasons || [],
        sources: filing.filingDetailUrl
          ? [{ label: "SEC filing detail", url: filing.filingDetailUrl }]
          : []
      });
    }
  }

  const meaningfulChanges = items.filter(
    (item) => Array.isArray(item.changes) && item.changes.length > 0
  ).length;

  return {
    product: "Aelaro",
    version: "v8-lite",
    generatedAt: new Date().toISOString(),
    generatedAtET: nowETStamp(),
    filingDate: filingDate || todayISODateET(),
    mode: "browser-orchestrated-full-sp500-scan",
    notice:
      `Scanned the S&P 500 in browser-controlled batches, ranked the exact-date filing queue, ` +
      `and analyzed the top ${items.length} filings by likely analyst relevance.`,
    debug: {
      openaiModel: OPENAI_MODEL,
      topFilingsToAnalyze: TOP_FILINGS_TO_ANALYZE,
      secScanConcurrency: SEC_SCAN_CONCURRENCY,
      secMaxRetries: SEC_MAX_RETRIES,
      secRetryBaseMs: SEC_RETRY_BASE_MS,
      secRequestSpacingMs: SEC_REQUEST_SPACING_MS,
      rankPreviewLimit: RANK_PREVIEW_LIMIT,
      rankingPreviewChars: RANKING_PREVIEW_CHARS,
      analysisTextChars: ANALYSIS_TEXT_CHARS,
      elapsedMs: Date.now() - startedAt
    },
    summary: {
      companiesScanned: scanSummary?.companiesScanned || 0,
      filingsFound: scanSummary?.filingsFound || topFilings.length,
      filingsAnalyzed: items.length,
      meaningfulChanges,
      skipped,
      scanErrors: scanSummary?.scanErrors || 0
    },
    items
  };
}

function requireDate(value) {
  const filingDate = value || todayISODateET();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) {
    throw new Error("Invalid filingDate. Use YYYY-MM-DD.");
  }

  return filingDate;
}

function parseBody(req) {
  if (typeof req.body === "string") {
    return JSON.parse(req.body || "{}");
  }

  return req.body || {};
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    const ip = getClientIp(req);

    if (rateLimited(ip)) {
      return json(res, 429, { error: "Too many requests. Please slow down." });
    }

    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("application/json")) {
      return json(res, 400, { error: "Invalid content type. Expected application/json." });
    }

    let body = {};

    try {
      body = parseBody(req);
    } catch {
      return json(res, 400, { error: "Malformed JSON body." });
    }

    const action = body.action || "getUniverse";

    if (action === "getUniverse") {
      const startedAt = Date.now();
      const companies = await buildUniverse();

      return json(res, 200, {
        product: "Aelaro",
        version: "v8-lite",
        action,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        companies
      });
    }

    if (action === "scanBatch") {
      const filingDate = requireDate(body.filingDate);
      const payload = await scanBatch({
        filingDate,
        companies: body.companies
      });

      return json(res, 200, payload);
    }

    if (action === "rankFilings") {
      const filingDate = requireDate(body.filingDate);
      const payload = await rankFilings({
        filingDate,
        filings: body.filings
      });

      return json(res, 200, payload);
    }

    if (action === "analyzeTop") {
      const filingDate = requireDate(body.filingDate);
      const payload = await analyzeTop({
        filingDate,
        filings: body.filings,
        scanSummary: body.scanSummary || {}
      });

      return json(res, 200, payload);
    }

    return json(res, 400, { error: "Unsupported action." });
  } catch (error) {
    console.error("Aelaro API fatal error:", error);

    return json(res, 500, {
      error: "Internal server error.",
      detail: error?.message || "Unknown error"
    });
  }
}
