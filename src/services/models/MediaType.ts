import * as Sampler from 'openapi-sampler';

import type { OpenAPIMediaType } from '../../types';
import type { RedocNormalizedOptions } from '../RedocNormalizedOptions';
import { SchemaModel } from './Schema';

import { isJsonLike, mapValues } from '../../utils';
import type { OpenAPIParser } from '../OpenAPIParser';
import { ExampleModel } from './Example';

export class MediaTypeModel {
  schema?: SchemaModel;
  name: string;
  isRequestType: boolean;
  onlyRequiredInSamples: boolean;
  generatedSamplesMaxDepth: number;

  /**
   * Generating a payload sample walks the schema to `generatedSamplesMaxDepth`
   * (default 10) and retains the resulting object graph for the lifetime of the
   * page. On a spec with wide fan-out that is the single most expensive thing
   * Redoc does, and it was previously done eagerly for every media type of every
   * operation during the initial build.
   *
   * Only the samples panel actually reads the result, so generation is deferred
   * to the first read. `hasExamples` answers the "are there samples?" question
   * without paying for them.
   */
  private pendingExamples?: () => { [name: string]: ExampleModel } | undefined;
  private resolvedExamples?: { [name: string]: ExampleModel };

  /**
   * @param isRequestType needed to know if skipe RO/RW fields in objects
   */
  constructor(
    parser: OpenAPIParser,
    name: string,
    isRequestType: boolean,
    info: OpenAPIMediaType,
    options: RedocNormalizedOptions,
  ) {
    // Keep lazy bookkeeping off the enumerable surface so serialized output does
    // not depend on whether anything has read `.examples` yet.
    for (const key of ['pendingExamples', 'resolvedExamples']) {
      Object.defineProperty(this, key, {
        value: undefined,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }

    this.name = name;
    this.isRequestType = isRequestType;
    this.schema = info.schema && new SchemaModel(parser, info.schema, '', options);
    this.onlyRequiredInSamples = options.onlyRequiredInSamples;
    this.generatedSamplesMaxDepth = options.generatedSamplesMaxDepth;
    if (info.examples !== undefined) {
      this.resolvedExamples = mapValues(
        info.examples,
        example => new ExampleModel(parser, example, name, info.encoding),
      );
    } else if (info.example !== undefined) {
      this.resolvedExamples = {
        default: new ExampleModel(
          parser,
          { value: parser.deref(info.example).resolved },
          name,
          info.encoding,
        ),
      };
    } else if (isJsonLike(name) && this.schema) {
      // Deferred: see the note on `pendingExamples`.
      this.pendingExamples = () => this.generateExample(parser, info);
    }
  }

  get examples(): { [name: string]: ExampleModel } | undefined {
    if (this.resolvedExamples === undefined && this.pendingExamples !== undefined) {
      const build = this.pendingExamples;
      this.pendingExamples = undefined;
      this.resolvedExamples = build();
    }
    return this.resolvedExamples;
  }

  set examples(value: { [name: string]: ExampleModel } | undefined) {
    this.pendingExamples = undefined;
    this.resolvedExamples = value;
  }

  /**
   * Whether this media type has samples, without generating them.
   * `generateExample` always produces at least one entry when `schema` is set,
   * which is the only condition under which generation is scheduled.
   */
  get hasExamples(): boolean {
    return this.pendingExamples !== undefined || this.resolvedExamples !== undefined;
  }

  generateExample(
    parser: OpenAPIParser,
    info: OpenAPIMediaType,
  ): { [name: string]: ExampleModel } | undefined {
    const samplerOptions = {
      skipReadOnly: this.isRequestType,
      skipWriteOnly: !this.isRequestType,
      skipNonRequired: this.isRequestType && this.onlyRequiredInSamples,
      maxSampleDepth: this.generatedSamplesMaxDepth,
    };
    if (this.schema && this.schema.oneOf) {
      const examples: { [name: string]: ExampleModel } = {};
      for (const subSchema of this.schema.oneOf) {
        const sample = Sampler.sample(subSchema.rawSchema as any, samplerOptions, parser.spec);

        if (this.schema.discriminatorProp && typeof sample === 'object' && sample) {
          sample[this.schema.discriminatorProp] = subSchema.title;
        }

        examples[subSchema.title] = new ExampleModel(
          parser,
          {
            value: sample,
          },
          this.name,
          info.encoding,
        );
      }
      return examples;
    } else if (this.schema) {
      return {
        default: new ExampleModel(
          parser,
          {
            value: Sampler.sample(info.schema as any, samplerOptions, parser.spec),
          },
          this.name,
          info.encoding,
        ),
      };
    }
    return undefined;
  }
}
