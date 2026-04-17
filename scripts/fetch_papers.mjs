import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const JOURNALS = [
  "American Journal of Clinical Nutrition",
  "Journal of Nutrition",
  "Advances in Nutrition",
  "Current Developments in Nutrition",
  "Nutrition Reviews",
  "British Journal of Nutrition",
  "Nutrition",
  "Clinical Nutrition",
  "Clinical Nutrition ESPEN",
  "Clinical Nutrition Open Science",
  "Journal of the Academy of Nutrition and Dietetics",
  "Journal of Human Nutrition and Dietetics",
  "Nutrients",
  "European Journal of Clinical Nutrition",
  "European Journal of Nutrition",
  "Annals of Nutrition and Metabolism",
  "Frontiers in Nutrition",
  "Journal of Nutritional Biochemistry",
  "Molecular Nutrition & Food Research",
  "Public Health Nutrition",
  "Maternal & Child Nutrition",
  "Obesity Reviews",
  "International Journal of Obesity",
  "Appetite",
  "Journal of Cachexia Sarcopenia and Muscle",
  "Nutrition Journal",
  "Nutrition & Dietetics",
  "Nutrition in Clinical Practice",
  "Journal of Parenteral and Enteral Nutrition",
  "Journal of Nutrition Education and Behavior",
  "Pediatric Obesity",
  "Clinical Obesity",
];

const TOPICS = [
  "malnutrition",
  "nutritional assessment",
  "nutrition support",
  "dietary intervention",
  "medical nutrition therapy",
  "sarcopenia",
  "cachexia",
  "vitamin D",
  "iron deficiency",
  "obesity",
  "insulin resistance",
  "NAFLD",
  "metabolic syndrome",
  "GLP-1",
  "dietary patterns",
  "ultra-processed foods",
  "gut microbiome",
  "nutrigenomics",
  "enteral nutrition",
  "parenteral nutrition",
  "ICU nutrition",
  "breastfeeding",
  "pregnancy nutrition",
  "omega-3",
  "micronutrient supplementation",
  "protein supplementation",
  "body composition",
  "inflammation diet",
  "Mediterranean diet",
  "food bioactive",
  "nutritional epidemiology",
  "food environment",
  "food insecurity",
  "complementary feeding",
  "refeeding syndrome",
  "polyphenols",
  "diet therapy",
  "bariatric surgery nutrition",
  "semaglutide tirzepatide",
];

const HEADERS = { "User-Agent": "NutritionBrainBot/1.0 (research aggregator)" };

function collectSeenPmids(docsDir, lookbackDays) {
  const seen = new Set();
  try {
    const files = readdirSync(docsDir).filter(
      (f) => f.startsWith("nutrition-") && f.endsWith(".html")
    );
    const cutoff = new Date(Date.now() - lookbackDays * 86400000);
    for (const f of files) {
      const dateMatch = f.match(/nutrition-(\d{4}-\d{2}-\d{2})\.html/);
      if (!dateMatch) continue;
      const fileDate = new Date(dateMatch[1]);
      if (fileDate < cutoff) continue;
      try {
        const html = readFileSync(`${docsDir}/${f}`, "utf-8");
        const pmidRegex = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g;
        let m;
        while ((m = pmidRegex.exec(html)) !== null) {
          seen.add(m[1]);
        }
      } catch {}
    }
  } catch {}
  console.error(
    `[INFO] Collected ${seen.size} previously seen PMIDs from last ${lookbackDays} days`
  );
  return seen;
}

function buildQuery(days = 7, maxJournals = 15) {
  const journalPart = JOURNALS.slice(0, maxJournals)
    .map((j) => `"${j}"[Journal]`)
    .join(" OR ");
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 86400000);
  const lookbackStr = lookback.toISOString().slice(0, 10).replace(/-/g, "/");
  return `(${journalPart}) AND "${lookbackStr}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(query, retmax = 50) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(retmax),
    sort: "date",
    retmode: "json",
  });
  try {
    const resp = await fetch(`${PUBMED_SEARCH}?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: "pubmed",
    id: pmids.join(","),
    retmode: "xml",
  });
  try {
    const resp = await fetch(`${PUBMED_FETCH}?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

function parseXml(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];

    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    const abstracts = [];
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = stripTags(absMatch[1]).trim();
      if (text) abstracts.push(label ? `${label}: ${text}` : text);
    }
    const abstract = abstracts.join(" ").slice(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : "";

    const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    const parts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
    const dateStr = parts.join(" ");

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch?.[1] || "";
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    const keywords = [];
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      const kw = stripTags(kwMatch[1]).trim();
      if (kw) keywords.push(kw);
    }

    papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
  }
  return papers;
}

function getTaipeiDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "7" },
      "max-papers": { type: "string", default: "50" },
      output: { type: "string", default: "papers.json" },
      json: { type: "boolean", default: false },
      "lookback-dedup": { type: "string", default: "0" },
    },
  });

  const days = parseInt(values.days, 10);
  const maxPapers = parseInt(values["max-papers"], 10);
  const lookbackDedup = parseInt(values["lookback-dedup"], 10);

  let seenPmids = new Set();
  if (lookbackDedup > 0) {
    seenPmids = collectSeenPmids("docs", lookbackDedup);
  }

  const query = buildQuery(days);
  console.error(
    `[INFO] Searching PubMed for nutrition papers from last ${days} days...`
  );

  let pmids = await searchPapers(query, maxPapers);
  console.error(`[INFO] Found ${pmids.length} papers from PubMed`);

  if (seenPmids.size > 0) {
    const before = pmids.length;
    pmids = pmids.filter((id) => !seenPmids.has(id));
    console.error(
      `[INFO] Dedup: ${before} -> ${pmids.length} (removed ${before - pmids.length} already seen in last ${lookbackDedup} days)`
    );
  }

  if (!pmids.length) {
    const output = {
      date: getTaipeiDate().toISOString().slice(0, 10),
      count: 0,
      papers: [],
    };
    writeFileSync(values.output, JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No new papers found, saved empty result");
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const outputData = {
    date: getTaipeiDate().toISOString().slice(0, 10),
    count: papers.length,
    papers,
  };

  writeFileSync(values.output, JSON.stringify(outputData, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${values.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
