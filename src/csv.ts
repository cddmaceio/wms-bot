import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { AppError } from "./types";
const aliases: Record<string, string> = {
  codigo_do_armazem: "codigo_armazem",
  sequencia: "sequencia",
  codigo_do_item: "codigo_item",
  data_de_entrega: "data_entrega",
};
const keys = ["codigo_armazem", "mapas", "palete", "codigo_item"];
export function header(value: string) {
  const key = value
    .replace(/^\uFEFF/, "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
  return Object.hasOwn(aliases, key) ? aliases[key] : key;
}
export function parseCsv(raw: string) {
  let table: string[][] | undefined;
  for (const delimiter of [";", ",", "\t"]) {
    try {
      const rows = parse(raw, {
        delimiter,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      }) as string[][];
      if (
        rows.length &&
        keys.every((key) => rows[0].map(header).includes(key))
      ) {
        table = rows;
        break;
      }
    } catch {
      /* Tenta o próximo delimitador; nenhuma linha é aceita parcialmente. */
    }
  }
  if (!table)
    throw new AppError(
      "CSV inválido ou sem colunas obrigatórias: " + keys.join(", "),
    );
  const headers = table[0].map(header);
  if (new Set(headers).size !== headers.length || headers.some((h) => !h))
    throw new AppError("Cabeçalhos vazios ou duplicados no CSV");
  const unique = new Map<string, Record<string, string>>();
  for (let i = 1; i < table.length; i++) {
    const record = Object.fromEntries(
      headers.map((key, index) => [key, table![i][index].trim()]),
    );
    if (keys.some((key) => !record[key]))
      throw new AppError(`CSV: chave incompleta no registro ${i}`);
    unique.set(JSON.stringify(keys.map((key) => record[key])), record);
  }
  return {
    records: [...unique.values()],
    rawCount: table.length - 1,
    duplicates: table.length - 1 - unique.size,
  };
}
export function readCsv(file: string) {
  return parseCsv(readFileSync(file, "utf8"));
}
