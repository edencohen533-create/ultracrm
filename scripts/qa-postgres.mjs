// Optional disposable local PostgreSQL runtime. No production connection is read.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = path.resolve(process.env.QA_PG_RUNTIME ?? ".qa-local/postgres");
const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(runtime, "node_modules/embedded-postgres/dist/index.js")).href);
const directory = path.join(runtime, "data");
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "qa", password: "local-qa-only", port: 55439, persistent: true, initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1", "-c", "max_connections=100"] });
if (!fs.existsSync(path.join(directory, "PG_VERSION"))) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='dialer_qa'")).rowCount) await pg.createDatabase("dialer_qa");
await client.end();
console.log("Local QA PostgreSQL ready: 127.0.0.1:55439/dialer_qa");
const keepAlive = setInterval(() => {}, 10000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { clearInterval(keepAlive); await pg.stop(); process.exit(0); });
