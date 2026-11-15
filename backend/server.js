/**
 * Scruge — Founding Backend Engineer Assignment
 * Backend: Node.js HTTP server (zero external dependencies)
 * Uses Gemini API for product extraction + cross-platform matching
 * Uses built-in http/https/zlib for web scraping with decompression & hard timeouts
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const zlib = require("zlib");
require("./dotenv").config({ path: path.join(__dirname, "../.env") });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, "../frontend");

const GIT_COMMIT =
  (process.env.RENDER_GIT_COMMIT && process.env.RENDER_GIT_COMMIT.slice(0, 7)) ||
  process.env.GIT_COMMIT ||
  (() => {
    try {
      return require("child_process").execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "07788c3";
    }
  })();

function makeDdgUrl(q) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`;
}

const serverLogs = [];
function log(msg) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  serverLogs.push(entry);
  if (serverLogs.length > 300) serverLogs.shift();
}

// ─── HTTP Utilities with Decompression & Hard Timeout ──────────────────────

function fetchUrl(targetUrl, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error(`Too many redirects for ${targetUrl}`));
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const timeoutMs = options.timeout || 7000; // 7s default hard timeout

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "close",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        ...options.headers,
      },
    };

    let settled = false;
    const finish = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const req = lib.request(reqOptions, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // Discard unread response data to release the socket
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          redirectUrl = new URL(redirectUrl, targetUrl).href;
        }
        return fetchUrl(redirectUrl, options, redirectCount + 1).then(
          finish(resolve),
          finish(reject)
        );
      }

      // Decompress stream if server sent compressed body
      let stream = res;
      const encoding = (res.headers["content-encoding"] || "").toLowerCase();
      try {
        if (encoding === "gzip") {
          const gunzip = zlib.createGunzip();
          res.pipe(gunzip);
          stream = gunzip;
        } else if (encoding === "deflate") {
          const inflate = zlib.createInflate();
          res.pipe(inflate);
          stream = inflate;
        } else if (encoding === "br") {
          const brotli = zlib.createBrotliDecompress();
          res.pipe(brotli);
          stream = brotli;
        }
      } catch {
        stream = res;
      }

      const chunks = [];
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => {
        const fullBuf = Buffer.concat(chunks);
        const body = fullBuf.toString("utf8");
        finish(resolve)({
          status: res.statusCode,
          body,
          headers: res.headers,
          url: targetUrl,
        });
      });
      stream.on("error", (err) => {
        finish(reject)(err);
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${targetUrl}`));
    }, timeoutMs);

    req.on("error", (err) => {
      finish(reject)(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── Gemini API with Model Fallbacks, Retry & Hard Timeout ─────────────────

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",  // fallback mentioned in deprecation messages
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw single attempt against one model (no retry logic)
function callGeminiOnce(prompt, modelName) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  });

  return new Promise((resolve, reject) => {
    const timeoutMs = 10000; // 10s hard limit per attempt
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Gemini timed out (${modelName})`));
    }, timeoutMs);

    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.write(body);
    req.end();
  });
}

// Main callGemini: retries the working model on 503 overload with backoff.
// Only skips to the next model on 404 (deprecated/not found).
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set in .env file");

  let lastError = "";

  for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
    const modelName = GEMINI_MODELS[mi];
    const MAX_RETRIES = 3; // retry overloaded model up to 3x with fast backoff

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { statusCode, body } = await callGeminiOnce(prompt, modelName);
        const parsed = JSON.parse(body);

        // ── Success ──────────────────────────────────────────────────────
        if (!parsed.error) {
          if (attempt > 1) log(`✅ Gemini: ${modelName} OK on attempt ${attempt}`);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          return text
            .replace(/^```json\s*/im, "")
            .replace(/^```\s*/im, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
        }

        // ── API-level error ───────────────────────────────────────────────
        const errMsg = parsed.error.message || "";
        const errCode = parsed.error.code || statusCode;
        lastError = `[${modelName}] HTTP ${errCode}: ${errMsg}`;
        log(`⚠️  Gemini ${lastError.substring(0, 120)}`);

        // Auth errors — throw immediately, no point retrying
        const isAuthError =
          errCode === 401 || errCode === 403 ||
          errMsg.toLowerCase().includes("api key") ||
          errMsg.toLowerCase().includes("not authorized") ||
          errMsg.toLowerCase().includes("permission denied");
        if (isAuthError) throw new Error(`Gemini authentication failed: ${errMsg}`);

        // Model deprecated / not found — skip to next model, no retry
        const isDeprecated =
          statusCode === 404 || errCode === 404 ||
          errMsg.includes("no longer available") ||
          errMsg.includes("not found") ||
          errMsg.includes("not supported");
        if (isDeprecated) {
          log(`🔄 ${modelName}: deprecated → trying ${GEMINI_MODELS[mi + 1] || "none"}`);
          break; // move to next model
        }

        // Overloaded — RETRY SAME MODEL with quick 1s, 2s backoff
        const isOverloaded =
          statusCode === 429 || statusCode === 503 ||
          errMsg.includes("high demand") ||
          errMsg.includes("overloaded") ||
          errMsg.includes("capacity") ||
          errMsg.includes("temporarily");
        if (isOverloaded) {
          if (attempt < MAX_RETRIES) {
            const waitMs = attempt * 1200; // 1.2s, 2.4s
            log(`⏳ ${modelName} overloaded (attempt ${attempt}/${MAX_RETRIES}), retrying in ${(waitMs/1000).toFixed(1)}s...`);
            await sleep(waitMs);
            continue; // retry SAME model
          } else {
            log(`⚡ ${modelName} still overloaded after ${MAX_RETRIES} retries → trying ${GEMINI_MODELS[mi + 1] || "none"}`);
            break; // exhausted retries, try next model
          }
        }

        // Other error — try next model
        log(`⚠️  ${modelName} unknown error → trying ${GEMINI_MODELS[mi + 1] || "none"}`);
        break;

      } catch (err) {
        if (err.message.startsWith("Gemini authentication")) throw err;
        lastError = err.message;
        // Network / timeout — retry once then move on
        if (attempt < MAX_RETRIES) {
          log(`⚠️  ${modelName} network error (attempt ${attempt}): ${err.message}. Retrying...`);
          await sleep(1500);
        } else {
          log(`⚠️  ${modelName} failed after ${MAX_RETRIES} attempts → trying ${GEMINI_MODELS[mi + 1] || "none"}`);
          break;
        }
      }
    }
  }

  throw new Error(
    `Gemini API is under high load right now. Last error: ${lastError}. ` +
    `Please wait a few seconds and try again.`
  );
}

// ─── HTML Text Extraction ──────────────────────────────────────────────────

function extractText(html, platform = "") {
  if (!html) return "";

  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Preserve product URLs for e-commerce sites
  if (platform.toLowerCase().includes("flipkart")) {
    cleaned = cleaned.replace(
      /<a[^>]+href=["']((?:https?:\/\/www\.flipkart\.com)?\/[^"']+?\/p\/[a-zA-Z0-9]+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, path, text) => {
        let cleanPath = path.split("?")[0];
        if (!cleanPath.startsWith("http")) cleanPath = `https://www.flipkart.com${cleanPath}`;
        const inner = text.replace(/<[^>]+>/g, " ").trim();
        return `${inner} [URL: ${cleanPath}] `;
      }
    );
  } else if (platform.toLowerCase().includes("croma")) {
    cleaned = cleaned.replace(
      /<a[^>]+href=["']((?:https?:\/\/www\.croma\.com)?\/[a-zA-Z0-9_-]+?\/p\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, path, text) => {
        let cleanPath = path.split("?")[0];
        if (!cleanPath.startsWith("http")) cleanPath = `https://www.croma.com${cleanPath}`;
        const inner = text.replace(/<[^>]+>/g, " ").trim();
        return `${inner} [URL: ${cleanPath}] `;
      }
    );
  } else if (platform.toLowerCase().includes("myntra")) {
    cleaned = cleaned.replace(
      /<a[^>]+href=["']((?:https?:\/\/www\.myntra\.com)?\/[a-zA-Z0-9_/-]+?\/\d+\/buy[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, path, text) => {
        let cleanPath = path.split("?")[0];
        if (!cleanPath.startsWith("http")) {
          if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
          cleanPath = `https://www.myntra.com${cleanPath}`;
        }
        const inner = text.replace(/<[^>]+>/g, " ").trim();
        return `${inner} [URL: ${cleanPath}] `;
      }
    );
  }

  cleaned = cleaned
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  return cleaned.trim().substring(0, 6500);
}

// Extract ASIN (Amazon Standard Identification Number) from any Amazon URL
function extractASIN(amazonUrl) {
  try {
    const parsed = new URL(amazonUrl);
    // Match /dp/ASIN or /gp/product/ASIN or /product/ASIN
    const asinMatch =
      parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
      parsed.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
      parsed.pathname.match(/\/product\/([A-Z0-9]{10})/i) ||
      parsed.pathname.match(/\/([A-Z0-9]{10})\/?$/i);
    if (asinMatch) return asinMatch[1].toUpperCase();
    // Check query params (e.g. ?asin=B0...)
    const asinParam = parsed.searchParams.get("asin") || parsed.searchParams.get("ASIN");
    if (asinParam && /^[A-Z0-9]{10}$/i.test(asinParam)) return asinParam.toUpperCase();
  } catch {}
  return "";
}

// Extract product title slug from Amazon URL (e.g. /Samsung-Galaxy-S24/dp/B0...)
function extractProductFromUrl(amazonUrl) {
  try {
    const parsed = new URL(amazonUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (
        (parts[i].toLowerCase() === "dp" || parts[i].toLowerCase() === "product") &&
        i > 0 &&
        !/^[A-Z0-9]{10}$/i.test(parts[i - 1]) &&
        parts[i - 1].includes("-")
      ) {
        return decodeURIComponent(parts[i - 1]).replace(/[-_+]/g, " ").trim();
      }
    }
    if (parts.length > 0 && parts[0].includes("-") && !/^[A-Z0-9]{10}$/i.test(parts[0])) {
      return decodeURIComponent(parts[0]).replace(/[-_+]/g, " ").trim();
    }
  } catch {}
  return "";
}

// Search DuckDuckGo HTML for the product name given an ASIN with multi-query fallback
async function lookupAsinViaDDG(asin) {
  const queries = [
    `${asin} site:amazon.in`,
    `${asin} amazon`,
    `${asin} price india`,
    `${asin}`,
  ];
  for (const q of queries) {
    const searchUrl = makeDdgUrl(q);
    log(`🦆 Looking up ASIN ${asin} via DuckDuckGo ("${q}")...`);
    try {
      const { body } = await fetchUrl(searchUrl, {
        timeout: 6000,
        headers: {
          Referer: "https://duckduckgo.com/",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const text = extractText(body).substring(0, 2500);
      if (text && text.length > 60 && !text.includes("No results")) {
        log(`🦆 DuckDuckGo returned ${text.length} chars for query "${q}"`);
        return text;
      }
    } catch (err) {
      log(`🦆 DuckDuckGo lookup note: ${err.message}`);
    }
  }
  return "";
}

// ─── Amazon Scraper with Bot-Check Resilient Fallbacks ─────────────────────

async function scrapeAmazon(amazonUrl) {
  log(`📥 Reading Amazon link: ${amazonUrl}`);

  // Always extract ASIN — works for all Amazon URL formats including /dp/ASIN
  const asin = extractASIN(amazonUrl);
  if (asin) log(`🔖 Detected ASIN: ${asin}`);

  // Also try extracting product name from slug
  const urlHint = extractProductFromUrl(amazonUrl);
  if (urlHint) log(`🔎 Product slug in URL: "${urlHint}"`);

  let pageText = "";
  let pageTitle = "";

  // Attempt 1: Fetch clean ASIN URL, mobile web URL, or original URL
  try {
    const candidateUrls = [];
    if (asin) {
      candidateUrls.push(`https://www.amazon.in/dp/${asin}`);
      candidateUrls.push(`https://www.amazon.in/gp/aw/d/${asin}`); // Amazon Mobile Web
    }
    if (!candidateUrls.includes(amazonUrl)) candidateUrls.push(amazonUrl);

    for (const testUrl of candidateUrls) {
      if (pageText && pageTitle) break;
      try {
        const res = await fetchUrl(testUrl, {
          timeout: 6000,
          headers: { "Accept-Language": "en-IN,en;q=0.9" },
        });

        if (res && res.body) {
          const { body, status } = res;
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch) {
            const rawTitle = titleMatch[1].replace(/Amazon\.in\s*[:—|]?\s*/i, "").trim();
            if (!/robot check|captcha|sorry|access denied|page not found|404/i.test(rawTitle)) {
              pageTitle = rawTitle;
            }
          }

          const isBotCheck =
            status === 503 ||
            status === 404 ||
            body.includes("Robot Check") ||
            body.includes("api-services-support@amazon.com") ||
            body.includes("Enter the characters you see below") ||
            body.includes("Sorry, we just need to make sure you");

          if (!isBotCheck && body.length > 500) {
            const extracted = extractText(body);
            if (extracted.length > 100) {
              pageText = extracted;
              log(`✅ Amazon page fetched successfully via ${testUrl} (${pageText.length} chars)`);
              break;
            }
          }
        }
      } catch {}
    }
  } catch (err) {
    log(`⚠️  Amazon fetch note: ${err.message}`);
  }

  // Attempt 2: If Amazon blocked us or returned thin content, look up ASIN via DuckDuckGo
  if ((!pageText || pageText.length < 100) && asin) {
    const ddgText = await lookupAsinViaDDG(asin);
    if (ddgText) pageText = (pageText ? pageText + "\n" : "") + ddgText;
  }

  // Attempt 3: If still thin, lookup by product slug on DuckDuckGo
  if ((!pageText || pageText.length < 100) && urlHint) {
    try {
      const { body } = await fetchUrl(makeDdgUrl(`"${urlHint}" site:amazon.in`), {
        timeout: 6000,
        headers: { Referer: "https://duckduckgo.com/" },
      });
      const ddgSlugText = extractText(body).substring(0, 2000);
      if (ddgSlugText) pageText = (pageText ? pageText + "\n" : "") + ddgSlugText;
    } catch {}
  }

  // Build combined context
  const contextParts = [];
  if (asin) contextParts.push(`Amazon ASIN: ${asin}`);
  if (urlHint) contextParts.push(`Product name from URL: "${urlHint}"`);
  if (pageTitle) contextParts.push(`Page title: "${pageTitle}"`);
  if (pageText) contextParts.push(`Page/search content:\n${pageText}`);

  const combinedContext = contextParts.join("\n\n");

  // If we have literally nothing, give up
  if (!combinedContext.trim()) {
    throw new Error(
      "Unable to retrieve any product data for this Amazon URL. The page may be temporarily unavailable or the URL may be invalid."
    );
  }

  log(`🤖 Extracting product details with Gemini...`);
  const prompt = `You are analyzing an Amazon India product listing.
Extract the product details and return ONLY valid JSON (no markdown, no other text):
{
  "brand": "brand name (e.g. Samsung, Apple, Sony, Nike, Puma, Levi's, Campus)",
  "model": "model name or number (e.g. Galaxy S24, iPhone 15, Bravia X90L, Smashic, Smash v2)",
  "category": "one of exactly: smartphone | television | sneaker | clothing | other",
  "ram": "RAM if smartphone (e.g. '8 GB'), otherwise null",
  "storage": "storage if smartphone (e.g. '128 GB' or '256 GB'), otherwise null",
  "screen_size": "screen size if television (e.g. '55 inch' or '43 inch'), otherwise null",
  "colour": "colour if sneaker or clothing (e.g. 'Black', 'White', 'Blue'), otherwise null",
  "full_name": "clean human-readable product title",
  "image_url": null
}

Rules:
- Category MUST be one of: smartphone, television, sneaker, clothing, other
- All shoes, casual shoes, sports shoes, sneakers, trainers, footwear MUST be categorized as 'sneaker'
- All shirts, t-shirts, polos, jerseys, tops, apparel MUST be categorized as 'clothing'
- All mobile phones and smartphones MUST be categorized as 'smartphone'
- All TVs and televisions MUST be categorized as 'television'
- Brand names like Puma, Nike, Adidas, Campus, Sparx, Skechers, Asics almost always produce 'sneaker' or 'clothing'
- For smartphones, RAM and storage are critical specs
- For televisions, screen size is a critical spec
- For sneakers and clothing (t-shirts, polos, jerseys), colour is critical. Extract the primary colour (e.g. 'White', 'Black', 'Blue'). If multi-tone or marketing names appear (e.g. 'Puma White-Puma Black', 'Triple Black'), extract the main colour or colourway (e.g. 'White' or 'White/Black'). If unknown, use null.
- If the context only contains an ASIN with minimal other info, use your training knowledge about that ASIN if available. Otherwise return your best guess with what you have.
- If a spec is not found, use null

Context:
${combinedContext.substring(0, 4000)}`;

  const raw = await callGemini(prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error("Could not parse Amazon product details from AI response");
    }
  }

  if (!parsed.full_name) {
    parsed.full_name = [parsed.brand, parsed.model, parsed.colour, parsed.ram, parsed.storage]
      .filter(Boolean)
      .join(" ");
  }

  log(
    `✅ Identified: [${(parsed.category || "").toUpperCase()}] ${parsed.brand} ${parsed.model} (${getSpecsDesc(parsed)})`
  );
  return parsed;
}

// ─── Query Builder & Specs ─────────────────────────────────────────────────

function cleanQueryString(str) {
  if (!str) return "";
  return str
    .replace(/[-_+/]/g, " ")
    .replace(/\b(unisex|men's|mens|women's|womens|solid|regular fit|slim fit|5g ai smartphone|5g smartphone|smartphone|smart tv|4k ultra hd smart led google tv|google tv|television|sneakers?|shoes?|t-?shirts?)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildQuery(product) {
  const brand = (product.brand || "").trim();
  let model = cleanQueryString(product.model || "");

  if (model.toLowerCase().startsWith(brand.toLowerCase())) {
    model = model.slice(brand.length).trim();
  }

  const parts = [brand, model];
  const isApple = brand.toLowerCase().includes("apple") || model.toLowerCase().includes("iphone");

  // Only include RAM in query if not Apple (Apple/retailers never include RAM in iPhone listing titles)
  if (!isApple && product.ram && !model.toLowerCase().includes(product.ram.toLowerCase())) {
    parts.push(product.ram);
  }
  if (product.storage && !model.toLowerCase().includes(product.storage.toLowerCase())) {
    parts.push(product.storage);
  }
  if (product.screen_size && !model.toLowerCase().includes(product.screen_size.toLowerCase())) {
    parts.push(product.screen_size);
  }
  if (product.colour && !model.toLowerCase().includes(product.colour.toLowerCase())) {
    parts.push(product.colour);
  }

  // Deduplicate words
  const words = parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
  const seen = new Set();
  const cleanWords = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      cleanWords.push(w);
    }
  }

  return cleanWords.join(" ");
}

function buildFallbackQuery(product) {
  const brand = (product.brand || "").trim();
  let model = cleanQueryString(product.model || "");
  if (model.toLowerCase().startsWith(brand.toLowerCase())) {
    model = model.slice(brand.length).trim();
  }
  const words = model.split(/\s+/).filter(Boolean).slice(0, 2);
  return `${brand} ${words.join(" ")}`.trim();
}

function getSpecsDesc(product) {
  if (product.category === "smartphone")
    return `RAM: ${product.ram || "N/A"}, Storage: ${product.storage || "N/A"}`;
  if (product.category === "television")
    return `Screen size: ${product.screen_size || "N/A"}`;
  if (product.category === "sneaker" || product.category === "clothing")
    return `Colour: ${product.colour || "N/A"}`;
  return "";
}

// ─── DuckDuckGo Result Parser (Structured Candidates) ─────────────────────

function parseDdgResults(html, allowedDomain, requirePath) {
  const candidates = [];
  const seenUrls = new Set();
  const blocks = html.split(/class=["'][^"']*result\s+results_links/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    // Extract title & URL from result__a
    const aMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;

    let href = aMatch[1];
    if (href.includes("uddg=")) {
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
    }

    if (!href.includes(allowedDomain)) continue;
    if (requirePath && !href.includes(requirePath)) continue;

    let cleanUrl = href.split("?")[0];
    if (seenUrls.has(cleanUrl)) continue;

    // Filter out category, search, blog, and mailer landing pages
    if (
      cleanUrl.endsWith("/search") ||
      cleanUrl.includes("/mailers") ||
      cleanUrl.includes("/pr?sid=") ||
      cleanUrl.includes("/all-products") ||
      cleanUrl.includes("/clp/") ||
      cleanUrl.includes("/bc/") ||
      cleanUrl.includes("/unboxed/")
    ) {
      continue;
    }

    const title = aMatch[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    // Extract snippet
    let snippet = "";
    const sMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (sMatch) {
      snippet = sMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }

    // Determine stock accurately (avoiding "out of 5 stars" ratings)
    let inStock = true;
    if (
      /\b(currently out of stock|sold out|temporarily unavailable|notify me)\b/i.test(snippet) &&
      !/\bout of\s+[1-5]\b/i.test(snippet)
    ) {
      inStock = false;
    }

    seenUrls.add(cleanUrl);
    candidates.push({
      title,
      url: cleanUrl,
      details: snippet,
      inStock,
    });

    if (candidates.length >= 8) break;
  }

  return candidates;
}

// ─── Direct Flipkart HTML Candidate Extractor ──────────────────────────────

function extractFlipkartCandidates(html) {
  const candidates = [];
  const seenUrls = new Set();

  const linkRegex = /<a[^>]+href=["']((?:https?:\/\/www\.flipkart\.com)?\/[^"']+?\/p\/(itm[a-zA-Z0-9]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    let href = m[1];
    if (!href.startsWith("http")) href = `https://www.flipkart.com${href}`;
    const cleanUrl = href.split("?")[0];
    if (seenUrls.has(cleanUrl)) continue;

    const rawInner = m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const titleAttrMatch = m[0].match(/title=["']([^"']+)["']/i);
    const title = titleAttrMatch ? titleAttrMatch[1] : rawInner;

    if (!title || title.length < 5) continue;

    seenUrls.add(cleanUrl);
    candidates.push({
      title,
      url: cleanUrl,
      details: rawInner,
      inStock: true,
    });

    if (candidates.length >= 8) break;
  }

  return candidates;
}

// ─── Live PDP Stock Verifier ───────────────────────────────────────────────

async function verifyLiveStock(platform, productUrl) {
  if (!productUrl || !productUrl.startsWith("http")) return true;
  try {
    const { body, status } = await fetchUrl(productUrl, {
      timeout: 4500,
      headers: {
        Referer:
          platform === "flipkart"
            ? "https://www.flipkart.com/"
            : platform === "croma"
            ? "https://www.croma.com/"
            : "https://www.myntra.com/",
      },
    });

    if (status !== 200 || !body) return true;

    if (platform === "flipkart") {
      // Flipkart signals for Out Of Stock / Sold Out:
      // 1. NOTIFY_ME button / action type
      // 2. "Currently unavailable" / "Sold Out"
      if (/NOTIFY_ME|Notify Me|Currently unavailable|Sold Out/i.test(body)) {
        return false;
      }
      // If Buy Now or Add to Cart is explicitly present, it is in stock
      if (/Buy Now|Add to Cart/i.test(body)) {
        return true;
      }
    }

    if (platform === "croma") {
      // Croma signals for Out Of Stock:
      // 1. Both Buy Now and Add to Cart buttons disabled (e.g. disableBuyNow and disableCartBtn)
      if (body.includes("disableBuyNow") && body.includes("disableCartBtn")) {
        return false;
      }
      if (/\b(out of stock|sold out|currently unavailable|notify me)\b/i.test(body)) {
        return false;
      }
    }

    if (platform === "myntra") {
      if (/"outOfStock":\s*true|"isOutOfStock":\s*true|Out of Stock/i.test(body)) {
        return false;
      }
    }
  } catch (e) {
    // If request times out or is blocked, keep previous stock estimation
  }
  return true;
}

// ─── Candidate-Based AI Matching Engine ────────────────────────────────────

async function matchCandidatesWithGemini(platform, product, candidates, searchUrl) {
  const candidatesList = candidates
    .map(
      (c, i) =>
        `[${i + 1}] Title: ${c.title}\n    URL: ${c.url}\n    Details: ${c.details || "N/A"}\n    Reported Stock: ${
          c.inStock ? "In Stock" : "Out of Stock"
        }`
    )
    .join("\n\n");

  const prompt = `You are a precise e-commerce product matcher.

TARGET PRODUCT FROM AMAZON:
- Brand: ${product.brand}
- Model: ${product.model}
- Category: ${product.category}
- Key Specs: ${getSpecsDesc(product)}
- Full Title: ${product.full_name}

CANDIDATES FOUND ON ${platform.toUpperCase()}:
${candidatesList}

MATCHING RULES:
1. Examine each candidate. Pick the ONE candidate (by its 1-based number: 1, 2, 3...) that is the EXACT SAME PRODUCT as the Amazon target.
2. Matching specifications:
   - Brand and model line must match (e.g. "Smash Leather" is "Smash v2 L" / "Smash v2 Leather", "Galaxy S24" is "Samsung Galaxy S24", "iPhone 15" is "Apple iPhone 15").
   - For smartphones: RAM AND storage must BOTH match.
     * Storage must match exactly (e.g. 128 GB matches 128 GB; a 128 GB target NEVER matches a 256 GB candidate).
     * RAM must match the hardware variant (e.g. an 8 GB RAM model must NOT match a 6 GB or 12 GB model).
     * For devices with fixed hardware RAM architectures (such as Apple iPhone 15 where all base models have 6 GB RAM), verify that the model and storage match the target's 6 GB RAM configuration.
   - For televisions: Screen size must match (e.g. 55 inch matches 55 inch / 138.8 cm). For Sony televisions, retail channel sister model lines sharing the identical hardware chassis/specs (such as online exclusive KD-55X74L and retail counterpart KD-55X75L / SONY X75L 55 inch) are the same model line.
   - For sneakers and clothing: Colour must match. Primary colour and marketing variants are acceptable (e.g. "White" matches "Puma White", "White-Black", "All White", "White / Black"; "Black" matches "Puma Black", "Core Black"). If the target colour is not specified (null), match the base model in any primary colourway.
3. Completely different products (such as phone cases, cables, t-shirts when searching shoes, different sneaker models, or wrong specs) MUST NOT match.
4. If NO candidate is the exact same product, set matched_index = 0.
5. Stock status:
   - Any listed item with a price or available to view is IN STOCK (in_stock = true).
   - ONLY set in_stock = false if the candidate explicitly states "Currently Out of Stock", "Sold Out", or "Temporarily Unavailable" (do not confuse "out of 5 stars" rating with stock!).

Return ONLY valid JSON (no markdown):
{
  "matched_index": 1,
  "in_stock": true,
  "confidence": "high | medium | low",
  "reason": "short explanation of the match or why none matched"
}`;

  try {
    const raw = await callGemini(prompt);
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
    }

    const idx = result?.matched_index;
    if (!idx || idx < 1 || idx > candidates.length) {
      log(`⚪ [${platform}] Not listed (Gemini matched_index: ${idx || 0}). Reason: ${result?.reason || "No match"}`);
      return { status: "not_listed", platform, search_url: searchUrl };
    }

    const matched = candidates[idx - 1];
    let inStock = result.in_stock !== false && matched.inStock !== false;

    // Run live PDP verification for the matched product to ensure accurate stock
    if (inStock && matched.url) {
      log(`🔎 [${platform}] Verifying live stock on matched product page...`);
      const liveStock = await verifyLiveStock(platform, matched.url);
      if (liveStock === false) {
        log(`🟡 [${platform}] Live PDP confirmed: Product is OUT OF STOCK.`);
        inStock = false;
      } else {
        log(`🟢 [${platform}] Live PDP confirmed: Product is IN STOCK.`);
      }
    }

    const status = inStock ? "in_stock" : "out_of_stock";

    log(
      `🎯 [${platform}] MATCH FOUND! Candidate [${idx}]: Status: ${status.toUpperCase()} -> "${matched.title}" [${matched.url}]`
    );

    return {
      status,
      platform,
      product_url: matched.url,
      matched_name: matched.title,
      confidence: result.confidence || "high",
    };
  } catch (err) {
    log(`⚠️  [${platform}] Matching error (${err.message}), showing as not listed.`);
    return { status: "not_listed", platform, search_url: searchUrl };
  }
}

// ─── Platform Searchers ────────────────────────────────────────────────────

async function searchFlipkart(product) {
  const query = buildQuery(product);
  const fallbackQuery = buildFallbackQuery(product);
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://www.flipkart.com/search?q=${encoded}&marketplace=FLIPKART`;
  log(`🛒 [Flipkart] Searching: "${query}"`);

  let candidates = [];

  // Tier 1: Direct Flipkart search page
  try {
    const { body, status } = await fetchUrl(searchUrl, {
      timeout: 6000,
      headers: { Referer: "https://www.flipkart.com/" },
    });

    if (status === 200 && body) {
      candidates = extractFlipkartCandidates(body);
      if (candidates.length > 0) {
        log(`🛒 [Flipkart] Found ${candidates.length} candidates via direct search.`);
      }
    }
  } catch (e) {
    log(`⚠️  [Flipkart] Direct search note: ${e.message}`);
  }

  // Tier 2: DuckDuckGo index (if direct search empty OR exact model not found in direct candidates)
  const normModel = (product.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasExactModel = normModel && candidates.some((c) =>
    c.title.toLowerCase().replace(/[^a-z0-9]/g, "").includes(normModel) ||
    c.url.toLowerCase().replace(/[^a-z0-9]/g, "").includes(normModel)
  );

  if (!hasExactModel) {
    log(`🦆 [Flipkart] Exact model not confirmed in direct search; querying DuckDuckGo index for: "${query}"...`);
    const fkDdgQueries = [
      `${query} site:flipkart.com`,
      `${query} flipkart`,
      `${fallbackQuery} flipkart`,
    ];
    for (const ddgQ of fkDdgQueries) {
      if (candidates.length >= 4) break;
      const ddgUrl = makeDdgUrl(ddgQ);
      try {
        const { body } = await fetchUrl(ddgUrl, {
          timeout: 6000,
          headers: { Referer: "https://duckduckgo.com/" },
        });
        const ddgCandidates = parseDdgResults(body, "flipkart.com", "/p/");
        for (const dc of ddgCandidates) {
          if (!candidates.some((c) => c.url === dc.url) && candidates.length < 8) {
            candidates.push(dc);
          }
        }
      } catch (e) {}
    }
    if (candidates.length > 0) {
      log(`🦆 [Flipkart] Total candidates after DuckDuckGo: ${candidates.length}`);
    }
  }

  // Tier 3: DuckDuckGo index with core fallback query
  if (candidates.length === 0 && fallbackQuery && fallbackQuery !== query) {
    log(`🦆 [Flipkart] Trying broader fallback query on DuckDuckGo: "${fallbackQuery}"...`);
    const ddgUrl = makeDdgUrl(fallbackQuery + " site:flipkart.com");
    try {
      const { body } = await fetchUrl(ddgUrl, {
        timeout: 6000,
        headers: { Referer: "https://duckduckgo.com/" },
      });
      candidates = parseDdgResults(body, "flipkart.com", "/p/");
      if (candidates.length > 0) {
        log(`🦆 [Flipkart] Found ${candidates.length} candidates via fallback query.`);
      }
    } catch (e) {}
  }

  if (candidates.length === 0) {
    log(`🛒 [Flipkart] No matching products found.`);
    return { status: "not_listed", platform: "flipkart", search_url: searchUrl };
  }

  log(`🤖 [Flipkart] Evaluating ${candidates.length} candidate(s) with Gemini...`);
  return await matchCandidatesWithGemini("flipkart", product, candidates, searchUrl);
}

async function searchCroma(product) {
  const query = buildQuery(product);
  const fallbackQuery = buildFallbackQuery(product);
  const cleanPhone = `${product.brand} ${product.model} ${product.storage || ""}`.trim();
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://www.croma.com/searchB?q=${encoded}%3Arelevance&text=${encoded}`;
  log(`🟢 [Croma] Searching: "${query}"`);

  let candidates = [];

  // Tier 1: Croma internal API with query variants
  const apiQueries = [query];
  if (cleanPhone && !apiQueries.includes(cleanPhone)) apiQueries.push(cleanPhone);
  if (fallbackQuery && !apiQueries.includes(fallbackQuery)) apiQueries.push(fallbackQuery);

  for (const q of apiQueries) {
    if (candidates.length > 0) break;
    try {
      const apiUrl = `https://api.croma.com/searchservices/v1/search?currentPage=0&query=${encodeURIComponent(
        q
      )}&fields=FULL`;
      const { body, status } = await fetchUrl(apiUrl, {
        timeout: 5000,
        headers: { Referer: "https://www.croma.com/", Accept: "application/json" },
      });
      if (status === 200 && body.trim().startsWith("{")) {
        const data = JSON.parse(body);
        const products = data.products || [];
        for (const p of products.slice(0, 8)) {
          const name = p.name || p.summary || "";
          const price = p.price?.formattedValue || (p.price?.value ? `₹${p.price.value}` : "");
          const code = p.code || "";
          const prodUrl = p.url ? `https://www.croma.com${p.url}` : `https://www.croma.com/p/${code}`;
          const inStock = p.stock?.stockLevelStatus !== "outOfStock";
          candidates.push({
            title: name,
            url: prodUrl,
            details: `${price} | ${inStock ? "In Stock" : "Out of Stock"}`,
            inStock,
          });
        }
        if (candidates.length > 0) log(`🟢 [Croma] Found ${candidates.length} candidates via API for query "${q}".`);
      }
    } catch (e) {}
  }

  // Tier 2: DuckDuckGo index with multiple query formats (keyword & site: queries)
  // Note: DuckDuckGo often returns 0 results for 'site:croma.com' due to strict indexing,
  // whereas querying '${query} croma' reliably returns direct croma.com product links.
  const ddgVariants = [
    `${cleanPhone || query} croma`,
    `${query} croma`,
    `${query} site:croma.com`,
    `${fallbackQuery} croma`,
    `${fallbackQuery} site:croma.com`,
  ];

  const seenDdgQueries = new Set();
  for (const ddgQ of ddgVariants) {
    if (candidates.length >= 4) break;
    if (seenDdgQueries.has(ddgQ.toLowerCase())) continue;
    seenDdgQueries.add(ddgQ.toLowerCase());

    log(`🦆 [Croma] Querying DuckDuckGo index for: "${ddgQ}"...`);
    const ddgUrl = makeDdgUrl(ddgQ);
    try {
      const { body } = await fetchUrl(ddgUrl, {
        timeout: 6000,
        headers: { Referer: "https://duckduckgo.com/" },
      });
      // Prefer actual product pages (/p/) first, then broader croma pages
      const found = parseDdgResults(body, "croma.com", "/p/");
      for (const c of found) {
        if (!candidates.some((existing) => existing.url === c.url) && candidates.length < 8) {
          candidates.push(c);
        }
      }
      if (candidates.length === 0) {
        const anyCroma = parseDdgResults(body, "croma.com");
        for (const c of anyCroma) {
          if (!candidates.some((existing) => existing.url === c.url) && candidates.length < 8) {
            candidates.push(c);
          }
        }
      }
      if (candidates.length > 0) {
        log(`🦆 [Croma] Total candidates after "${ddgQ}": ${candidates.length}`);
      }
    } catch (e) {}
  }

  if (candidates.length === 0) {
    log(`🟢 [Croma] No matching products found.`);
    return { status: "not_listed", platform: "croma", search_url: searchUrl };
  }

  log(`🤖 [Croma] Evaluating ${candidates.length} candidate(s) with Gemini...`);
  return await matchCandidatesWithGemini("croma", product, candidates, searchUrl);
}

async function searchMyntra(product) {
  const query = buildQuery(product);
  const fallbackQuery = buildFallbackQuery(product);
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fallbackUrl = `https://www.myntra.com/${slug}`;
  log(`👗 [Myntra] Searching: "${query}"`);

  let candidates = [];

  // Tier 1: Myntra Gateway JSON API
  const apiUrls = [
    `https://www.myntra.com/gateway/v2/search/${slug}?rows=10&o=0&plaEnabled=false`,
    `https://www.myntra.com/gateway/v2/search/?q=${encodeURIComponent(query)}&rows=10&o=0`,
  ];

  for (const apiUrl of apiUrls) {
    if (candidates.length > 0) break;
    try {
      const { body, status } = await fetchUrl(apiUrl, {
        timeout: 5000,
        headers: {
          Referer: "https://www.myntra.com/",
          "x-meta-app": "appFamily=web",
          Accept: "application/json, text/plain, */*",
        },
      });

      if (status === 200 && body.trim().startsWith("{")) {
        const data = JSON.parse(body);
        const products = data.products || [];
        for (const p of products.slice(0, 8)) {
          let landing = (p.landingPageUrl || "").trim().replace(/^\/+/, "");
          if (!landing && p.productId) landing = `${p.productId}/buy`;
          const prodUrl = landing.startsWith("http") ? landing : `https://www.myntra.com/${landing}`;
          const brand = p.brand || "";
          const name = p.productDisplayName || p.productName || "";
          const price = p.price ? `₹${p.price}` : "";
          const colour = p.primaryColour || "";
          const inStock = p.outOfStock !== true;
          candidates.push({
            title: `${brand} ${name}`,
            url: prodUrl,
            details: `Colour: ${colour} | Price: ${price}`,
            inStock,
          });
        }
        if (candidates.length > 0) log(`👗 [Myntra] Found ${candidates.length} candidates via API.`);
      }
    } catch (e) {}
  }

  // Tier 2: HTML window.__myx state
  if (candidates.length === 0) {
    try {
      const { body } = await fetchUrl(fallbackUrl, {
        timeout: 5000,
        headers: { Referer: "https://www.myntra.com/" },
      });
      const myxMatch = body.match(/window\.__myx\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
      if (myxMatch) {
        const myx = JSON.parse(myxMatch[1]);
        const products = myx?.searchData?.results?.products || [];
        for (const p of products.slice(0, 8)) {
          let landing = (p.landingPageUrl || "").trim().replace(/^\/+/, "");
          if (!landing && p.productId) landing = `${p.productId}/buy`;
          const prodUrl = landing.startsWith("http") ? landing : `https://www.myntra.com/${landing}`;
          const brand = p.brand || "";
          const name = p.productDisplayName || p.productName || "";
          const price = p.price ? `₹${p.price}` : "";
          const colour = p.primaryColour || "";
          const inStock = p.outOfStock !== true;
          candidates.push({
            title: `${brand} ${name}`,
            url: prodUrl,
            details: `Colour: ${colour} | Price: ${price}`,
            inStock,
          });
        }
        if (candidates.length > 0) log(`👗 [Myntra] Found ${candidates.length} candidates via window.__myx.`);
      }
    } catch (e) {}
  }

  // Tier 3: DuckDuckGo index with primary query
  if (candidates.length === 0) {
    log(`🦆 [Myntra] Querying DuckDuckGo index for: "${query}"...`);
    const ddgUrl = makeDdgUrl(query + " site:myntra.com");
    try {
      const { body } = await fetchUrl(ddgUrl, {
        timeout: 6000,
        headers: { Referer: "https://duckduckgo.com/" },
      });
      candidates = parseDdgResults(body, "myntra.com");
      for (const c of candidates) {
        if (!c.url.endsWith("/buy") && /\/\d+$/.test(c.url)) {
          c.url += "/buy";
        }
      }
      if (candidates.length > 0) log(`🦆 [Myntra] Found ${candidates.length} candidates via DuckDuckGo.`);
    } catch (e) {}
  }

  // Tier 4: DuckDuckGo index with core fallback query
  if (candidates.length === 0 && fallbackQuery && fallbackQuery !== query) {
    log(`🦆 [Myntra] Trying broader fallback query on DuckDuckGo: "${fallbackQuery}"...`);
    const ddgUrl = makeDdgUrl(fallbackQuery + " site:myntra.com");
    try {
      const { body } = await fetchUrl(ddgUrl, {
        timeout: 6000,
        headers: { Referer: "https://duckduckgo.com/" },
      });
      candidates = parseDdgResults(body, "myntra.com");
      for (const c of candidates) {
        if (!c.url.endsWith("/buy") && /\/\d+$/.test(c.url)) {
          c.url += "/buy";
        }
      }
      if (candidates.length > 0) log(`🦆 [Myntra] Found ${candidates.length} candidates via fallback query.`);
    } catch (e) {}
  }

  if (candidates.length === 0) {
    log(`👗 [Myntra] No matching products found.`);
    return { status: "not_listed", platform: "myntra", search_url: fallbackUrl };
  }

  log(`🤖 [Myntra] Evaluating ${candidates.length} candidate(s) with Gemini...`);
  return await matchCandidatesWithGemini("myntra", product, candidates, fallbackUrl);
}

// ─── Category → Platform Mapping ──────────────────────────────────────────

const PLATFORMS = {
  smartphone: ["flipkart", "croma"],
  television: ["flipkart", "croma"],
  sneaker: ["flipkart", "myntra"],
  clothing: ["flipkart", "myntra"],
};

const SEARCHERS = {
  flipkart: searchFlipkart,
  croma: searchCroma,
  myntra: searchMyntra,
};

function normalizeCategory(product) {
  let cat = (product.category || "").toLowerCase();
  const allText = `${cat} ${product.full_name || ""} ${product.model || ""} ${product.brand || ""}`.toLowerCase();

  if (/phone|mobile|smartphone|iphone|galaxy\s+[sa]|oneplus|redmi|realme|pixel/i.test(allText)) {
    return "smartphone";
  }
  if (/tv|television|bravia|qled|oled|smart\s+led/i.test(allText)) {
    return "television";
  }
  if (/shoe|sneaker|footwear|trainer|running|smash|smashic|court|loafer|boot|kicks|sandal|slide|canvas/i.test(allText)) {
    return "sneaker";
  }
  if (/cloth|shirt|polo|jersey|t-?shirt|apparel|top|wear|cotton\s+tee|jacket|hoodie|trouser/i.test(allText)) {
    return "clothing";
  }

  // Brand-based inference if category is still unknown or "other"
  if (cat === "other" || !PLATFORMS[cat]) {
    if (/puma|nike|adidas|campus|sparx|reebok|asics|skechers|bata|woodland/i.test(allText)) {
      return "sneaker";
    }
    if (/levi|allen\s+solly|van\s+heusen|u\.?s\.?\s+polo|wrangler|pepe|zara|h&m/i.test(allText)) {
      return "clothing";
    }
    if (/samsung|apple|oneplus|xiaomi|motorola|oppo|vivo|iqoo/i.test(allText)) {
      return "smartphone";
    }
    if (/sony|lg|tcl|mi\s+tv|hisense|vu|acer\s+tv/i.test(allText)) {
      return "television";
    }
  }

  return cat || "other";
}

// ─── Main Request Handler ──────────────────────────────────────────────────

async function handleSearch(reqBody) {
  const { amazon_url } = reqBody;
  if (!amazon_url) throw new Error("amazon_url is required");

  let parsedUrl;
  try {
    parsedUrl = new URL(amazon_url);
  } catch {
    throw new Error("Please enter a valid URL (e.g. https://www.amazon.in/dp/...)");
  }

  if (!parsedUrl.hostname.includes("amazon") && !parsedUrl.hostname.includes("amzn")) {
    throw new Error("Please provide a valid Amazon product URL");
  }

  const startTime = Date.now();
  log(`\n========================================`);
  log(`🚀 New Search Request: ${amazon_url}`);

  // Step 1: Extract product from Amazon
  const product = await scrapeAmazon(amazon_url);
  const category = normalizeCategory(product);
  product.category = category;

  if (!PLATFORMS[category]) {
    throw new Error(
      `Product "${product.full_name || product.brand || 'Item'}" was detected as category "${product.category}", which is not one of the supported categories: Smartphones, Televisions, Sneakers, T-shirts/Polos/Jerseys.`
    );
  }

  // Step 2: Search all relevant platforms concurrently
  const platforms = PLATFORMS[category];
  log(`🌐 Checking platforms in parallel: ${platforms.join(", ")}`);

  const searchPromises = platforms.map((p) =>
    SEARCHERS[p](product).catch((err) => ({
      status: "not_listed",
      platform: p,
      error: err.message,
    }))
  );

  const searchResults = await Promise.all(searchPromises);

  const results = {};
  for (let i = 0; i < platforms.length; i++) {
    results[platforms[i]] = searchResults[i];
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`✨ Search complete in ${elapsed}s!`);
  log(`========================================\n`);

  return { product, platforms, results };
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    let output = data;
    if (filePath.endsWith("index.html")) {
      const htmlStr = data.toString("utf8").replace("{{COMMIT_HASH}}", GIT_COMMIT);
      output = Buffer.from(htmlStr, "utf8");
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(output);
  });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const parsedReq = url.parse(req.url, true);
  const pathname = parsedReq.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Health check
  if (pathname === "/api/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", gemini: !!GEMINI_API_KEY, commit: GIT_COMMIT }));
    return;
  }

  // API: Version / Commit Info
  if (pathname === "/api/version" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ commit: GIT_COMMIT }));
    return;
  }

  // API: Live Debug Logs
  if (pathname === "/api/debug" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          commit: GIT_COMMIT,
          uptime_seconds: Math.floor(process.uptime()),
          logs_count: serverLogs.length,
          logs: serverLogs,
        },
        null,
        2
      )
    );
    return;
  }

  // API: Test Gemini key — hits the API and returns the raw response
  if (pathname === "/api/test-key" && req.method === "GET") {
    const modelsToTest = [
      "gemini-3.8-flash",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-2.0-flash-exp",
      "gemini-2.0-flash-lite",
    ];
    const results = [];
    for (const m of modelsToTest) {
      try {
        const { statusCode, body } = await callGeminiOnce("Reply with the word OK", m);
        const parsed = JSON.parse(body);
        results.push({
          model: m,
          http_status: statusCode,
          ok: !parsed.error,
          reply: parsed.error ? null : parsed.candidates?.[0]?.content?.parts?.[0]?.text,
          error: parsed.error?.message || null,
        });
      } catch (e) {
        results.push({ model: m, http_status: 0, ok: false, error: e.message });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
    return;
  }

  // API: Product search
  if (pathname === "/api/search" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const reqBody = JSON.parse(body);
        const result = await handleSearch(reqBody);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        log(`❌ Search failed: ${e.message}`);
        const status =
          e.message.includes("required") || e.message.includes("valid Amazon") ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Static files (frontend)
  let filePath;
  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(FRONTEND_DIR, "index.html");
  } else {
    filePath = path.join(FRONTEND_DIR, pathname);
    if (!filePath.startsWith(FRONTEND_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "text/plain";
  serveFile(res, filePath, contentType);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Scruge Product Finder is LIVE at http://localhost:${PORT}`);
    console.log(`📋 API: POST http://localhost:${PORT}/api/search`);

    console.log(`🔑 Gemini Key: ${GEMINI_API_KEY ? "✓ Loaded" : "✗ NOT SET (.env file)"}`);

    console.log(`======================================================\n`);
  });
}

module.exports = {
  server,
  handleSearch,
  scrapeAmazon,
  buildQuery,
  buildFallbackQuery,
  searchFlipkart,
  searchCroma,
  searchMyntra,
  matchCandidatesWithGemini,
  callGemini,
  fetchUrl,
  parseDdgResults,
  extractFlipkartCandidates,
  verifyLiveStock,
  fetchUrl,
  parseDdgResults,
  extractFlipkartCandidates,
  verifyLiveStock,
};
