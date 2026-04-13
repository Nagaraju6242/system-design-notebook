const STORAGE_KEY = "sddk-completed";

function getCompleted() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
}

function setCompleted(path, done) {
  const data = getCompleted();
  if (done) data[path] = true;
  else delete data[path];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getPagePath() {
  return location.pathname.replace(/\/$/, "").replace(/^\//, "") || "index";
}

function addCheckboxToPage() {
  const path = getPagePath();
  if (path === "" || path === "index") return;

  const article = document.querySelector("article.md-content__inner");
  if (!article) return;

  const h1 = article.querySelector("h1");
  if (!h1) return;

  const completed = getCompleted();
  const wrapper = document.createElement("div");
  wrapper.className = "completion-toggle";
  wrapper.innerHTML = `<label><input type="checkbox" ${completed[path] ? "checked" : ""}> Mark as completed</label>`;
  article.appendChild(wrapper);

  wrapper.querySelector("input").addEventListener("change", function () {
    setCompleted(path, this.checked);
    updateSidebar();
  });
}

function updateSidebar() {
  const completed = getCompleted();
  document.querySelectorAll(".md-nav__link").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;

    // Resolve relative href to absolute path
    const a = document.createElement("a");
    a.href = href;
    const resolved = a.pathname.replace(/\/$/, "").replace(/^\//, "") || "index";

    link.classList.toggle("completed-page", !!completed[resolved]);
  });
}

function updateIndexProgress() {
  const container = document.getElementById("progress-tracker");
  if (!container) return;

  const completed = getCompleted();
  const categories = {
    Transactions: [
      "transactions/database-transactions",
      "transactions/database-isolation-levels",
      "transactions/database-locking-and-concurrency",
      "transactions/pessimistic-locking-strategies",
      "transactions/optimistic-locking-patterns",
      "transactions/flash-sale-inventory-patterns",
    ],
    "Distributed Systems": [
      "distributed-systems/introduction-to-distributed-systems",
      "distributed-systems/cap-and-pacelc-theorem",
      "distributed-systems/consistency-models",
      "distributed-systems/distributed-transactions",
      "distributed-systems/failure-handling-patterns",
      "distributed-systems/consensus-algorithms",
    ],
    "Geospatial Search": [
      "geospatial/geospatial-search-introduction",
      "geospatial/geohash",
      "geospatial/quadtrees",
      "geospatial/h3-hexagonal-indexing",
      "geospatial/space-filling-curves-and-hilberts-curve",
      "geospatial/googles-s2-library",
      "geospatial/designing-a-map-rendering-service",
      "geospatial/choosing-a-spatial-index",
    ],
    "Search Engine Mechanics": [
      "search/inverted-index-fundamentals",
      "search/tf-idf-scoring-explained",
      "search/bm25-and-parameter-tuning",
      "search/elasticsearch-architecture-essentials",
      "search/advanced-search-patterns",
    ],
    "Media Systems": [
      "media/video-transcoding-and-playback",
      "media/file-chunking",
    ],
    "Probabilistic Data Structures": [
      "probabilistic/probabilistic-data-structures-overview",
      "probabilistic/bloom-filters-part-1",
      "probabilistic/bloom-filters-part-2",
      "probabilistic/count-min-sketch-part-1",
      "probabilistic/count-min-sketch-part-2",
      "probabilistic/hyperloglog-part-1",
      "probabilistic/hyperloglog-part-2",
    ],
  };

  let totalDone = 0,
    totalAll = 0,
    html = "";

  for (const [name, pages] of Object.entries(categories)) {
    const done = pages.filter((p) => completed[p]).length;
    totalDone += done;
    totalAll += pages.length;
    const pct = Math.round((done / pages.length) * 100);
    html += `<div class="category-progress">
      <div class="category-header"><span>${name}</span><span>${done}/${pages.length}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  }

  const totalPct = Math.round((totalDone / totalAll) * 100);
  container.innerHTML =
    `<div class="overall-progress">
      <div class="category-header"><strong>Overall Progress</strong><strong>${totalDone}/${totalAll}</strong></div>
      <div class="progress-bar overall"><div class="progress-fill" style="width:${totalPct}%"></div></div>
    </div>` + html;
}

function initTocProgress() {
  const path = getPagePath();
  if (path === "" || path === "index") return;

  const tocLinks = document.querySelectorAll(".md-sidebar--secondary .md-nav__link");
  if (!tocLinks.length) return;

  const completed = getCompleted();

  // If page is marked complete, tick all TOC items
  if (completed[path]) {
    tocLinks.forEach((link) => link.classList.add("toc-read"));
    return;
  }

  // Map each TOC link to its target heading
  const tocMap = [];
  tocLinks.forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    const id = href.split("#")[1];
    if (!id) return;
    const heading = document.getElementById(id);
    if (heading) tocMap.push({ link, heading });
  });

  function updateTocOnScroll() {
    // If page got marked complete while reading, tick all
    if (getCompleted()[path]) {
      tocMap.forEach(({ link }) => link.classList.add("toc-read"));
      return;
    }

    const scrollY = window.scrollY + window.innerHeight * 0.3;
    tocMap.forEach(({ link, heading }) => {
      if (heading.offsetTop < scrollY) {
        link.classList.add("toc-read");
      }
    });
  }

  window.addEventListener("scroll", updateTocOnScroll, { passive: true });
  updateTocOnScroll();
}

document.addEventListener("DOMContentLoaded", function () {
  addCheckboxToPage();
  updateSidebar();
  updateIndexProgress();
  initTocProgress();
});
