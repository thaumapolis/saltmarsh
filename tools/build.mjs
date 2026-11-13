#!/usr/bin/env node
/**
 * Assemble the single self-contained index.html.
 *
 * Concatenation, not a bundler. The artifact has to run from file:// and inside a
 * sandboxed opaque-origin iframe, and a module script is blocked in both. So the
 * JavaScript must be inline classic script, which means the modules are
 * concatenated into one shared scope in dependency order.
 *
 * Same approach as the other projects in this organisation, and the same three
 * guarantees are asserted rather than assumed: modules are in dependency order,
 * no two modules declare the same top-level name (legal across modules, fatal in
 * one scope, and presents as a blank page), and every placeholder is consumed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = ['tide.js', 'marsh.js', 'life.js', 'render.js', 'sim.js', 'app.js'];

function stripModuleSyntax(source, name) {
  const lines = source.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^import\s+\{[^}]*\}\s+from '\.\/[^']+';?\s*$/.test(line)) continue;
    if (/^import\s+\{\s*$/.test(line)) {
      let closed = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\}\s*from '\.\/[^']+';?\s*$/.test(lines[j])) {
          closed = j;
          break;
        }
      }
      if (closed === -1) throw new Error(`${name}: unterminated import starting at line ${i + 1}`);
      i = closed;
      continue;
    }
    if (/^import\s/.test(line)) throw new Error(`${name}: unsupported import form: ${line}`);
    if (/^export\s+(class|function|const|let)\s/.test(line)) {
      kept.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\s*\{/.test(line)) {
      throw new Error(`${name}: re-export (${line.trim()}) is not supported; call through a function instead`);
    }
    if (/^export\b/.test(line)) throw new Error(`${name}: unsupported export form: ${line}`);
    kept.push(line);
  }
  return kept.join('\n');
}

function assertNoTopLevelCollisions(sources) {
  const declared = new Map();
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const previous = declared.get(match[1]);
      if (previous !== undefined && previous !== name) {
        throw new Error(`top-level name "${match[1]}" is declared in both ${previous} and ${name}`);
      }
      declared.set(match[1], name);
    }
  }
}

export function buildArtifact(root) {
  const template = readFileSync(join(root, 'src', 'page.html'), 'utf8');
  const styles = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

  const sources = MODULES.map((name) => [
    name,
    stripModuleSyntax(readFileSync(join(root, 'src', name), 'utf8'), name),
  ]);
  assertNoTopLevelCollisions(sources);
  const bundle = sources.map(([name, source]) => `// ---- src/${name} ----\n${source}`).join('\n\n');

  const scriptPlaceholder = /<script>\n\/\* __SALTMARSH_JS__ \*\/\n<\/script>/;
  if (!scriptPlaceholder.test(template)) throw new Error('template is missing the script placeholder');
  const inlined = `<script>\n(function () {\n'use strict';\n\n${bundle}\n})();\n</script>`;

  const page = template
    .replace(scriptPlaceholder, inlined)
    .replace('/* __SALTMARSH_CSS__ */', () => styles);

  for (const token of ['__SALTMARSH_JS__', '__SALTMARSH_CSS__']) {
    if (page.includes(token)) throw new Error(`build placeholder ${token} survived into the artifact`);
  }
  return page;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [outArg] = process.argv.slice(2);
  // Output path is an argument because inside `nix build` the source tree is a
  // read-only store path and writing beside src/ fails with EACCES.
  const out = outArg === undefined ? join(root, 'index.html') : resolve(outArg);
  const page = buildArtifact(root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page);
  process.stdout.write(`built ${out} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KiB)\n`);
}
