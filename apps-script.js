// ── Google Apps Script — Kellerbuch backend ──────────────────────────────────
// Deploy via: Apps Script editor → Deploy → Manage deployments → New version
// Works either bound to the Sheet (Extensions → Apps Script) or as a
// standalone project — see SPREADSHEET_ID below.
// Sheet tab name must match SHEET_NAME exactly (case-sensitive)
// Columns: A=Producer, B=Wine, C=Vintage, D=Quantity, E=Region, F=Country,
//          G=Grapes, H=Acidity, I=Flavour, J=Einkaufspreis, K=Agent,
//          L=Shopify price, M=Menu price, N=Shopify variant ID

const SHEET_NAME = "sheet1";
const DISCREPANCY_LOG_NAME = "Discrepancy Log";

// Leave blank if this script is bound to the Sheet (Extensions → Apps
// Script from inside the Sheet itself) — it'll use the active spreadsheet.
// If running as a standalone script project instead, paste the Sheet's ID
// here (from its URL: docs.google.com/spreadsheets/d/THIS_PART/edit).
const SPREADSHEET_ID = "";

function getSpreadsheet_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

// ── HEADERS ───────────────────────────────────────────────────────────────────
const HEADERS = [
  "Producer", "Wine", "Vintage", "Quantity",
  "Region", "Country", "Grapes", "Acidity", "Flavour",
  "Einkaufspreis", "Agent", "Shopify price", "Menu price", "Shopify variant ID"
];

function doGet(e) {
  const sheet = getSpreadsheet_().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const rows = data.slice(1)
    .filter(row => row[0] && String(row[0]).trim() !== "")
    .map(row => ({
      producer: row[0],
      wine: row[1],
      vintage: row[2] || null,
      quantity: row[3] || 0,
    }));
  return ContentService.createTextOutput(JSON.stringify({ ok: true, inventory: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Vintage is part of the matching key going forward. Legacy rows with no
// vintage, and incoming changes where the vintage couldn't be resolved,
// both normalize to "" — an "unknown" bucket that only matches itself.
function normVintage_(v) {
  return String(v == null ? "" : v).trim();
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const sheet = getSpreadsheet_().getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();

    if (payload.action === "stocktake") {
      return doStocktake_(payload, sheet, data);
    }

    const unmatched = [];

    payload.changes.forEach(ch => {
      let found = false;
      for (let i = 1; i < data.length; i++) {
        if (!data[i][0] || String(data[i][0]).trim() === "") continue;

        // Match on producer + wine + vintage.
        const sameProducer = String(data[i][0]).toLowerCase() === String(ch.producer || "").toLowerCase();
        const sameWine = String(data[i][1] || "").toLowerCase() === String(ch.wine || "").toLowerCase();
        const sameVintage = normVintage_(data[i][2]) === normVintage_(ch.vintage);
        if (sameProducer && sameWine && sameVintage) {
          const delta = ch.action === "remove" ? -ch.quantity : ch.quantity;
          const newQty = Math.max(0, Number(data[i][3] || 0) + delta);
          sheet.getRange(i + 1, 4).setValue(newQty);
          data[i][3] = newQty;
          found = true;
          break;
        }
      }
      if (!found) {
        if (ch.action === "add") {
          sheet.appendRow([ch.producer, ch.wine, ch.vintage ?? "", ch.quantity]);
        } else {
          // Don't silently drop a removal that doesn't match any row — with
          // vintage now part of the key, a mismatch here is exactly the kind
          // of thing that must surface, not vanish (see CLAUDE.md removal UX rule).
          unmatched.push({ producer: ch.producer, wine: ch.wine, vintage: ch.vintage ?? "" });
        }
      }
    });

    if (unmatched.length) {
      const desc = unmatched.map(u => u.producer + " " + u.wine + (u.vintage ? " " + u.vintage : " (o.J.)")).join(", ");
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Nicht gefunden: " + desc, unmatched }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── STOCK-TAKE ────────────────────────────────────────────────────────────────
function doStocktake_(payload, sheet, data) {
  const { producer, wine, vintage, counted, magnums } = payload;

  for (let i = 1; i < data.length; i++) {
    if (!data[i][0] || String(data[i][0]).trim() === "") continue;
    const sameProducer = String(data[i][0]).toLowerCase() === String(producer || "").toLowerCase();
    const sameWine     = String(data[i][1] || "").toLowerCase() === String(wine || "").toLowerCase();
    const sameVintage  = normVintage_(data[i][2]) === normVintage_(vintage);
    if (!sameProducer || !sameWine || !sameVintage) continue;

    const expected = Number(data[i][3] || 0);
    const delta    = counted - expected;

    sheet.getRange(i + 1, 4).setValue(counted);

    if (delta !== 0) {
      logDiscrepancy_(producer, wine, vintage, expected, counted, magnums || 0);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, expected, counted, delta, magnums: magnums || 0 })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ ok: false, error: "Wein nicht gefunden" })
  ).setMimeType(ContentService.MimeType.JSON);
}

function logDiscrepancy_(producer, wine, vintage, expected, counted, magnums) {
  const ss = getSpreadsheet_();
  let log = ss.getSheetByName(DISCREPANCY_LOG_NAME);
  if (!log) {
    log = ss.insertSheet(DISCREPANCY_LOG_NAME);
    const headers = ["Datum", "Produzent", "Wein", "Jahrgang", "Erwartet", "Gezählt", "Magnums", "Delta", "Status"];
    log.appendRow(headers);
    log.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  log.appendRow([
    new Date(),
    producer,
    wine,
    vintage || "",
    expected,
    counted,
    magnums,
    counted - expected,
    "Unreviewed",
  ]);
}

// ── ONE-TIME SHOPIFY IMPORT ───────────────────────────────────────────────────
// Run this ONCE from the Apps Script editor to populate the sheet from Shopify.
// Before running: set Script Properties (gear icon → Project Settings →
// Script Properties) with keys: SHOPIFY_DOMAIN, SHOPIFY_TOKEN, ANTHROPIC_KEY
//
// SHOPIFY_DOMAIN  — e.g. zippiri.myshopify.com
// SHOPIFY_TOKEN   — Admin API access token (read_products + read_inventory)
// ANTHROPIC_KEY   — your Anthropic API key (sk-ant-...)
//
// The function writes to the sheet but does NOT push anything back to Shopify.
// Review the sheet carefully before doing anything else.

function importFromShopify() {
  const props = PropertiesService.getScriptProperties();
  const SHOPIFY_DOMAIN = props.getProperty("SHOPIFY_DOMAIN");
  const SHOPIFY_TOKEN  = props.getProperty("SHOPIFY_TOKEN");
  const ANTHROPIC_KEY  = props.getProperty("ANTHROPIC_KEY");

  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN || !ANTHROPIC_KEY) {
    throw new Error("Missing Script Properties. Set SHOPIFY_DOMAIN, SHOPIFY_TOKEN, ANTHROPIC_KEY.");
  }

  Logger.log("Fetching Shopify products…");
  const products = fetchShopifyProducts_(SHOPIFY_DOMAIN, SHOPIFY_TOKEN);
  Logger.log("Fetched " + products.length + " active products.");

  Logger.log("Parsing titles with Claude…");
  const parsed = parseWithClaude_(products, ANTHROPIC_KEY);
  Logger.log("Parsed " + parsed.length + " wines.");

  Logger.log("Writing to sheet…");
  writeImportToSheet_(parsed);
  Logger.log("Done. Review the sheet before proceeding.");
}

function fetchShopifyProducts_(domain, token) {
  const url = "https://" + domain + "/admin/api/2024-01/products.json?status=active&limit=250&fields=id,title,variants";
  const res = UrlFetchApp.fetch(url, {
    headers: { "X-Shopify-Access-Token": token }
  });
  const data = JSON.parse(res.getContentText());

  const products = [];
  data.products.forEach(p => {
    // Most wine products have a single variant; if there are multiple
    // (e.g. different bottle sizes), take each as a separate row.
    p.variants.forEach(v => {
      products.push({
        shopifyTitle: p.title + (p.variants.length > 1 ? " — " + v.title : ""),
        variantId: String(v.id),
        price: v.price,
        quantity: v.inventory_quantity,
      });
    });
  });
  return products;
}

function parseWithClaude_(products, apiKey) {
  const titlesBlock = products.map((p, i) => (i + 1) + ". " + p.shopifyTitle).join("\n");

  const prompt = `You are parsing Shopify wine product titles for a restaurant cellar inventory.
For each numbered title, extract the producer, wine name (without producer name and without vintage year), and vintage year.

Use this known cellar wine list as your primary reference for producer and wine name spelling:
Bellavista | Alma Assemblage 2
Bellavista | Teatro Alla Scala Brut
Bellavista | Pas Operé Extra Brut
Contadi Castaldi | Brùt
Deutz | Champagne Brut Classic
Berivagus | Blanc de Blancs Vintage
Frescobaldi | Leonia Pomino Brut
Corte Quaira | Saccomani Veneri Brut
Schlossgut Diel | Riesling Réserve Extra Brut
Sella & Mosca | Alghero Torbato Spumante
J. Trautwein | Infinitea
Sella & Mosca | La Cala Reale
Sella & Mosca | Terre Bianche
Cantina Capellini | Alba Bianco
Colli VaiBo' | Lugana
Tenuta Capofaro | Vigna di Paola
Cantine De Gregorio | Bianco di San Lorenzo
Frescobaldi | Pomino Bianco
Gut Hermannsberg | Just Riesling!
Dr. Loosen | Riesling Blauschiefer
Salwey | Grauburgunder
Argiolas | Cerdeña
Schlossgut Diel | Pinot Gris Resèrve
Cantina Terlan | Winkl
Sella & Mosca | Cannonau di Sardegna Riserva
Sella & Mosca | Terre Rare
Sella & Mosca | Tanca Farrà
Cantine De Gregorio | Haris
Tenuta Tascante | Ghiaia Nera
Tua Rita | Rosso dei Notri
Alberto Longo | Primitivo
I Vini del Mare Belvento | Sirēno
Petra | Hebo
Sella & Mosca | Marchese di Villamarina Riserva
Fattoria Le Pupille | Poggio Valente
Agricola Punica | Barrua
Sella & Mosca | Ambat
Sella & Mosca | Cuvée 161
Cantine De Gregorio | Rahana
Tenuta Monreale Agnello | Mhinoe
Tenuta Valle delle Ferle | Murgentia Bianco
Tenuta Regaleali | Vigna San Francesco
Guado al Melo | L'Airone
Petra | La Balena
Petra | Monte Bamboli
Poggioargentiera | Viognier
Poggioargentiera | Vermentino
Tua Rita | Perlato del Bosco
Corte Quaiara | Campo al Salice
Corte Quaiara | Monte delle Saette
Cantina Anselmi | San Vincenzo
Ronco Margherita | Friulano
Cantina Terlan | Quartz
Cantina Capellini | Cinque Terre
Dr. Loosen | Wehlener Sonnenuhr GG
Weingut Rinke | Riesling Wild auf Schiefer
Weingut Rinke | Sauvignon Blanc Fumé
Künstler | Riesling Trocken
Künstler | Hochheimer Stielweg Riesling Alte Reben
Künstler | Hochheim Hölle Riesling GG
Joh. Bapt. Schäfer | Dorsheim Riesling
Joh. Bapt. Schäfer | Kieselstein Rümmelsheim Riesling
Joh. Bapt. Schäfer | Pittermännchen Riesling GG
Gut Hermannsberg | 7 Terroirs Riesling
Gut Hermannsberg | Rotenberg Altenbamberg Riesling GG
Weingut Rappenhof | Hieronymus und Alexander Riesling
A. Christmann | Riesling
Karsten Peter | Riesling 1C
A. Christmann | Meerspinne Gimmeldingen GG
Salwey | Grauburgunder Oberrotweil Reserve
Salwey | Oberrotweiler Henkenberg Grauburgunder GG
Juliusspital | Würzburger Silvaner
Agricola Punica | Montessu
Sella & Mosca | Mustazzo
Sella & Mosca | Marchese di Villamarina
Cantine De Gregorio | Dragonara
Tenuta Valle delle Ferle | Cerasuolo di Vittoria
Tenuta Valle delle Ferle | Frappato
Cantine Valenti | Norma
Tenuta Regaleali | Rosso del Conte
Tenuta Tascante | Contrada Sciaranuova
Petra | Monte Bamboli Cabernet Franc
Petra | Quercegobbe
Petra | Potenti
Petra | Petra
Guado al Melo | Atis
Guado al Melo | Rute
Guado al Melo | Antillo
Guado al Melo | Jassarte
Tua Rita | Giusto di Notri
Fattoria Le Pupille | Saffredi
Tenuta Luce | Luce della Vite
Tua Rita | Re di Gaffi
Ornellaia | Le Serre Nuove dell'Ornellaia
Masi Agricola | Brolo Campofiorin Oro
Ceretto | Bernardina
Gaja | Barolo Sperss
J. Hofstätter | Meczan Pinot Nero
J. Hofstätter | Barthenau Vigna San Urbano
Burggarten | Walporzheim Spätburgunder
Burggarten | Walporzheimer Kräuterberg Spätburgunder GG
Burggarten | Heimersheimer Burggarten R Spätburgunder GG
Meyer-Näkel | Spätburgunder
Meyer-Näkel | Frühburgunder
Meyer-Näkel | Blauschiefer Spätburgunder
Meyer-Näkel | Sonnenberg Spätburgunder GG
Meyer-Näkel | Pfarrwingert Spätburgunder GG
Mayschloss | Walporzheimer Kräuterberg Spätburgunder GG
Pflüger | Pinot Noir Buntsandstein
Knipser | Blauer Spätburgunder
Knipser | Kirschgarten Spätburgunder GG
Knipser | Cuvée X
Knipser | Im Großen Garten Spätburgunder GG
Oliver Zeter | Cuvée Z
Salwey | Henkenberg Spätburgunder GG
Château La Gamaye | Cuvée Distinction
Bodega Mustiguillo | Quincha Corral
Baron Philippe De Rothschild | Escudo Rojo Gran Reserva

Rules:
- Match to the closest entry in the list above for producer and wine name spelling.
- If no match exists, use your best judgment to split producer from wine name.
- vintage: 4-digit year as a string (e.g. "2021"), or null if not present in the title.
- Return ONLY a valid JSON array — no markdown, no explanation.

Format:
[{"index":1,"producer":"...","wine":"...","vintage":"2021"},...]

Titles to parse:
${titlesBlock}`;

  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    }),
    muteHttpExceptions: true,
  });

  const responseData = JSON.parse(res.getContentText());
  if (responseData.error) throw new Error("Claude API error: " + responseData.error.message);

  let raw = responseData.content[0].text.trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(raw).map(item => ({
    ...item,
    product: products[item.index - 1],
  }));
}

function writeImportToSheet_(items) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  // Write header row if sheet is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }

  items.forEach(item => {
    sheet.appendRow([
      item.producer,
      item.wine,
      item.vintage || "",
      item.product.quantity,
      "", "", "", "", "", "", // Region, Country, Grapes, Acidity, Flavour, Einkaufspreis, Agent
      "", // Agent
      item.product.price,
      "", // Menu price
      item.product.variantId,
    ]);
  });
}
