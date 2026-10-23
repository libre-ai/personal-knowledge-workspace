// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Reader of the machine-read parts of PROTOCOL.md and of the thresholds of
// docs/prd.md section 5. Both documents are Markdown tables: a row is a line
// that starts with "|", and a cell holds no "|".

export function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Rows whose first cell is a backticked key: `| \`key\` | value |`.
export function protocolFields(markdown: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const [first, second] = tableCells(line);
    const key = /^`([a-z0-9-]+)`$/.exec(first ?? "")?.[1];
    if (key === undefined || second === undefined) continue;
    if (fields.has(key)) throw new Error(`PROTOCOL.md: duplicate field ${key}`);
    fields.set(key, second);
  }
  return fields;
}

export interface Threshold {
  measure: string;
  threshold: string;
}

// The "Mesure | Seuil" table of PROTOCOL.md section 3.
export function protocolThresholds(markdown: string): Threshold[] {
  const rows: Threshold[] = [];
  let inTable = false;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const [first, second] = tableCells(line);
    if (first === "Mesure" && second === "Seuil") {
      inTable = true;
      continue;
    }
    if (!inTable || first === undefined || second === undefined || /^-+$/.test(first)) continue;
    rows.push({ measure: first, threshold: second });
  }
  return rows;
}

// The rows of docs/prd.md section 5 whose instrument is the measurement series
// of the protocol (criteria CA-43 and CA-44). The threshold cell is cut at its
// first " (": what follows is a source reference, not part of the threshold.
export function prdSeriesThresholds(prd: string): Threshold[] {
  const lines = prd.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## 5."));
  if (start === -1) throw new Error("prd.md: section 5 not found");
  const rows: Threshold[] = [];
  let columns: { measure: number; threshold: number; instrument: number } | null = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = tableCells(line);
    if (columns === null) {
      const measure = cells.indexOf("Métrique");
      const threshold = cells.indexOf("Seuil");
      const instrument = cells.indexOf("Instrument");
      if (measure !== -1 && threshold !== -1 && instrument !== -1) {
        columns = { measure, threshold, instrument };
      }
      continue;
    }
    const instrument = cells[columns.instrument];
    const measure = cells[columns.measure];
    const threshold = cells[columns.threshold];
    if (instrument === undefined || measure === undefined || threshold === undefined) continue;
    if (!instrument.includes("série du protocole")) continue;
    rows.push({ measure, threshold: threshold.split(" (")[0] ?? threshold });
  }
  return rows;
}
