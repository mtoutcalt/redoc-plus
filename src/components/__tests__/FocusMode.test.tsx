/* tslint:disable:no-implicit-dependencies */
import { mount } from 'enzyme';
import * as React from 'react';

import { Redoc } from '../Redoc/Redoc';
import { AppStore } from '../../services';
import { SchemaModel } from '../../services/models/Schema';

/**
 * Focus mode renders one menu item at a time instead of the whole document.
 *
 * The assertions here are about *how much gets built*, not about markup: the
 * point of the mode is that opening a large spec should not construct models and
 * payload samples for every operation in it.
 */

// Count SchemaModel construction by wrapping `init`, which every instance calls
// exactly once from its constructor.
let modelsBuilt = 0;
const originalInit = (SchemaModel.prototype as any).init;
beforeAll(() => {
  (SchemaModel.prototype as any).init = function (...args: any[]) {
    modelsBuilt++;
    return originalInit.apply(this, args);
  };
});
afterAll(() => {
  (SchemaModel.prototype as any).init = originalInit;
});

/** A spec with several tags, each operation pulling in its own object schema. */
function buildSpec(tags: number, opsPerTag: number) {
  const schemas: any = {};
  const paths: any = {};
  const tagList: any[] = [];

  for (let t = 0; t < tags; t++) {
    tagList.push({ name: 'Tag' + t, description: 'Tag ' + t + ' description.' });
    for (let o = 0; o < opsPerTag; o++) {
      const name = 'Model' + t + '_' + o;
      schemas[name] = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          nested: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'integer' } },
          },
        },
      };
      paths['/t' + t + '/op' + o] = {
        get: {
          tags: ['Tag' + t],
          operationId: 'get' + name,
          summary: 'Get ' + name,
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/' + name } } },
            },
          },
        },
      };
    }
  }

  return {
    openapi: '3.0.3',
    info: { title: 'focus mode', version: '1', description: 'Overview text.' },
    tags: tagList,
    paths,
    components: { schemas },
  };
}

function makeStore(spec: any, focusMode: boolean) {
  return new AppStore(spec as any, undefined, { focusMode, disableSearch: true }, false);
}

/**
 * Mount, returning how many SchemaModels the render constructed and the HTML of
 * the content pane.
 *
 * Deliberately not the whole wrapper: the sidebar always lists every menu item,
 * in focus mode as much as in the default view -- that is how you navigate. Only
 * the content pane tells you what was actually built.
 */
function mountAndCount(store: AppStore): { models: number; html: string } {
  modelsBuilt = 0;
  const wrapper = mount(<Redoc store={store} />);
  // styled-components yields both the styled wrapper and the DOM node for the
  // class, so take the last (the rendered element) rather than assuming one.
  const pane = wrapper.find('div.api-content').last();
  const result = { models: modelsBuilt, html: pane.html() };
  wrapper.unmount();
  return result;
}

describe('focus mode', () => {
  const spec = buildSpec(4, 5); // 20 operations

  it('renders only the selected operation, not the whole document', () => {
    const focused = makeStore(spec, true);
    const target = focused.menu.flatItems.find(i => i.id.includes('getModel2_3'))!;
    expect(target).toBeDefined();
    focused.menu.activate(target);

    const focusedResult = mountAndCount(focused);
    const fullResult = mountAndCount(makeStore(spec, false));

    // eslint-disable-next-line no-console
    console.log(`focus mode: ${focusedResult.models} models, default: ${fullResult.models} models`);

    // The selected operation is on the page...
    expect(focusedResult.html).toContain('Get Model2_3');
    // ...and the other 19 are not.
    expect(focusedResult.html).not.toContain('Get Model0_0');
    expect(fullResult.html).toContain('Get Model0_0');

    // Which is the whole point: cost tracks what is on screen.
    expect(focusedResult.models).toBeLessThan(fullResult.models / 5);
  });

  it('shows the API overview when nothing is selected', () => {
    const store = makeStore(spec, true);
    const { html, models } = mountAndCount(store);

    expect(html).toContain('Overview text.');
    expect(html).not.toContain('Get Model0_0');
    // The landing state builds no schemas at all.
    expect(models).toBe(0);
  });

  it('gives a tag an index of its operations instead of expanding them', () => {
    const store = makeStore(spec, true);
    const tag = store.menu.flatItems.find(i => i.id === 'tag/Tag1')!;
    expect(tag).toBeDefined();
    store.menu.activate(tag);

    const { html, models } = mountAndCount(store);

    expect(html).toContain('Tag 1 description.');
    // Links to the tag's operations, but none of their bodies.
    expect(html).toContain('Get Model1_0');
    expect(html).not.toContain('Response samples');
    // Links are free: no schema models are constructed to render them.
    expect(models).toBe(0);
  });

  it('leaves the default rendering path untouched', () => {
    const store = makeStore(spec, false);
    const { html } = mountAndCount(store);

    // Every operation is present, as before.
    expect(html).toContain('Get Model0_0');
    expect(html).toContain('Get Model3_4');
    expect(html).toContain('Overview text.');
  });
});
