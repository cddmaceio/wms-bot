import fs from "node:fs";
import path from "node:path";
export function createLogger(data: string) {
  const directory = path.join(data, "logs");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "service.log");
  return (event: string, detail: unknown = {}) => {
    const line =
      JSON.stringify({ at: new Date().toISOString(), event, detail }) + "\n";
    if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) {
      for (let i = 4; i >= 1; i--) {
        const old = `${file}.${i}`;
        if (fs.existsSync(old)) fs.renameSync(old, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, line);
    process.stdout.write(line);
  };
}
