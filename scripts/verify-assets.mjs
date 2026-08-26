import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = resolve("assets/emojis");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const packInfo = JSON.parse(await readFile(resolve(root, "pack-info.json"), "utf8"));

if (!Array.isArray(manifest)) throw new Error("Manifesto de emojis inválido.");
if (manifest.length !== 197) throw new Error(`Esperados 197 emojis, encontrados ${manifest.length}.`);
if (packInfo.count !== manifest.length) throw new Error("Quantidade do pack-info diverge do manifesto.");

async function collectPngFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectPngFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) output.push(relative(root, full).replaceAll("\\", "/"));
  }
  return output;
}

const names = new Set();
const semantics = new Set();
const files = new Set();

for (const item of manifest) {
  if (!item || typeof item !== "object") throw new Error("Entrada inválida no manifesto.");
  if (!/^[a-zA-Z0-9_]{2,32}$/.test(item.name)) throw new Error(`Nome incompatível com Discord: ${item.name}`);
  if (!/^[a-z0-9_]{1,40}$/.test(item.semantic)) throw new Error(`Identificador inválido: ${item.semantic}`);
  if (item.theme !== "solid") throw new Error(`Tema inesperado em ${item.name}: ${item.theme}`);
  if (String(item.file).includes("..") || String(item.file).startsWith("/")) throw new Error(`Caminho inseguro: ${item.file}`);
  if (names.has(item.name)) throw new Error(`Nome duplicado: ${item.name}`);
  if (semantics.has(item.semantic)) throw new Error(`Identificador duplicado: ${item.semantic}`);
  if (files.has(item.file)) throw new Error(`Arquivo duplicado: ${item.file}`);
  names.add(item.name);
  semantics.add(item.semantic);
  files.add(item.file);

  const path = resolve(root, item.file);
  const info = await stat(path);
  if (info.size > 256 * 1024) throw new Error(`${item.file} excede 256 KiB.`);
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw new Error(`${item.file} não é PNG válido.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const expectedSize = String(item.file).startsWith("entrega-automatica/") ? 64 : 128;
  if (width !== expectedSize || height !== expectedSize) throw new Error(`${item.file} possui ${width}×${height}; esperado ${expectedSize}×${expectedSize}.`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== item.sha256) throw new Error(`Hash divergente em ${item.file}.`);
}

const indexedFolders = [resolve(root, "pack"), resolve(root, "entrega-automatica")];
const pngFiles = (await Promise.all(indexedFolders.map((directory) => collectPngFiles(directory)))).flat();
if (pngFiles.length !== manifest.length) throw new Error(`Manifesto possui ${manifest.length}, mas as pastas possuem ${pngFiles.length} PNGs.`);
for (const file of pngFiles) if (!files.has(file)) throw new Error(`PNG não indexado no manifesto: ${file}`);
for (let index = 0; index < 7; index++) {
  const expected = `entrega-automatica/entrega${index}.png`;
  if (!files.has(expected)) throw new Error(`Emoji de entrega automática ausente: ${expected}`);
}

console.log(`OK: ${manifest.length} emojis, incluindo os 7 arquivos originais do public.zip em ordem, dimensões e hashes válidos.`);
