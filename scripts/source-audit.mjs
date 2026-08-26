import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const ignoredDirectories = new Set(["node_modules", "dist", ".git"]);
const auditedExtensions = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".app", ".txt"]);
const forbiddenEnvironmentAccess = "process" + "." + "env";
const forbiddenLoaderName = "dot" + "env";
const forbiddenConfigNames = ["." + "env", "." + "env.example"];
const forbiddenMarkers = [
  { label: "TODO", pattern: /\bTODO\b/u },
  { label: "FIXME", pattern: /\bFIXME\b/u },
  { label: "implementação futura", pattern: /\bimplementação futura\b/iu },
  { label: "em desenvolvimento", pattern: /\bem desenvolvimento\b/iu },
  { label: "função de exemplo", pattern: /\bfunção de exemplo\b/iu },
  { label: "código provisório", pattern: /\bcódigo provisório\b/iu },
  { label: "simulação de sucesso", pattern: /\bsimulação de sucesso\b/iu }
];
const failures = [];

function extension(path) {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

for (const forbiddenName of forbiddenConfigNames) {
  if (existsSync(join(root, forbiddenName))) failures.push(`Arquivo proibido presente: ${forbiddenName}`);
}

const packageDocument = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (packageDocument[section]?.[forbiddenLoaderName]) failures.push(`Dependência proibida presente em ${section}.`);
}

const files = walk(root).filter((path) => auditedExtensions.has(extension(path)));
for (const path of files) {
  const short = relative(root, path).replaceAll("\\", "/");
  if (short === "scripts/source-audit.mjs") continue;
  const content = readFileSync(path, "utf8");
  if (content.includes(forbiddenEnvironmentAccess)) failures.push(`${short}: acesso direto a variáveis do processo.`);
  if (content.toLowerCase().includes(forbiddenLoaderName)) failures.push(`${short}: carregador de configuração antigo citado.`);
  for (const marker of forbiddenMarkers) {
    if (marker.pattern.test(content)) failures.push(`${short}: marcador incompleto encontrado (${marker.label}).`);
  }
}

const sourceFiles = files.filter((path) => relative(root, path).replaceAll("\\", "/").startsWith("src/"));
const source = sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
const interactionListeners = (source.match(/Events\.InteractionCreate/g) ?? []).length;
const messageListeners = (source.match(/Events\.MessageCreate/g) ?? []).length;
if (interactionListeners !== 1) failures.push(`Listeners InteractionCreate encontrados: ${interactionListeners}; esperado: 1.`);
if (messageListeners !== 1) failures.push(`Listeners MessageCreate encontrados: ${messageListeners}; esperado: 1.`);
if (!source.includes('resolve(projectRoot, "Token.json")')) failures.push("O carregamento exclusivo do token não foi localizado.");
if (!readFileSync(join(root, ".gitignore"), "utf8").includes("Token.json")) failures.push("Token.json não está protegido pelo ignore do Git.");
if (!readFileSync(join(root, ".gitignore"), "utf8").includes("config/private-credentials.json")) failures.push("O arquivo privado de credenciais não está protegido pelo ignore do Git.");

if (failures.length) {
  console.error("AUDITORIA_FALHOU");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`AUDITORIA_OK arquivos=${files.length} interactionCreate=1 messageCreate=1 token=Token.json`);
}
