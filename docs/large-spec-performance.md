# Large specification performance

Working notes on why Redoc runs out of browser memory on large OpenAPI
specifications, what has been fixed, and what is still outstanding.

The short version: **the cost was never proportional to file size.** It was
proportional to how many distinct *paths* exist through the reference graph, and
that grows multiplicatively with reference depth. A 70 KB specification could
allocate 1.2 GB.

---

## Reproducing it

Two scripts support this work.

```bash
# Generate a specification shaped like the ones that break Redoc
node scripts/generate-stress-spec.js --preset large --out demo/stress.json

# Measure what a first render costs, without jest in the way
node scripts/measure-spec-cost.js --preset small
node scripts/measure-spec-cost.js --preset small --samples   # render everything
node scripts/measure-spec-cost.js --preset small --focus     # focus mode
node scripts/measure-spec-cost.js --spec ./your-real-spec.json

# The regression suite
npm run perf
```

`scripts/generate-stress-spec.js` produces specifications with a densely
cross-referenced component library plus genuinely recursive types — self
reference, mutual recursion, recursion through arrays and through
`additionalProperties`. Presets range from `tiny` to `huge`.

The important property of the generator is that its layered section is
**completely acyclic**. Cycles are not what makes Redoc fall over. A plain DAG
where the same subtree is reachable by many different paths is enough, and that
describes most real specifications with a shared component library.

Use `scripts/measure-spec-cost.js` rather than `npm run perf` when chasing a
regression: jest and jsdom add roughly 10x overhead, which is enough to hide
which layer is actually expensive. That overhead misled an early attempt at
attributing cost in this investigation.

---

## What was wrong

### 1. Schema expansion was eager

`SchemaModel`'s constructor called `buildFields`, which constructed a
`FieldModel` per property, which constructed another `SchemaModel`, and so on.
The only termination condition was the `refsStack` cycle check.

Because `refsStack` tracks the current **path**, a schema reachable by N distinct
paths was materialised N times, each fully expanded. Cost was exponential in
reference depth.

Nothing needed that work up front. The renderer only ever shows one level at a
time: `ObjectSchema` renders the property rows, and `Field` renders a nested
`<Schema>` only once the reader expands that row.

**Fix:** `SchemaModel.fields` became a lazily-evaluated getter
(`src/services/models/Schema.ts`). The internal bookkeeping is defined
non-enumerable so that serialized output does not depend on whether anything has
read `.fields` yet — otherwise snapshots become order-dependent.

### 2. Payload samples were eager

`MediaTypeModel` generated a sample for every media type of every operation at
construction time, walking the schema to `generatedSamplesMaxDepth` (default
**10**) and retaining the resulting object graph for the lifetime of the page.

`MediaContentModel.hasSample` made it worse: it answered a yes/no question by
reading `.examples`, which forced generation for the whole document.

**Fix:** generation is deferred to the first read of `.examples`, and
`hasSample` now consults a cheap `hasExamples` predicate
(`src/services/models/MediaType.ts`, `MediaContent.ts`).

### 3. Ref stacks compounded

This one is a genuine algorithmic bug, independent of laziness.

`mergeAllOf` stamps an `x-refsStack` array onto every merged property. `deref`
then *concatenates* that stored stack onto the current path stack. So stack
length compounded with reference depth instead of growing with it.

Measured on the `small` preset: **maximum stack depth 10,546**, against a
`MAX_DEREF_DEPTH` guard of 999 that was supposed to cap it, and **147 million
array entries** allocated in total. That dominated both time and heap.

`refsStack` is only ever consulted two ways — `includes($ref)` for cycle
detection, and a length check. A repeated ref carries no information for either.

**Fix:** `concatRefStacks` drops refs already present
(`src/services/OpenAPIParser.ts`). This is semantics-preserving: `includes()`
answers identically. Result: 147M → 4.7M entries, max depth 10,546 → 12.

The one visible change is a snapshot where a stack recorded as
`[Dog, Dog, Pet, Dog, Pet, Dog]` is now `[Dog, Pet]`.

### 4. Everything rendered at once

Redoc mounts every operation into the DOM on load, so all of the above happened
for the entire API before the reader looked at anything.

**Fix:** a `focusMode` option renders only the selected section. See below.

---

## Focus mode

`focusMode: true` renders one menu item at a time instead of the whole document.

- Selecting an **operation** renders that operation.
- Selecting a **tag** renders its description plus a list of links to its
  operations. The operations are deliberately *not* expanded — a tag with 200 of
  them would put the original problem straight back.
- With nothing selected, the API overview is the landing page.

Rendering the child links costs nothing: it reads `sidebarLabel` and `id`, never
the schemas.

Implementation notes:

- Scroll spy is disabled when `focusMode` is on (`MenuStore.subscribe`). Only one
  section is mounted, so there is nothing to track, and leaving it running would
  fight the menu by reactivating whichever item happened to be on screen.
- `scrollToActive` scrolls to the top of the content pane rather than to an
  element, because activation is what *causes* the section to render — there is
  no target element at the time the scroll is requested.
- The sidebar still lists every item. That is how you navigate, and menu labels
  are cheap.
- Deep links, search, and history all work unchanged: they route through
  `MenuStore.activate`, which is what drives the render.

---

## Numbers

All measured with `scripts/measure-spec-cost.js` (no jest overhead).

### Before and after, rendering everything

| preset | on disk | before | after |
| --- | --- | --- | --- |
| tiny | 70 KB | 199,132 models · 1246 MB | 766 models · 13 MB |
| small | 0.29 MB | **OOM at 3 GB** | 3,836 models · 971 ms · 125 MB |

Before the fixes, `small` failed with
`FATAL ERROR: Ineffective mark-compacts near heap limit`.

### Focus mode, on `small`, with samples on (what a browser actually does)

| mode | models | time | heap |
| --- | --- | --- | --- |
| render everything | 3,836 | 12.5 s | 1142 MB |
| focus mode | 54 | 0.08 s | 9 MB |

### Depth is now flat in model count, but not in cost

On the `tiny` preset, varying only reference depth:

| depth | models | time | heap |
| --- | --- | --- | --- |
| 3 | 766 | 39 ms | 12 MB |
| 5 | 725 | 468 ms | 23 MB |
| 6 | 715 | 6,273 ms | 418 MB |
| 7 | 715 | 51,736 ms | 2,918 MB |
| 8 | — | OOM | — |

Model count is **flat**, which is exactly what the lazy-expansion fix was for.
Time and heap still explode. That divergence is the signature of the remaining
bug: the work is happening in the parser, not the model layer.

---

## What is still outstanding

**`mergeAllOf` is eager and re-walks the reference graph.**

It is called from the `SchemaModel` constructor and recursively merges a schema's
entire `allOf` closure — including nested property merges — before anything asks
for it. On the `small` preset that is **871,763 merge calls for 3,836 models**.

Focus mode does not rescue this. On the `large` preset, materialising a *single*
operation still exhausts a 4 GB heap. The cost is per schema and driven by depth,
not by how many operations are on screen. Bounding what renders is necessary but
not sufficient.

Memoising it does not help either: only **7.5%** of those calls repeat an
identical `(schema, ref, refsStack)` key, because each merge allocates fresh
property objects to hang `x-refsStack` on, so object identity never repeats.

The fix is the same shape as the one already applied to `fields`: leave a
colliding property as an unmerged `{ allOf: [...] }` node and let the
`SchemaModel` that eventually wraps that property perform the merge. That changes
the shape of `mergeAllOf`'s output, so anything reading merged properties
directly needs auditing, and it wants its own pass. It is marked with a skipped
test in `src/services/__tests__/perf/large-spec.perf.test.ts`.

---

## Caveats

- **The generator is deliberately adversarial.** Its fan-out is higher than most
  real specifications. Treat the presets as a stress ceiling, not a prediction —
  point `measure-spec-cost.js --spec` at your actual specification to calibrate.
- **Some options re-create the problem.** `schemasExpansionLevel: 'all'` and
  `expandResponses: 'all'` force expansion at build time, which defeats the lazy
  field work by design.
- **Heap assertions need `--expose-gc`.** `npm run perf` passes it and runs in
  band. Under a plain parallel `jest` run those assertions are skipped, because
  the delta would include other workers' allocations.
