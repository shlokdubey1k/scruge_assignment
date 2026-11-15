# PriceScout — Scruge Backend Assignment

> Paste an Amazon link → instantly see if the same product is listed on Flipkart, Croma, and Myntra — and whether you can buy it right now.

---

## Quick Start

### 1. Set your Gemini API key

```bash
# Copy the example env file
copy .env.example .env
```

Open `.env` and paste your Gemini API key:
```
GEMINI_API_KEY=AIza...your_key_here
PORT=3000
```

Get a free key at: https://aistudio.google.com/app/apikey

### 2. Start the server

```bash
node backend/server.js
```

### 3. Open the app

Navigate to **http://localhost:3000** in your browser.

Paste any Amazon India product link and hit **Search**.

---

## Supported Categories

| Category | Platforms Checked |
|---|---|
| 📱 Smartphones | Flipkart + Croma |
| 📺 Televisions | Flipkart + Croma |
| 👟 Sneakers | Flipkart + Myntra |
| 👕 T-shirts / Polos / Jerseys | Flipkart + Myntra |

---

## How It Works

```
Amazon URL
    │
    ▼
Scrape Amazon page
    │
    ▼
Gemini extracts: brand, model, category, RAM/storage/size/colour
    │
    ▼
Search each platform concurrently (Flipkart / Croma / Myntra)
    │
    ▼
Gemini matches: same product? same specs? in stock?
    │
    ▼
Return: In Stock 🟢 / Out of Stock 🟡 / Not Listed ⚫
```

See [MATCHING_EXPLAINED.md](./MATCHING_EXPLAINED.md) for the architecture and matching logic.

---

## Project Structure

```
scruge_assignment/
├── backend/
│   ├── server.js        # Node.js HTTP server + all backend logic
│   └── dotenv.js        # Zero-dependency env loader
├── frontend/
│   ├── index.html       # App UI
│   ├── style.css        # Styles
│   └── app.js           # Frontend JS
├── .env.example         # Template for environment variables
├── package.json
├── MATCHING_EXPLAINED.md  # Matching logic & architecture guide
└── README.md
```

---

## API

### `POST /api/search`

**Request:**
```json
{
  "amazon_url": "https://www.amazon.in/dp/B0CHX1W1XY"
}
```

**Response (success):**
```json
{
  "success": true,
  "product": {
    "brand": "Samsung",
    "model": "Galaxy S24",
    "category": "smartphone",
    "ram": "8 GB",
    "storage": "128 GB",
    "colour": null,
    "screen_size": null,
    "full_name": "Samsung Galaxy S24 5G AI Smartphone (Marble Gray, 8GB, 128GB Storage)"
  },
  "platforms": ["flipkart", "croma"],
  "results": {
    "flipkart": {
      "status": "in_stock",
      "platform": "flipkart",
      "product_url": "https://www.flipkart.com/...",
      "matched_name": "Samsung Galaxy S24 5G (Marble Gray, 8 GB, 128 GB)",
      "confidence": "high"
    },
    "croma": {
      "status": "not_listed",
      "platform": "croma",
      "search_url": "https://www.croma.com/searchB?q=..."
    }
  }
}
```

**Status values:**
- `in_stock` — found and buyable, includes `product_url`
- `out_of_stock` — found but unavailable, includes `product_url`
- `not_listed` — not sold on this platform, includes `search_url`
- `error` — could not reach platform, includes `error` message

---

## Technical Notes

- **No npm packages required** — uses only Node.js built-ins (`http`, `https`, `fs`, `path`, `url`)
- **Zero-dependency dotenv** — custom minimal `.env` loader in `backend/dotenv.js`
- **AI-powered matching** — Gemini 2.0 Flash handles product extraction and cross-platform matching
- **Concurrent search** — all platforms are searched in parallel (`Promise.all`)
- **Myntra** — tries JSON search API first, falls back to HTML scraping
- **Robust HTML parsing** — strips scripts/styles, sends clean text to Gemini (no DOM dependency)

---

## Example Amazon URLs to Test

| Category | Sample URL |
|---|---|
| Smartphone | `https://www.amazon.in/Samsung-Storage-Snapdragon-Processor-Included/dp/B0CHX1W1XY` |
| Television | `https://www.amazon.in/Sony-Bravia-139cm-Google-Television/dp/B0C4RB1SHY` |
| Sneaker | `https://www.amazon.in/Nike-Womens-Running-Shoes/dp/...` |
| T-shirt | `https://www.amazon.in/Levi-Mens-T-Shirt/dp/...` |
