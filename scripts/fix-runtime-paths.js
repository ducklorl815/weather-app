'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'main', 'runtime.js');
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  /const APP_ROOT = path\.join\(__dirname, '\.\.'\);/,
  "const APP_ROOT = path.resolve(__dirname, '..');"
);

// All path.join(__dirname, ...) → path.join(APP_ROOT, ...)
s = s.replace(/path\.join\(__dirname,/g, 'path.join(APP_ROOT,');

// Bare resolve of runtime dir → project root
s = s.replace(/path\.resolve\(__dirname\)/g, 'APP_ROOT');

s = s.replace(
  /require\('\.\/package\.json'\)/g,
  "require(path.join(APP_ROOT, 'package.json'))"
);

fs.writeFileSync(p, s);

const leftover = (s.match(/path\.join\(__dirname/g) || []).length;
const appRootDef = (s.match(/const APP_ROOT = path\.resolve\(__dirname, '\.\.'\);/g) || []).length;
console.log('APP_ROOT defs', appRootDef);
console.log('leftover path.join(__dirname', leftover);
console.log('APP_ROOT joins', (s.match(/path\.join\(APP_ROOT,/g) || []).length);
