#!/usr/bin/env node
// WCAG contrast gate for the SmartNotes web theme tokens.
//
// Reads web/src/styles.css (the shipped stylesheet, not a copy of its values),
// extracts the light-theme tokens from `:root{...}` and the dark-theme tokens
// from the `@media(prefers-color-scheme:dark)` override, and computes WCAG 2.x
// contrast ratios. Exits 0 only when body text reaches at least 4.5:1 against
// both the page background and the panel surface in both themes; any parse
// failure or ratio below the threshold exits 1.
//
// Usage: node web/scripts/contrast.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css');
const css = readFileSync(cssPath, 'utf8');

function tokensFrom(block, label) {
  const tokens = {};
  for (const [, name, value] of block.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
    tokens[name] = value;
  }
  for (const required of ['background', 'surface', 'body', 'secondary', 'accent']) {
    if (!tokens[required]) throw new Error(`missing --${required} in ${label} tokens of ${cssPath}`);
  }
  return tokens;
}

const lightMatch = css.match(/:root\s*\{([^}]*)\}/);
if (!lightMatch) throw new Error(`no :root{} block found in ${cssPath}`);
const darkMatch = css.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}/);
if (!darkMatch) throw new Error(`no @media(prefers-color-scheme:dark) :root{} override found in ${cssPath}`);

const themes = {
  light: tokensFrom(lightMatch[1], 'light'),
  dark: tokensFrom(darkMatch[1], 'dark'),
};

function srgbChannel(hexPair) {
  const c = parseInt(hexPair, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((d) => d + d).join('');
  if (h.length !== 6) throw new Error(`unsupported color literal ${hex}`);
  return 0.2126 * srgbChannel(h.slice(0, 2)) + 0.7152 * srgbChannel(h.slice(2, 4)) + 0.0722 * srgbChannel(h.slice(4, 6));
}

function ratio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const REQUIRED = 4.5;
let failures = 0;
for (const [theme, t] of Object.entries(themes)) {
  console.log(`${theme} theme (body ${t.body})`);
  for (const surface of ['background', 'surface']) {
    const r = ratio(t.body, t[surface]);
    const ok = r >= REQUIRED;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} body on ${surface} ${t[surface]}: ${r.toFixed(2)}:1 (required ${REQUIRED}:1)`);
  }
  // Informational, not gated: the acceptance threshold applies to body text.
  console.log(`  info secondary on background: ${ratio(t.secondary, t.background).toFixed(2)}:1`);
  console.log(`  info secondary on surface: ${ratio(t.secondary, t.surface).toFixed(2)}:1`);
  console.log(`  info accent on surface: ${ratio(t.accent, t.surface).toFixed(2)}:1`);
}

if (failures > 0) {
  console.error(`\n${failures} contrast check(s) below ${REQUIRED}:1 — failing.`);
  process.exit(1);
}
console.log(`\nAll body-text contrast checks meet ${REQUIRED}:1 in both themes.`);
