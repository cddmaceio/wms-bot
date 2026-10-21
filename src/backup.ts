import Database from "better-sqlite3";
import path from "node:path";
const destination = process.argv[2];
if (!destination)
  throw new Error("Uso: npm run backup -- CAMINHO_DESTINO.sqlite3");
const source = path.resolve(process.env.DATA_DIR || "./data", "wms.sqlite3");
if (path.resolve(destination) === source)
  throw new Error("Destino deve ser diferente do banco ativo");
const db = new Database(source, { readonly: true, fileMustExist: true });
db.backup(path.resolve(destination))
  .then(() => {
    db.close();
    console.log("Backup SQLite concluído");
  })
  .catch((error) => {
    db.close();
    console.error(error.message);
    process.exitCode = 1;
  });
