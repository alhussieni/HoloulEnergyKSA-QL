// Pulls a single named top-level function's exact source text out of
// assets/js/app.js by brace-matching, then evaluates it in an isolated
// vm context. This lets us regression-test individual pure calculation
// functions from the live monolith WITHOUT needing a browser/DOM/Supabase
// mocks for the rest of the file — deliberately narrow in scope, but zero
// risk of testing stale/copy-pasted logic that has drifted from the real
// file.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// app.js was split into ordered module files (see index.html for the load
// order — this list MUST match it exactly, since some functions defined
// in an earlier file are used by ones in a later file, same as the plain
// <script> tags in the real page).
const MODULE_FILES = [
  "01-supabase-engine.js",
  "02-client-cache.js",
  "03-admin-auth.js",
  "04-state.js",
  "05-render-calculator.js",
  "06-render-feasibility.js",
  "07-render-admin.js",
  "08-wiring.js",
].map((f) => path.join(__dirname, "..", "..", "assets", "js", "modules", f));

function readAppSource() {
  return MODULE_FILES.map((p) => fs.readFileSync(p, "utf8")).join("\n\n");
}

function extractFunctionSource(src, name) {
  const startMarker = `function ${name}(`;
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `extractFunctionSource: "${name}" not found in app.js — did it get renamed or moved? Update tests/regression accordingly.`
    );
  }
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

/**
 * Loads one or more named top-level functions from the live assets/js/app.js
 * and returns them as callable JS functions, wired to each other (so e.g.
 * computeFeasibility can call irr if both are requested together).
 */
function loadFunctions(names) {
  const src = readAppSource();
  const sources = names.map((n) => extractFunctionSource(src, n));
  // vm context doesn't have `module` by default — provide it explicitly.
  const sandbox = { module: { exports: {} }, console };
  vm.createContext(sandbox);
  // A few pure functions read module-level globals that app.js declares
  // outside the function body itself (e.g. `cachedFeas`, populated at
  // runtime from the server). Declare the ones we know about here as their
  // real default value, so extracted functions behave exactly as they do
  // on a freshly-loaded page before any server response has arrived.
  const knownGlobals = "let cachedFeas = null;\n";
  vm.runInContext(
    knownGlobals + sources.join("\n\n") + `\n\nmodule.exports = { ${names.join(", ")} };`,
    sandbox
  );
  return sandbox.module.exports;
}

module.exports = { loadFunctions, extractFunctionSource };
