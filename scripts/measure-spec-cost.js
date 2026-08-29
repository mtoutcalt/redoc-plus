#!/usr/bin/env node
/**
 * Measures what a first render of a spec costs, without jest in the way.
 *
 * jest + jsdom adds roughly an order of magnitude of overhead to these numbers,
 * which is enough to hide which layer is actually expensive -- so use this, not
 * the test suite, when you are chasing a regression.
 *
 *   node scripts/measure-spec-cost.js --preset small
 *   node scripts/measure-spec-cost.js --preset small --samples
 *   node scripts/measure-spec-cost.js --spec ./my-real-spec.json
 *
 * --samples reproduces today's render-everything page, which generates a payload
 * sample for every media type of every operation. Without it you get the cost of
 * a render-on-demand page that only materialises the operation being viewed.
 *
 * Combine with --cpu-prof to find hot spots:
 *   node --cpu-prof --cpu-prof-dir=./prof scripts/measure-spec-cost.js --preset small
 */
const fs = require('fs');
const path = require('path');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    target: 'es2019',
    experimentalDecorators: true,
    jsx: 'react',
  },
});

const { buildSpec, resolveConfig, PRESETS } = require('./generate-stress-spec');
const measurePath = path.join(
  __dirname,
  '..',
  'src',
  'services',
  '__tests__',
  'perf',
  'measure.ts',
);
const { measureSpec, formatMeasurement } = require(measurePath);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(
    'Usage: node scripts/measure-spec-cost.js [--preset ' +
      Object.keys(PRESETS).join('|') +
      ' | --spec FILE] [--samples] [--focus]',
  );
  process.exit(0);
}

let spec;
let label;
if (args.spec && typeof args.spec === 'string') {
  spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  label = path.basename(args.spec);
} else {
  const preset = typeof args.preset === 'string' ? args.preset : 'small';
  spec = buildSpec(resolveConfig({ preset: preset }));
  label = preset;
}

const samples = !!args.samples;
const focus = !!args.focus;
const m = measureSpec(spec, { samples: samples, focus: focus });
console.log(formatMeasurement(label + (focus ? ' [focus]' : '') + (samples ? ' +samples' : ''), m));
