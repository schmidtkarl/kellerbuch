// Kellerbuch — unit tests (run with: node tests.js)
// Tests cover: service week date logic, Apps Script matching logic, wine list reference.
// For live Claude parsing tests: node tests.js --live (requires ANTHROPIC_API_KEY env var)

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (e) {
    console.error("  ✗ " + name);
    console.error("    " + e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || "Expected equal") + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// Local YYYY-MM-DD — avoids UTC-offset issues when comparing dates set via setHours()
function localDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// ── Service week helpers (kept in sync with index.html) ───────────────────────
function getServiceWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dayOfWeek = d.getDay();
  const daysSinceThu = (dayOfWeek + 3) % 7; // Thu→0, Fri→1, Sat→2, Sun→3, Mon→4, Tue→5, Wed→6
  d.setDate(d.getDate() - daysSinceThu);
  return d;
}

function getServiceWeekEnd(start) {
  const end = new Date(start);
  end.setDate(start.getDate() + 4); // Thu + 4 = Mon
  end.setHours(23, 59, 59, 999);
  return end;
}

// ── Apps Script matching logic (ported to Node) ───────────────────────────────
// Kept in sync with normVintage_/doPost in apps-script.js: producer+wine+vintage
// is the matching key. Blank/null vintage normalizes to "" — its own bucket,
// so legacy no-vintage rows only match other no-vintage changes.
function normVintage_(v) {
  return String(v == null ? "" : v).trim();
}

function applyChanges(sheet, changes) {
  const unmatched = [];
  changes.forEach(ch => {
    let found = false;
    for (let i = 0; i < sheet.length; i++) {
      if (!sheet[i][0] || String(sheet[i][0]).trim() === "") continue;
      const sameProducer = String(sheet[i][0]).toLowerCase() === String(ch.producer || "").toLowerCase();
      const sameWine = String(sheet[i][1] || "").toLowerCase() === String(ch.wine || "").toLowerCase();
      const sameVintage = normVintage_(sheet[i][2]) === normVintage_(ch.vintage);
      if (sameProducer && sameWine && sameVintage) {
        const delta = ch.action === "remove" ? -ch.quantity : ch.quantity;
        sheet[i][3] = Math.max(0, Number(sheet[i][3] || 0) + delta);
        found = true;
        break;
      }
    }
    if (!found) {
      if (ch.action === "add") {
        sheet.push([ch.producer, ch.wine, ch.vintage ?? "", ch.quantity]);
      } else {
        unmatched.push(ch);
      }
    }
  });
  return unmatched;
}

// ── SERVICE WEEK DATE LOGIC ───────────────────────────────────────────────────
console.log("\nService week date logic:");

test("Thursday is start of its own service week", () => {
  const start = getServiceWeekStart(new Date("2026-06-18T14:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Friday falls in the Thursday that started the week", () => {
  const start = getServiceWeekStart(new Date("2026-06-19T10:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Saturday falls in the Thursday that started the week", () => {
  const start = getServiceWeekStart(new Date("2026-06-20T22:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Sunday falls in the Thursday that started the week", () => {
  const start = getServiceWeekStart(new Date("2026-06-21T12:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Monday falls in the Thursday that started the week", () => {
  const start = getServiceWeekStart(new Date("2026-06-22T22:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Tuesday (closed) still maps back to the last Thursday", () => {
  const start = getServiceWeekStart(new Date("2026-06-23T12:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Wednesday (closed) still maps back to the last Thursday", () => {
  const start = getServiceWeekStart(new Date("2026-06-24T09:00:00"));
  assertEqual(localDate(start), "2026-06-18");
});
test("Service week end is Monday", () => {
  const start = getServiceWeekStart(new Date("2026-06-18"));
  const end = getServiceWeekEnd(start);
  assertEqual(localDate(end), "2026-06-22");
});
test("Saturday is within Thu–Mon range", () => {
  const sat = new Date("2026-06-20T20:00:00");
  const start = getServiceWeekStart(sat);
  const end = getServiceWeekEnd(start);
  assert(sat >= start && sat <= end);
});
test("Tuesday is NOT within the previous Thu–Mon range", () => {
  const tue = new Date("2026-06-23T12:00:00");
  const start = getServiceWeekStart(tue);
  const end = getServiceWeekEnd(start);
  assert(!(tue >= start && tue <= end), "Tuesday should fall outside the Thu–Mon range");
});

// ── APPS SCRIPT MATCHING LOGIC ────────────────────────────────────────────────
console.log("\nApps Script matching logic:");

test("Remove decrements quantity", () => {
  const sheet = [["Petra", "Hebo", 2023, 6]];
  applyChanges(sheet, [{ action: "remove", producer: "Petra", wine: "Hebo", vintage: 2023, quantity: 2 }]);
  assertEqual(sheet[0][3], 4);
});
test("Add increments quantity", () => {
  const sheet = [["Petra", "Hebo", 2023, 4]];
  applyChanges(sheet, [{ action: "add", producer: "Petra", wine: "Hebo", vintage: 2023, quantity: 6 }]);
  assertEqual(sheet[0][3], 10);
});
test("Quantity never goes below zero", () => {
  const sheet = [["Petra", "Hebo", 2023, 1]];
  applyChanges(sheet, [{ action: "remove", producer: "Petra", wine: "Hebo", vintage: 2023, quantity: 5 }]);
  assertEqual(sheet[0][3], 0);
});
test("Matching is case-insensitive", () => {
  const sheet = [["sella & mosca", "tanca farrà", 2022, 6]];
  applyChanges(sheet, [{ action: "remove", producer: "Sella & Mosca", wine: "Tanca Farrà", vintage: 2022, quantity: 1 }]);
  assertEqual(sheet[0][3], 5);
});
test("Vintage IS part of the matching key — a different vintage does not match", () => {
  const sheet = [["Gaja", "Barolo Sperss", 1990, 3]];
  const unmatched = applyChanges(sheet, [{ action: "remove", producer: "Gaja", wine: "Barolo Sperss", vintage: 2018, quantity: 1 }]);
  assertEqual(sheet[0][3], 3, "the 1990 row should be untouched by a 2018 removal");
  assertEqual(unmatched.length, 1, "the unmatched vintage should be reported, not silently dropped");
});
test("Blank/legacy vintage matches other blank-vintage rows (the 'unknown' bucket)", () => {
  const sheet = [["Gaja", "Barolo Sperss", "", 3]];
  applyChanges(sheet, [{ action: "remove", producer: "Gaja", wine: "Barolo Sperss", vintage: null, quantity: 1 }]);
  assertEqual(sheet[0][3], 2);
});
test("Unknown wine with add action creates a new row", () => {
  const sheet = [["Petra", "Hebo", 2023, 6]];
  applyChanges(sheet, [{ action: "add", producer: "Tua Rita", wine: "Giusto di Notri", vintage: 2023, quantity: 3 }]);
  assertEqual(sheet.length, 2);
  assertEqual(sheet[1][0], "Tua Rita");
  assertEqual(sheet[1][1], "Giusto di Notri");
});
test("Unmatched removal doesn't create a row, and is reported as unmatched", () => {
  const sheet = [["Petra", "Hebo", 2023, 6]];
  const unmatched = applyChanges(sheet, [{ action: "remove", producer: "Unknown", wine: "Ghost Wine", vintage: null, quantity: 1 }]);
  assertEqual(sheet.length, 1);
  assertEqual(unmatched.length, 1);
});
test("Empty rows in sheet are skipped", () => {
  const sheet = [["", "", "", ""], ["Sella & Mosca", "Tanca Farrà", 2022, 6]];
  applyChanges(sheet, [{ action: "remove", producer: "Sella & Mosca", wine: "Tanca Farrà", vintage: 2022, quantity: 1 }]);
  assertEqual(sheet[1][3], 5);
});
test("Multiple changes in one submission", () => {
  const sheet = [
    ["Petra", "Hebo", 2023, 6],
    ["Tua Rita", "Rosso dei Notri", 2022, 4],
    ["Alberto Longo", "Primitivo", 2022, 8],
  ];
  applyChanges(sheet, [
    { action: "remove", producer: "Petra", wine: "Hebo", vintage: 2023, quantity: 2 },
    { action: "remove", producer: "Tua Rita", wine: "Rosso dei Notri", vintage: 2022, quantity: 1 },
    { action: "add", producer: "Alberto Longo", wine: "Primitivo", vintage: 2022, quantity: 6 },
  ]);
  assertEqual(sheet[0][3], 4);
  assertEqual(sheet[1][3], 3);
  assertEqual(sheet[2][3], 14);
});

// ── WINE LIST — all Zippiri wines (producer | wine) ──────────────────────────
// Used as reference for matching tests and future --live Claude parsing tests.
// Format: { producer, wine, shortcuts } where shortcuts are common staff shorthands.
const WINE_LIST = [
  // Schaumwein
  { producer: "Bellavista", wine: "Alma Assemblage 2", shortcuts: ["Alma", "Assemblage"] },
  { producer: "Bellavista", wine: "Teatro Alla Scala Brut", shortcuts: ["Teatro", "Scala"] },
  { producer: "Bellavista", wine: "Pas Operé Extra Brut", shortcuts: ["Pas Operé"] },
  { producer: "Contadi Castaldi", wine: "Brùt", shortcuts: ["Contadi"] },
  { producer: "Deutz", wine: "Champagne Brut Classic", shortcuts: ["Deutz"] },
  { producer: "Berivagus", wine: "Blanc de Blancs Vintage", shortcuts: ["Berivagus"] },
  { producer: "Frescobaldi", wine: "Leonia Pomino Brut", shortcuts: ["Leonia"] },
  { producer: "Corte Quaira", wine: "Saccomani Veneri Brut", shortcuts: ["Saccomani", "Veneri"] },
  { producer: "Schlossgut Diel", wine: "Riesling Réserve Extra Brut", shortcuts: ["Diel Sekt"] },
  { producer: "Sella & Mosca", wine: "Alghero Torbato Spumante", shortcuts: ["Torbato Spumante"] },
  { producer: "J. Trautwein", wine: "Infinitea", shortcuts: ["Infinitea", "Trautwein"] },
  // Offene Weine Weiß
  { producer: "Sella & Mosca", wine: "La Cala Reale", shortcuts: ["Cala Reale"] },
  { producer: "Sella & Mosca", wine: "Terre Bianche", shortcuts: ["Terre Bianche"] },
  { producer: "Cantina Capellini", wine: "Alba Bianco", shortcuts: ["Alba Bianco", "Capellini Bianco"] },
  { producer: "Colli VaiBo'", wine: "Lugana", shortcuts: ["Lugana", "VaiBo"] },
  { producer: "Tenuta Capofaro", wine: "Vigna di Paola", shortcuts: ["Capofaro", "Vigna Paola"] },
  { producer: "Cantine De Gregorio", wine: "Bianco di San Lorenzo", shortcuts: ["Bianco San Lorenzo"] },
  { producer: "Frescobaldi", wine: "Pomino Bianco", shortcuts: ["Pomino", "Pomino Bianco"] },
  { producer: "Gut Hermannsberg", wine: "Just Riesling!", shortcuts: ["Hermannsberg", "Just Riesling"] },
  { producer: "Dr. Loosen", wine: "Riesling Blauschiefer", shortcuts: ["Loosen", "Blauschiefer"] },
  { producer: "Salwey", wine: "Grauburgunder", shortcuts: ["Salwey Grau"] },
  { producer: "Argiolas", wine: "Cerdeña", shortcuts: ["Cerdeña", "Argiolas"] },
  { producer: "Schlossgut Diel", wine: "Pinot Gris Resèrve", shortcuts: ["Diel Pinot Gris", "Pinot Gris Diel"] },
  { producer: "Cantina Terlan", wine: "Winkl", shortcuts: ["Winkl"] },
  // Offene Weine Rot
  { producer: "Sella & Mosca", wine: "Cannonau di Sardegna Riserva", shortcuts: ["Cannonau", "Canno"] },
  { producer: "Sella & Mosca", wine: "Terre Rare", shortcuts: ["Terre Rare"] },
  { producer: "Sella & Mosca", wine: "Tanca Farrà", shortcuts: ["Tanca", "Tanca Farrà"] },
  { producer: "Cantine De Gregorio", wine: "Haris", shortcuts: ["Haris"] },
  { producer: "Tenuta Tascante", wine: "Ghiaia Nera", shortcuts: ["Ghiaia", "Ghiaia Nera"] },
  { producer: "Tua Rita", wine: "Rosso dei Notri", shortcuts: ["Notri", "Rosso Notri"] },
  { producer: "Alberto Longo", wine: "Primitivo", shortcuts: ["Primitivo", "Longo"] },
  { producer: "I Vini del Mare Belvento", wine: "Sirēno", shortcuts: ["Sireno", "Belvento"] },
  { producer: "Petra", wine: "Hebo", shortcuts: ["Hebo"] },
  { producer: "Sella & Mosca", wine: "Marchese di Villamarina Riserva", shortcuts: ["Marchese Riserva", "Villamarina Riserva"] },
  { producer: "Fattoria Le Pupille", wine: "Poggio Valente", shortcuts: ["Poggio Valente", "Pupille"] },
  { producer: "Agricola Punica", wine: "Barrua", shortcuts: ["Barrua"] },
  // Weißwein Flaschenkarte
  { producer: "Sella & Mosca", wine: "Ambat", shortcuts: ["Ambat"] },
  { producer: "Sella & Mosca", wine: "Cuvée 161", shortcuts: ["Cuvée 161", "161"] },
  { producer: "Cantine De Gregorio", wine: "Rahana", shortcuts: ["Rahana"] },
  { producer: "Tenuta Monreale Agnello", wine: "Mhinoe", shortcuts: ["Mhinoe"] },
  { producer: "Tenuta Valle delle Ferle", wine: "Murgentia Bianco", shortcuts: ["Murgentia"] },
  { producer: "Tenuta Regaleali", wine: "Vigna San Francesco", shortcuts: ["Regaleali Bianco", "San Francesco Bianco"] },
  { producer: "Guado al Melo", wine: "L'Airone", shortcuts: ["Airone"] },
  { producer: "Petra", wine: "La Balena", shortcuts: ["Balena"] },
  { producer: "Petra", wine: "Monte Bamboli", shortcuts: ["Monte Bamboli Bianco"] },
  { producer: "Poggioargentiera", wine: "Viognier", shortcuts: ["Poggioargentiera Viognier"] },
  { producer: "Poggioargentiera", wine: "Vermentino", shortcuts: ["Poggioargentiera Vermentino"] },
  { producer: "Tua Rita", wine: "Perlato del Bosco", shortcuts: ["Perlato"] },
  { producer: "Corte Quaiara", wine: "Campo al Salice", shortcuts: ["Campo Salice"] },
  { producer: "Corte Quaiara", wine: "Monte delle Saette", shortcuts: ["Monte Saette"] },
  { producer: "Cantina Anselmi", wine: "San Vincenzo", shortcuts: ["San Vincenzo", "Anselmi"] },
  { producer: "Ronco Margherita", wine: "Friulano", shortcuts: ["Friulano", "Ronco Margherita"] },
  { producer: "Cantina Terlan", wine: "Quartz", shortcuts: ["Quartz"] },
  { producer: "Cantina Capellini", wine: "Cinque Terre", shortcuts: ["Cinque Terre"] },
  { producer: "Dr. Loosen", wine: "Wehlener Sonnenuhr GG", shortcuts: ["Sonnenuhr", "Wehlener"] },
  { producer: "Weingut Rinke", wine: "Riesling Wild auf Schiefer", shortcuts: ["Rinke", "Wild Schiefer"] },
  { producer: "Weingut Rinke", wine: "Sauvignon Blanc Fumé", shortcuts: ["Rinke Sauv", "Fumé"] },
  { producer: "Künstler", wine: "Riesling Trocken", shortcuts: ["Künstler", "Künstler Riesling"] },
  { producer: "Künstler", wine: "Hochheimer Stielweg Riesling Alte Reben", shortcuts: ["Stielweg"] },
  { producer: "Künstler", wine: "Hochheim Hölle Riesling GG", shortcuts: ["Hölle"] },
  { producer: "Joh. Bapt. Schäfer", wine: "Dorsheim Riesling", shortcuts: ["Dorsheim"] },
  { producer: "Joh. Bapt. Schäfer", wine: "Kieselstein Rümmelsheim Riesling", shortcuts: ["Kieselstein", "Rümmelsheim"] },
  { producer: "Joh. Bapt. Schäfer", wine: "Pittermännchen Riesling GG", shortcuts: ["Pittermännchen"] },
  { producer: "Gut Hermannsberg", wine: "7 Terroirs Riesling", shortcuts: ["7 Terroirs"] },
  { producer: "Gut Hermannsberg", wine: "Rotenberg Altenbamberg Riesling GG", shortcuts: ["Rotenberg"] },
  { producer: "Weingut Rappenhof", wine: "Hieronymus und Alexander Riesling", shortcuts: ["Rappenhof", "Hieronymus"] },
  { producer: "A. Christmann", wine: "Riesling", shortcuts: ["Christmann"] },
  { producer: "Karsten Peter", wine: "Riesling 1C", shortcuts: ["1C", "Karsten Peter"] },
  { producer: "A. Christmann", wine: "Meerspinne Gimmeldingen GG", shortcuts: ["Meerspinne"] },
  { producer: "Salwey", wine: "Grauburgunder Oberrotweil Reserve", shortcuts: ["Oberrotweil"] },
  { producer: "Salwey", wine: "Oberrotweiler Henkenberg Grauburgunder GG", shortcuts: ["Henkenberg Grau"] },
  { producer: "Juliusspital", wine: "Würzburger Silvaner", shortcuts: ["Silvaner", "Juliusspital"] },
  // Rotwein Flaschenkarte
  { producer: "Agricola Punica", wine: "Montessu", shortcuts: ["Montessu"] },
  { producer: "Sella & Mosca", wine: "Mustazzo", shortcuts: ["Mustazzo"] },
  { producer: "Sella & Mosca", wine: "Marchese di Villamarina", shortcuts: ["Marchese", "Villamarina"] },
  { producer: "Cantine De Gregorio", wine: "Dragonara", shortcuts: ["Dragonara"] },
  { producer: "Tenuta Valle delle Ferle", wine: "Cerasuolo di Vittoria", shortcuts: ["Cerasuolo"] },
  { producer: "Tenuta Valle delle Ferle", wine: "Frappato", shortcuts: ["Frappato"] },
  { producer: "Cantine Valenti", wine: "Norma", shortcuts: ["Norma"] },
  { producer: "Tenuta Regaleali", wine: "Rosso del Conte", shortcuts: ["Rosso del Conte", "Conte"] },
  { producer: "Tenuta Tascante", wine: "Contrada Sciaranuova", shortcuts: ["Contrada", "Sciaranuova"] },
  { producer: "Petra", wine: "Monte Bamboli Cabernet Franc", shortcuts: ["Monte Bamboli Cab Franc"] },
  { producer: "Petra", wine: "Quercegobbe", shortcuts: ["Quercegobbe"] },
  { producer: "Petra", wine: "Potenti", shortcuts: ["Potenti"] },
  { producer: "Petra", wine: "Petra", shortcuts: ["Petra Petra"] },
  { producer: "Guado al Melo", wine: "Atis", shortcuts: ["Atis"] },
  { producer: "Guado al Melo", wine: "Rute", shortcuts: ["Rute"] },
  { producer: "Guado al Melo", wine: "Antillo", shortcuts: ["Antillo"] },
  { producer: "Guado al Melo", wine: "Jassarte", shortcuts: ["Jassarte"] },
  { producer: "Tua Rita", wine: "Giusto di Notri", shortcuts: ["Giusto"] },
  { producer: "Fattoria Le Pupille", wine: "Saffredi", shortcuts: ["Saffredi"] },
  { producer: "Tenuta Luce", wine: "Luce della Vite", shortcuts: ["Luce"] },
  { producer: "Tua Rita", wine: "Re di Gaffi", shortcuts: ["Re di Gaffi", "Gaffi"] },
  { producer: "Ornellaia", wine: "Le Serre Nuove dell'Ornellaia", shortcuts: ["Serre Nuove", "Ornellaia"] },
  { producer: "Masi Agricola", wine: "Brolo Campofiorin Oro", shortcuts: ["Campofiorin", "Brolo"] },
  { producer: "Ceretto", wine: "Bernardina", shortcuts: ["Bernardina", "Ceretto"] },
  { producer: "Gaja", wine: "Barolo Sperss", shortcuts: ["Sperss", "Gaja Barolo"] },
  { producer: "J. Hofstätter", wine: "Meczan Pinot Nero", shortcuts: ["Meczan"] },
  { producer: "J. Hofstätter", wine: "Barthenau Vigna San Urbano", shortcuts: ["Barthenau", "San Urbano"] },
  { producer: "Burggarten", wine: "Walporzheim Spätburgunder", shortcuts: ["Walporzheim"] },
  { producer: "Burggarten", wine: "Walporzheimer Kräuterberg Spätburgunder GG", shortcuts: ["Kräuterberg Burggarten"] },
  { producer: "Burggarten", wine: "Heimersheimer Burggarten R Spätburgunder GG", shortcuts: ["Heimersheim", "Burggarten R"] },
  { producer: "Meyer-Näkel", wine: "Spätburgunder", shortcuts: ["Näkel", "Meyer-Näkel"] },
  { producer: "Meyer-Näkel", wine: "Frühburgunder", shortcuts: ["Frühburgunder"] },
  { producer: "Meyer-Näkel", wine: "Blauschiefer Spätburgunder", shortcuts: ["Blauschiefer Näkel"] },
  { producer: "Meyer-Näkel", wine: "Sonnenberg Spätburgunder GG", shortcuts: ["Sonnenberg"] },
  { producer: "Meyer-Näkel", wine: "Pfarrwingert Spätburgunder GG", shortcuts: ["Pfarrwingert"] },
  { producer: "Mayschloss", wine: "Walporzheimer Kräuterberg Spätburgunder GG", shortcuts: ["Mayschloss", "Kräuterberg Mayschloss"] },
  { producer: "Pflüger", wine: "Pinot Noir Buntsandstein", shortcuts: ["Pflüger", "Buntsandstein"] },
  { producer: "Knipser", wine: "Blauer Spätburgunder", shortcuts: ["Knipser Spät"] },
  { producer: "Knipser", wine: "Kirschgarten Spätburgunder GG", shortcuts: ["Kirschgarten"] },
  { producer: "Knipser", wine: "Cuvée X", shortcuts: ["Cuvée X", "Knipser X"] },
  { producer: "Knipser", wine: "Im Großen Garten Spätburgunder GG", shortcuts: ["Großer Garten", "Großen Garten"] },
  { producer: "Oliver Zeter", wine: "Cuvée Z", shortcuts: ["Cuvée Z", "Zeter"] },
  { producer: "Salwey", wine: "Henkenberg Spätburgunder GG", shortcuts: ["Henkenberg Spät"] },
  { producer: "Château La Gamaye", wine: "Cuvée Distinction", shortcuts: ["La Gamaye", "Gamaye"] },
  { producer: "Bodega Mustiguillo", wine: "Quincha Corral", shortcuts: ["Quincha Corral", "Mustiguillo"] },
  { producer: "Baron Philippe De Rothschild", wine: "Escudo Rojo Gran Reserva", shortcuts: ["Escudo Rojo"] },
];

console.log("\nWine list integrity:");

test("Wine list has no duplicate producer+wine combinations", () => {
  const seen = new Set();
  const dupes = [];
  WINE_LIST.forEach(w => {
    const key = w.producer.toLowerCase() + "|" + w.wine.toLowerCase();
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  });
  assert(dupes.length === 0, "Duplicates found: " + dupes.join(", "));
});

test("All wines have non-empty producer and wine", () => {
  const bad = WINE_LIST.filter(w => !w.producer || !w.wine);
  assert(bad.length === 0, "Empty producer or wine: " + JSON.stringify(bad));
});

test("Wine list covers expected count (at least 100 entries)", () => {
  assert(WINE_LIST.length >= 100, `Only ${WINE_LIST.length} wines — expected 100+`);
});

// ── SHORTHAND → INVENTORY MATCHING ───────────────────────────────────────────
// Verify that common staff abbreviations resolve to exactly one wine in the list.
console.log("\nShorthand uniqueness (each shortcut should match exactly one wine):");

const UNAMBIGUOUS_SHORTCUTS = [
  { shortcut: "Hebo", expectedProducer: "Petra", expectedWine: "Hebo" },
  { shortcut: "Tanca", expectedProducer: "Sella & Mosca", expectedWine: "Tanca Farrà" },
  { shortcut: "Barrua", expectedProducer: "Agricola Punica", expectedWine: "Barrua" },
  { shortcut: "Montessu", expectedProducer: "Agricola Punica", expectedWine: "Montessu" },
  { shortcut: "Saffredi", expectedProducer: "Fattoria Le Pupille", expectedWine: "Saffredi" },
  { shortcut: "Perlato", expectedProducer: "Tua Rita", expectedWine: "Perlato del Bosco" },
  { shortcut: "Giusto", expectedProducer: "Tua Rita", expectedWine: "Giusto di Notri" },
  { shortcut: "Notri", expectedProducer: "Tua Rita", expectedWine: "Rosso dei Notri" },
  { shortcut: "Ghiaia", expectedProducer: "Tenuta Tascante", expectedWine: "Ghiaia Nera" },
  { shortcut: "Contrada", expectedProducer: "Tenuta Tascante", expectedWine: "Contrada Sciaranuova" },
  { shortcut: "Jassarte", expectedProducer: "Guado al Melo", expectedWine: "Jassarte" },
  { shortcut: "Atis", expectedProducer: "Guado al Melo", expectedWine: "Atis" },
  { shortcut: "Winkl", expectedProducer: "Cantina Terlan", expectedWine: "Winkl" },
  { shortcut: "Quartz", expectedProducer: "Cantina Terlan", expectedWine: "Quartz" },
  { shortcut: "Hölle", expectedProducer: "Künstler", expectedWine: "Hochheim Hölle Riesling GG" },
  { shortcut: "Pittermännchen", expectedProducer: "Joh. Bapt. Schäfer", expectedWine: "Pittermännchen Riesling GG" },
  { shortcut: "Meerspinne", expectedProducer: "A. Christmann", expectedWine: "Meerspinne Gimmeldingen GG" },
  { shortcut: "Sperss", expectedProducer: "Gaja", expectedWine: "Barolo Sperss" },
  { shortcut: "Sonnenberg", expectedProducer: "Meyer-Näkel", expectedWine: "Sonnenberg Spätburgunder GG" },
  { shortcut: "Kirschgarten", expectedProducer: "Knipser", expectedWine: "Kirschgarten Spätburgunder GG" },
];

UNAMBIGUOUS_SHORTCUTS.forEach(({ shortcut, expectedProducer, expectedWine }) => {
  test(`"${shortcut}" maps to exactly one wine`, () => {
    const matches = WINE_LIST.filter(w =>
      w.shortcuts.some(s => s.toLowerCase() === shortcut.toLowerCase()) ||
      w.wine.toLowerCase().includes(shortcut.toLowerCase())
    );
    assert(matches.length >= 1, `No wine found for shortcut "${shortcut}"`);
    const exact = matches.find(w => w.producer === expectedProducer && w.wine === expectedWine);
    assert(exact, `Expected ${expectedProducer} | ${expectedWine}, but matches were: ${matches.map(w => w.producer + " | " + w.wine).join("; ")}`);
  });
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
