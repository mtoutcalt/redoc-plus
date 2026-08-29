/**
 * Performance budgets for large / densely-referenced specs.
 *
 * The failure these guard against is not linear in spec size. Redoc used to
 * build the entire SchemaModel tree eagerly: `SchemaModel`'s constructor called
 * `buildFields`, which constructed a `FieldModel` per property, which
 * constructed another `SchemaModel`, and so on, terminating only on the
 * `refsStack` cycle check. Because `refsStack` tracks the current *path*, a
 * schema reachable by N distinct paths was materialised N times, each fully
 * expanded -- so cost grew with reference depth, not file size.
 *
 * Measured on the `tiny` preset below (a 70 KB spec, 27 schemas, 10 paths):
 *
 *              models      time      heap
 *   before    199,823     19.0 s    1194 MB
 *   after         766      0.05 s     13 MB
 *
 * The `small` preset (0.29 MB) could not be built at all before -- it exhausted
 * a 3 GB heap with `Ineffective mark-compacts near heap limit`.
 *
 * Budgets are expressed primarily in SchemaModel instance counts, which are
 * deterministic and machine-independent. Time is not asserted at all and heap is
 * asserted loosely, so this suite does not go flaky on a slow or busy CI box.
 *
 * For chasing a regression, use scripts/measure-spec-cost.js rather than this
 * suite -- jest and jsdom add roughly 10x overhead and obscure which layer is
 * actually slow.
 */
// The stress-spec generator is a build script rather than library code, so it
// lives under scripts/ and is shared with `npm run stress:spec`.
// eslint-disable-next-line import/no-internal-modules
import { buildSpec, resolveConfig } from '../../../../scripts/generate-stress-spec';
import { measureSpec, formatMeasurement, heapMeasurable } from './measure';

jest.setTimeout(180000);

const BUDGETS: Record<string, { maxModels: number; maxHeapMB: number }> = {
  // Baseline before lazy expansion: 199,823 models / 1194 MB.
  tiny: { maxModels: 2000, maxHeapMB: 80 },
  // Baseline before lazy expansion: did not complete, OOM at 3 GB.
  small: { maxModels: 8000, maxHeapMB: 400 },
};

describe('large spec performance', () => {
  for (const [preset, budget] of Object.entries(BUDGETS)) {
    describe(preset + ' spec', () => {
      let measurement: ReturnType<typeof measureSpec>;

      beforeAll(() => {
        measurement = measureSpec(buildSpec(resolveConfig({ preset })));
        // eslint-disable-next-line no-console
        console.log(formatMeasurement(preset, measurement));
      });

      test('builds every operation without exhausting memory', () => {
        expect(measurement.operations).toBeGreaterThan(0);
      });

      test('constructs a bounded number of schema models', () => {
        expect(measurement.models).toBeLessThan(budget.maxModels);
      });

      // Only meaningful under --expose-gc (see `npm run perf`). In a plain
      // parallel `jest` run the delta includes other workers' allocations.
      const heapTest = heapMeasurable ? test : test.skip;
      heapTest('stays within its heap budget', () => {
        expect(measurement.heapMB).toBeLessThan(budget.maxHeapMB);
      });
    });
  }

  test('model count scales with operation count, not reference depth', () => {
    // The property eager expansion violated: depth multiplied the number of
    // models, it did not leave it alone. Measured across depths on the `tiny`
    // preset, model count is now flat (766 at depth 3, 715 at depth 7) where it
    // previously grew without bound.
    //
    // Note this asserts model count only. Wall-clock and heap still grow sharply
    // with depth because of the eager `mergeAllOf` described at the bottom of
    // this file; depth is capped at 5 here so the suite itself can complete.
    const shallow = measureSpec(buildSpec(resolveConfig({ preset: 'tiny', depth: 3 })));
    const deep = measureSpec(buildSpec(resolveConfig({ preset: 'tiny', depth: 5 })));

    const perOpShallow = shallow.models / shallow.operations;
    const perOpDeep = deep.models / deep.operations;

    // eslint-disable-next-line no-console
    console.log(
      `depth 3: ${perOpShallow.toFixed(1)} models/op, depth 5: ${perOpDeep.toFixed(1)} models/op`,
    );

    expect(perOpDeep).toBeLessThan(perOpShallow * 3);
  });

  test('a self-referential schema does not expand without bound', () => {
    // A node with several recursive properties: eager expansion walked every
    // distinct path through it until the cycle check fired on each one.
    const spec = {
      openapi: '3.0.3',
      info: { title: 'recursive', version: '1' },
      paths: {
        '/tree': {
          get: {
            operationId: 'getTree',
            responses: {
              200: {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Node' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              a: { $ref: '#/components/schemas/Node' },
              b: { $ref: '#/components/schemas/Node' },
              c: { $ref: '#/components/schemas/Node' },
              d: { $ref: '#/components/schemas/Node' },
              e: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
            },
          },
        },
      },
    };

    const m = measureSpec(spec);
    // eslint-disable-next-line no-console
    console.log(`single recursive node: ${m.models} models`);
    expect(m.models).toBeLessThan(50);
  });

  test('payload samples are not generated until they are read', () => {
    // Sample generation walks the schema to `generatedSamplesMaxDepth` (10 by
    // default) and retains the result. On the `small` preset, generating samples
    // for every operation costs 12.5 s / 1142 MB against 1.0 s / 136 MB without
    // -- so it must stay off the path of a page that is not showing them.
    const spec = buildSpec(resolveConfig({ preset: 'tiny' }));

    const lazy = measureSpec(spec, { samples: false });
    const eager = measureSpec(spec, { samples: true });

    if (!heapMeasurable) {
      // Compare models instead: sample generation itself allocates no models,
      // so without a reliable heap reading there is nothing to assert here.
      expect(lazy.models).toBe(eager.models);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`samples deferred: ${lazy.heapMB} MB, samples generated: ${eager.heapMB} MB`);

    // Deferring must be strictly cheaper; if `hasSample` ever starts forcing
    // generation again these converge.
    expect(lazy.heapMB).toBeLessThan(eager.heapMB);
  });

  test('focus mode bounds cost to the section on screen', () => {
    // Focus mode renders one menu item at a time. The whole menu is still built
    // -- that is what the sidebar needs -- but only the selected section's
    // schemas and samples are materialised, so cost stops tracking spec size.
    //
    // Measured on `small` with samples on (what a browser actually does):
    //   render everything   3836 models   12.5 s   1142 MB
    //   focus mode            54 models   0.08 s      9 MB
    const spec = buildSpec(resolveConfig({ preset: 'small' }));

    const focused = measureSpec(spec, { focus: true, samples: true });
    const everything = measureSpec(spec, { samples: true });

    // eslint-disable-next-line no-console
    console.log(`focus: ${focused.models} models, render-everything: ${everything.models} models`);

    expect(focused.operations).toBe(1);
    expect(focused.models).toBeLessThan(everything.models / 10);
  });

  /**
   * Known remaining limitation.
   *
   * `medium` and above still exhaust a 6 GB heap. The cause is no longer the
   * model layer but `OpenAPIParser.mergeAllOf`, which is called eagerly from the
   * SchemaModel constructor and recursively merges a schema's whole allOf
   * closure -- including nested property merges -- before anything asks for it.
   * On `small` that is 871,763 merge calls for 3,836 models.
   *
   * It shows up cleanly as depth on the `tiny` preset: model count stays flat
   * while time and heap explode, which is exactly the signature of work being
   * done in the parser rather than the model layer.
   *
   *   depth 3    766 models      39 ms      12 MB
   *   depth 5    725 models     468 ms      23 MB
   *   depth 6    715 models    6273 ms     418 MB
   *   depth 7    715 models   51736 ms    2918 MB
   *   depth 8      -- OOM --
   *
   * Focus mode does not rescue this. On the `large` preset, materialising a
   * *single* operation still exhausts a 4 GB heap -- the cost is per schema and
   * driven by depth, not by how many operations are on screen. Bounding what
   * renders is necessary but not sufficient.
   *
   * Memoising it does not help: only 7.5% of those calls repeat an identical
   * (schema, ref, refsStack) key, because each merge allocates fresh property
   * objects to hang `x-refsStack` on. The fix is the same shape as the one
   * already applied to `fields`: leave a colliding property as an unmerged
   * `{ allOf: [...] }` node and let the SchemaModel that eventually wraps that
   * property do the merge. That changes the shape of `mergeAllOf`'s output and
   * needs its own pass.
   */
  test.skip('medium spec builds within budget (blocked on lazy allOf merging)', () => {
    const m = measureSpec(buildSpec(resolveConfig({ preset: 'medium' })));
    expect(m.models).toBeLessThan(25000);
  });
});
