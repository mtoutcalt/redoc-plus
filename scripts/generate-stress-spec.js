#!/usr/bin/env node
/**
 * Generates an OpenAPI 3.0 spec shaped like the ones that make Redoc run out of
 * memory: a shared component library whose schemas reference each other densely,
 * plus genuinely recursive (self-referential) types.
 *
 * The point is not raw file size. It is *expansion* size -- how many SchemaModel
 * instances Redoc's eager builder has to allocate in order to render it.
 *
 *   node scripts/generate-stress-spec.js --preset medium --out demo/stress.json
 *
 * Presets are calibrated so that `small` builds fine today and `large` does not.
 */
const fs = require('fs');
const path = require('path');

const PRESETS = {
  tiny: {
    operations: 10,
    schemas: 20,
    refsPerSchema: 3,
    propsPerSchema: 8,
    recursiveTypes: 1,
    depth: 3,
  },
  small: {
    operations: 40,
    schemas: 80,
    refsPerSchema: 4,
    propsPerSchema: 10,
    recursiveTypes: 2,
    depth: 4,
  },
  medium: {
    operations: 120,
    schemas: 250,
    refsPerSchema: 5,
    propsPerSchema: 12,
    recursiveTypes: 4,
    depth: 5,
  },
  large: {
    operations: 300,
    schemas: 600,
    refsPerSchema: 6,
    propsPerSchema: 14,
    recursiveTypes: 8,
    depth: 6,
  },
  huge: {
    operations: 600,
    schemas: 1200,
    refsPerSchema: 8,
    propsPerSchema: 16,
    recursiveTypes: 12,
    depth: 8,
  },
};

const PRIMITIVES = [
  { type: 'string' },
  { type: 'string', format: 'date-time' },
  { type: 'string', format: 'uuid' },
  { type: 'integer', format: 'int64' },
  { type: 'number', format: 'double' },
  { type: 'boolean' },
  { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED'] },
];

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

// Deterministic PRNG so a given preset always produces byte-identical output.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSpec(cfg) {
  const rnd = mulberry32(cfg.seed === undefined ? 42 : cfg.seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const schemas = {};

  // ---- Recursive types: the self-referential shapes that blow the memory budget.
  // Each references itself directly, through an array, through additionalProperties,
  // and through a sibling -- i.e. mutual recursion, not only direct.
  const recursiveNames = [];
  for (let r = 0; r < cfg.recursiveTypes; r++) {
    recursiveNames.push('RecursiveNode' + r);
  }
  recursiveNames.forEach((name, r) => {
    const peer = recursiveNames[(r + 1) % recursiveNames.length];
    schemas[name] = {
      type: 'object',
      description: 'Self-referential node type ' + r + '.',
      properties: {
        id: { type: 'string', format: 'uuid' },
        label: { type: 'string' },
        parent: { $ref: '#/components/schemas/' + name },
        children: { type: 'array', items: { $ref: '#/components/schemas/' + name } },
        related: { type: 'array', items: { $ref: '#/components/schemas/' + peer } },
        index: { type: 'object', additionalProperties: { $ref: '#/components/schemas/' + name } },
        metadata: {
          type: 'object',
          properties: {
            createdAt: { type: 'string', format: 'date-time' },
            snapshot: { $ref: '#/components/schemas/' + name },
          },
        },
      },
      required: ['id'],
    };
  });

  // ---- Leaf schemas: plain objects with no refs. These terminate the graph.
  const leafCount = Math.max(4, Math.floor(cfg.schemas * 0.15));
  const leafNames = [];
  for (let i = 0; i < leafCount; i++) {
    const name = 'Leaf' + i;
    leafNames.push(name);
    const props = {};
    for (let p = 0; p < cfg.propsPerSchema; p++) {
      // Type is a function of the property name, not random: a schema that
      // extends another via allOf must not contradict the inherited type.
      props['field' + p] = Object.assign({}, PRIMITIVES[p % PRIMITIVES.length], {
        description: 'Leaf field ' + p,
      });
    }
    schemas[name] = { type: 'object', title: name, properties: props };
  }

  // ---- Layered DAG. Every schema in layer N references `refsPerSchema` distinct
  // schemas in layer N+1. There are no cycles here at all. This is the part people
  // do not expect to be expensive: the spec is acyclic and small on disk, but the
  // same subtree is reachable by many distinct paths, so eager expansion
  // re-materialises it once per path.
  const layerCount = cfg.depth;
  const remaining = cfg.schemas - leafCount - recursiveNames.length;
  const perLayer = Math.max(2, Math.floor(remaining / layerCount));
  const layers = [];
  for (let l = 0; l < layerCount; l++) {
    const names = [];
    for (let i = 0; i < perLayer; i++) names.push('L' + l + '_Model' + i);
    layers.push(names);
  }

  layers.forEach((names, l) => {
    const below = l + 1 < layers.length ? layers[l + 1] : leafNames;
    names.forEach((name, i) => {
      const props = {};
      for (let p = 0; p < cfg.propsPerSchema; p++) {
        props['attr' + p] = Object.assign({}, PRIMITIVES[p % PRIMITIVES.length], {
          description: 'Scalar attribute ' + p,
        });
      }
      for (let f = 0; f < cfg.refsPerSchema; f++) {
        const target = below[(i * cfg.refsPerSchema + f) % below.length];
        props['ref' + f] = { $ref: '#/components/schemas/' + target };
        props['refList' + f] = {
          type: 'array',
          items: { $ref: '#/components/schemas/' + target },
        };
      }
      if (recursiveNames.length && (i + l) % 3 === 0) {
        props.tree = { $ref: '#/components/schemas/' + pick(recursiveNames) };
      }
      const base = {
        type: 'object',
        title: name,
        description: 'Layer ' + l + ' model ' + i + '.',
        properties: props,
        required: ['attr0'],
      };
      // Every third schema goes through allOf, which forces the merge path.
      schemas[name] =
        i % 3 === 0 ? { allOf: [{ $ref: '#/components/schemas/' + pick(below) }, base] } : base;
    });
  });

  // ---- A polymorphic envelope with a discriminator, referenced by most responses.
  const variantNames = layers[0].slice(0, Math.min(6, layers[0].length));
  const mapping = {};
  variantNames.forEach(n => {
    mapping[n] = '#/components/schemas/' + n + 'Envelope';
  });
  schemas.Envelope = {
    type: 'object',
    required: ['kind'],
    properties: { kind: { type: 'string' }, requestId: { type: 'string', format: 'uuid' } },
    discriminator: { propertyName: 'kind', mapping: mapping },
  };
  variantNames.forEach(n => {
    schemas[n + 'Envelope'] = {
      allOf: [
        { $ref: '#/components/schemas/Envelope' },
        { type: 'object', properties: { data: { $ref: '#/components/schemas/' + n } } },
      ],
    };
  });

  schemas.Error = {
    type: 'object',
    properties: {
      code: { type: 'integer' },
      message: { type: 'string' },
      // errors nest errors -- another recursion source
      causes: { type: 'array', items: { $ref: '#/components/schemas/Error' } },
    },
  };

  // ---- Operations, spread across tags, each pulling in the heavy schemas.
  const allRefNames = layers.reduce((acc, l) => acc.concat(l), []).concat(recursiveNames);
  const paths = {};
  const tags = [];
  const tagCount = Math.max(1, Math.ceil(cfg.operations / 10));
  for (let t = 0; t < tagCount; t++) {
    tags.push({ name: 'Resource' + t, description: 'Operations for resource group ' + t + '.' });
  }

  for (let o = 0; o < cfg.operations; o++) {
    const tag = 'Resource' + (o % tagCount);
    const model = allRefNames[o % allRefNames.length];
    paths['/api/v1/resource' + (o % tagCount) + '/items' + o] = {
      get: {
        tags: [tag],
        summary: 'Get item ' + o,
        operationId: 'getItem' + o,
        description: 'Returns a single item ' + o + '.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'expand', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'filter', in: 'query', schema: { $ref: '#/components/schemas/' + model } },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/' + model } },
            },
          },
          400: {
            description: 'Bad request',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
      post: {
        tags: [tag],
        summary: 'Create item ' + o,
        operationId: 'createItem' + o,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/' + model } },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
          },
          400: {
            description: 'Bad request',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Stress Test API (' + (cfg.label || 'custom') + ')',
      version: '1.0.0',
      description:
        'Generated stress-test spec: ' +
        cfg.operations +
        ' operations, ' +
        Object.keys(schemas).length +
        ' schemas, ' +
        cfg.recursiveTypes +
        ' recursive types, fanout ' +
        cfg.refsPerSchema +
        ', depth ' +
        cfg.depth +
        '.',
    },
    tags: tags,
    paths: paths,
    components: { schemas: schemas },
  };
}

function resolveConfig(args) {
  const presetName = args.preset || 'medium';
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      'Unknown preset "' + presetName + '". Options: ' + Object.keys(PRESETS).join(', '),
    );
  }
  const num = (v, d) => (v === undefined ? d : Number(v));
  return {
    label: presetName,
    operations: num(args.operations, preset.operations),
    schemas: num(args.schemas, preset.schemas),
    refsPerSchema: num(args.refsPerSchema, preset.refsPerSchema),
    propsPerSchema: num(args.propsPerSchema, preset.propsPerSchema),
    recursiveTypes: num(args.recursiveTypes, preset.recursiveTypes),
    depth: num(args.depth, preset.depth),
    seed: num(args.seed, 42),
  };
}

module.exports = { buildSpec: buildSpec, PRESETS: PRESETS, resolveConfig: resolveConfig };

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/generate-stress-spec.js [--preset ' +
        Object.keys(PRESETS).join('|') +
        '] [--out FILE]\n\n' +
        'Overrides: --operations --schemas --refsPerSchema --propsPerSchema --recursiveTypes --depth --seed',
    );
    process.exit(0);
  }
  const cfg = resolveConfig(args);
  const spec = buildSpec(cfg);
  const out = args.out || path.join('demo', 'stress-' + cfg.label + '.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const json = JSON.stringify(spec, null, 2);
  fs.writeFileSync(out, json);
  console.log(
    'Wrote ' +
      out +
      '\n  ' +
      Object.keys(spec.paths).length +
      ' paths, ' +
      Object.keys(spec.components.schemas).length +
      ' schemas, ' +
      (json.length / 1048576).toFixed(2) +
      ' MB on disk',
  );
}
