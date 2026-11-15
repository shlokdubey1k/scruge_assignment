// ── Config ────────────────────────────────────────────────────────────────
const API_BASE = ""; // same origin — empty means relative paths

// ── Platform metadata ──────────────────────────────────────────────────────
const PLATFORMS = {
  flipkart: {
    name: "Flipkart",
    emoji: "🛒",
    class: "flipkart",
  },
  croma: {
    name: "Croma",
    emoji: "🟢",
    class: "croma",
  },
  myntra: {
    name: "Myntra",
    emoji: "👗",
    class: "myntra",
  },
};

const CATEGORY_LABELS = {
  smartphone: "📱 Smartphone",
  television: "📺 Television",
  sneaker: "👟 Sneaker",
  clothing: "👕 Clothing",
};

const STATUS_META = {
  in_stock: {
    label: "In Stock",
    dot: true,
    link: true,
  },
  out_of_stock: {
    label: "Out of Stock",
    dot: true,
    link: true,
  },
  not_listed: {
    label: "Not Listed",
    dot: true,
    link: false,
  },
  error: {
    label: "Unavailable",
    dot: true,
    link: false,
  },
};

// ── State ─────────────────────────────────────────────────────────────────
let isLoading = false;
let stepTimer = null;

// ── DOM Helpers ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function show(id) {
  $(id).classList.remove("hidden");
}
function hide(id) {
  $(id).classList.add("hidden");
}

function resetUI() {
  hide("loading");
  hide("productInfo");
  hide("results");
  hide("errorBox");
  if (stepTimer) clearInterval(stepTimer);
}

// ── Loading Steps Animation ───────────────────────────────────────────────
function animateSteps() {
  const steps = ["step1", "step2", "step3"];
  let current = 0;

  // Activate first step immediately
  $("step1").classList.add("active");

  stepTimer = setInterval(() => {
    if (current < steps.length - 1) {
      $(steps[current]).classList.remove("active");
      $(steps[current]).classList.add("done");
      current++;
      $(steps[current]).classList.add("active");
    }
  }, 8000); // advance every 8s to match the longer real duration
}

function resetSteps() {
  ["step1", "step2", "step3"].forEach((id) => {
    $(id).classList.remove("active", "done");
  });
}

// ── Render Product Banner ─────────────────────────────────────────────────
function renderProduct(product) {
  $("productFullName").textContent = product.full_name || `${product.brand} ${product.model}`;
  $("productCategoryBadge").textContent = CATEGORY_LABELS[product.category] || product.category;

  const originalUrl = $("amazonUrl").value.trim();
  const amazonLink = $("amazonProductLink");
  if (amazonLink) {
    amazonLink.href = originalUrl || "#";
  }

  // Specs chips
  const specs = [];
  if (product.ram) specs.push({ label: "RAM", value: product.ram });
  if (product.storage) specs.push({ label: "Storage", value: product.storage });
  if (product.screen_size) specs.push({ label: "Screen", value: product.screen_size });
  if (product.colour) specs.push({ label: "Colour", value: product.colour });
  if (product.brand) specs.push({ label: "Brand", value: product.brand });
  if (product.model) specs.push({ label: "Model", value: product.model });

  $("productSpecs").innerHTML = specs
    .map((s) => `<span class="spec-chip"><strong>${s.label}:</strong> ${s.value}</span>`)
    .join("");

  // Product image (if available)
  if (product.image_url) {
    $("productImgEl").src = product.image_url;
    $("productImgEl").onerror = () => hide("productImg");
    show("productImg");
  } else {
    hide("productImg");
  }

  show("productInfo");
}

// ── Render Results ────────────────────────────────────────────────────────
function renderResults(results, platforms) {
  const grid = $("resultsGrid");
  grid.innerHTML = "";

  platforms.forEach((platformKey) => {
    const result = results[platformKey] || { status: "error", platform: platformKey };
    const meta = PLATFORMS[platformKey] || { name: platformKey, emoji: "🌐", class: "" };
    const statusMeta = STATUS_META[result.status] || STATUS_META.error;

    const card = document.createElement("div");
    card.className = `result-card ${result.status}`;

    const linkHtml =
      statusMeta.link && (result.product_url || result.search_url)
        ? `<a class="result-link" href="${result.product_url || result.search_url}" target="_blank" rel="noopener">
            View
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>`
        : "";

    const matchedName = result.matched_name
      ? `<div class="result-matched-name">${escapeHtml(result.matched_name)}</div>`
      : result.status === "not_listed"
      ? `<div class="result-matched-name">Not found on this platform</div>`
      : result.status === "error"
      ? `<div class="result-matched-name">Could not reach platform${result.error ? ": " + escapeHtml(result.error) : ""}</div>`
      : "";

    card.innerHTML = `
      <div class="result-accent"></div>
      <div class="result-body">
        <div class="result-left">
          <div class="platform-logo ${meta.class}" title="${meta.name}">
            ${meta.emoji}
          </div>
          <div class="result-info">
            <div class="result-platform">${meta.name}</div>
            ${matchedName}
          </div>
        </div>
        <div class="result-status">
          <span class="status-badge">
            <span class="status-dot"></span>
            ${statusMeta.label}
          </span>
          ${linkHtml}
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  show("results");
}

// ── Main Search Handler ───────────────────────────────────────────────────
async function handleSearch(event) {
  event.preventDefault();
  if (isLoading) return;

  const amazonUrl = $("amazonUrl").value.trim();
  if (!amazonUrl) return;

  // Reset
  resetUI();
  isLoading = true;

  // Show loading
  const btn = $("searchBtn");
  btn.disabled = true;
  $("btnText").textContent = "Searching…";
  resetSteps();
  show("loading");
  animateSteps();

  // Scroll to loading indicator
  $("loading").scrollIntoView({ behavior: "smooth", block: "center" });

  const abortController = new AbortController();
  const clientTimeout = setTimeout(() => {
    abortController.abort();
  }, 120000); // 120s (2 minutes) to allow for live cross-platform scraping & Gemini AI matching

  try {
    const response = await fetch(`${API_BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amazon_url: amazonUrl }),
      signal: abortController.signal,
    });

    clearTimeout(clientTimeout);
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Search failed. Please try again.");
    }

    // Stop loading
    if (stepTimer) clearInterval(stepTimer);
    hide("loading");

    // Render
    renderProduct(data.product);
    renderResults(data.results, data.platforms);

    // Scroll to product
    $("productInfo").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    clearTimeout(clientTimeout);
    if (stepTimer) clearInterval(stepTimer);
    hide("loading");

    let displayMsg = err.message || "An unexpected error occurred.";
    if (err.name === "AbortError") {
      displayMsg =
        "The search request took longer than 2 minutes to complete. Please check the terminal logs or try again.";
    }

    $("errorMsg").textContent = displayMsg;
    show("errorBox");
    $("errorBox").scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    clearTimeout(clientTimeout);
    isLoading = false;
    btn.disabled = false;
    $("btnText").textContent = "Search";
  }
}

// ── Escape HTML ───────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Paste URL hint ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const input = $("amazonUrl");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("searchForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
  }
});
