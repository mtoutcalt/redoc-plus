/**
 * Shared measurement helpers for the large-spec performance tests.
 *
 * These reproduce what happens when Redoc renders a page: for every operation
 * the middle panel reads `parameters`, `requestBody` and `responses`, and the
 * right panel reads the payload samples. The point of the measurement is to
 * count the models and bytes that a *first* render actually requires, so that
 * work which has been deferred to expand-time stays deferred.
 */
import { SchemaModel } from '../../models/Schema';
import { SpecStore } from '../../SpecStore';
import { RedocNormalizedOptions } from '../../RedocNormalizedOptions';
import type { RedocRawOptions } from '../../RedocNormalizedOptions';
import type { OperationModel } from '../../models/Operation';

export interface Measurement {
  /** Number of SchemaModel instances constructed. */
  models: number;
  /** Wall-clock milliseconds to build every model the first render touches. */
  ms: number;
  /** Heap growth in MB across the build. */
  heapMB: number;
  /** Number of operations walked. */
  operations: number;
}

let counter = 0;
let patched = false;

/**
 * Count SchemaModel construction by wrapping `init`, which every instance calls
 * exactly once from its constructor.
 */
function patchCounter() {
  if (patched) return;
  patched = true;
  const proto = SchemaModel.prototype as any;
  const original = proto.init;
  proto.init = function (...args: any[]) {
    counter++;
    return original.apply(this, args);
  };
}

/**
 * Heap readings are only meaningful when we can force a collection first.
 * Without --expose-gc the delta is dominated by whatever GC happened to do
 * during the run, and under parallel jest workers it also picks up other
 * suites' allocations -- so callers must gate assertions on this.
 */
export const heapMeasurable = typeof global.gc === 'function';

function heapMB(): number {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

/**
 * Walk every operation the way the renderer does, forcing the lazy getters that
 * a render reads.
 *
 * `samples` controls whether the right-hand payload-sample panel is included.
 * Today Redoc renders every operation into the DOM at once, so samples are
 * always generated -- pass true to reproduce that. Pass false to model a
 * render-on-demand page that only materialises the operation being viewed.
 */
function touchOperation(op: OperationModel, samples: boolean): void {
  const consumeSchema = (schema: any) => {
    if (!schema) return;
    // The properties the Schema component reads when it renders a schema.
    void schema.fields;
    void schema.items;
    void schema.oneOf;
  };

  const consumeContent = (content: any) => {
    if (!content) return;
    for (const mt of content.mediaTypes) {
      consumeSchema(mt.schema);
      if (samples) void mt.examples;
    }
    // ResponseSamples / codeSamples read this during render.
    void content.hasSample;
  };

  for (const p of op.parameters) consumeSchema(p.schema);
  consumeContent(op.requestBody?.content);
  for (const response of op.responses) consumeContent(response.content);
  if (samples) void op.codeSamples;
  for (const callback of op.callbacks) {
    for (const item of callback.operations || []) touchOperation(item as OperationModel, samples);
  }
}

function collectOperations(items: any[], acc: OperationModel[] = []): OperationModel[] {
  for (const item of items) {
    if (item.type === 'operation') acc.push(item as OperationModel);
    if (item.items?.length) collectOperations(item.items, acc);
  }
  return acc;
}

/**
 * Build a SpecStore from `spec` and force the model construction that a first
 * full render triggers, returning cost metrics.
 */
export interface MeasureOptions {
  /** Include payload-sample generation, i.e. reproduce today's render-everything page. */
  samples?: boolean;
  /**
   * Touch only one operation, the way focus mode renders. The whole menu is
   * still built (that is what the sidebar needs), but only the selected
   * section's schemas and samples are materialised.
   */
  focus?: boolean;
  redoc?: RedocRawOptions;
}

export function measureSpec(spec: any, measureOptions: MeasureOptions = {}): Measurement {
  const { samples = false, focus = false, redoc = {} } = measureOptions;
  patchCounter();
  const options = new RedocNormalizedOptions(redoc);

  counter = 0;
  const before = heapMB();
  const start = Date.now();

  const store = new SpecStore(spec, undefined, options);
  const allOperations = collectOperations(store.contentItems);
  // Focus mode renders one section; pick the middle one so the measurement is
  // not flattered by landing on a trivial first operation.
  const operations = focus
    ? allOperations.slice(
        Math.floor(allOperations.length / 2),
        Math.floor(allOperations.length / 2) + 1,
      )
    : allOperations;
  for (const op of operations) touchOperation(op, samples);

  const ms = Date.now() - start;
  const after = heapMB();

  // Keep the store reachable until after the heap reading.
  if (!store) throw new Error('unreachable');

  return {
    models: counter,
    ms,
    heapMB: Math.round((after - before) * 10) / 10,
    operations: operations.length,
  };
}

export function formatMeasurement(label: string, m: Measurement): string {
  return (
    label.padEnd(22) +
    String(m.operations).padStart(5) +
    ' ops  ' +
    String(m.models).padStart(9) +
    ' models  ' +
    String(m.ms).padStart(7) +
    ' ms  ' +
    String(m.heapMB).padStart(8) +
    ' MB'
  );
}
