import { observer } from 'mobx-react';
import * as React from 'react';

import { MiddlePanel, Row } from '../../common-elements';
import { Link } from '../../common-elements/linkify';
import styled from '../../styled-components';
import type { AppStore } from '../../services';
import type { IMenuItem } from '../../services';
import { OperationModel } from '../../services/models';
import { shortenHTTPVerb } from '../../utils/openapi';
import { ApiInfo } from '../ApiInfo/';
import { ContentItem } from './ContentItems';

export interface FocusedContentProps {
  store: AppStore;
}

/**
 * Renders exactly one menu item's content instead of the whole document.
 *
 * The default view mounts every operation at once, so opening a large spec
 * builds and retains the models and payload samples for the entire API before
 * the reader has looked at any of it. Here the menu selection is the only thing
 * on screen, so that work happens per section and is released when you navigate
 * away.
 *
 * Descendants are deliberately not rendered: selecting a tag whose 200
 * operations then all mount would put the original problem straight back. A tag
 * instead gets its description plus an index of links to its children.
 */
export const FocusedContent = observer(({ store }: FocusedContentProps) => {
  const item = store.menu.activeItem;

  // Nothing selected -- the landing state, and where a deep link that matched
  // no menu item ends up.
  if (!item) {
    return <ApiInfo store={store} />;
  }

  return (
    <>
      <ContentItem item={item as any} renderChildren={false} />
      <ChildIndex item={item} />
    </>
  );
});

/**
 * A compact list of links to an item's children, so that selecting a tag lands
 * on something navigable rather than a bare heading. Rendering links costs
 * nothing: it reads `sidebarLabel` and `id`, never the schemas.
 */
const ChildIndex = observer(({ item }: { item: IMenuItem }) => {
  const children = item.items;
  if (!children || children.length === 0) {
    return null;
  }

  return (
    <Row>
      <MiddlePanel>
        <IndexList>
          {children.map(child => (
            <li key={child.id}>
              <Link to={child.id}>
                {child instanceof OperationModel && child.httpVerb && (
                  <IndexVerb $verb={child.httpVerb.toLowerCase()}>
                    {shortenHTTPVerb(child.httpVerb)}
                  </IndexVerb>
                )}
                <span>{child.sidebarLabel}</span>
              </Link>
            </li>
          ))}
        </IndexList>
      </MiddlePanel>
    </Row>
  );
});

const IndexList = styled.ul`
  list-style: none;
  margin: 0 0 ${({ theme }) => theme.spacing.unit * 4}px;
  padding: 0;

  li {
    margin: 0;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border.dark};
  }

  li:last-child {
    border-bottom: none;
  }

  a {
    display: flex;
    align-items: center;
    gap: ${({ theme }) => theme.spacing.unit}px;
    padding: ${({ theme }) => theme.spacing.unit}px 0;
    color: ${({ theme }) => theme.colors.text.primary};
    text-decoration: none;
  }

  a:hover {
    color: ${({ theme }) => theme.colors.primary.main};
  }
`;

const IndexVerb = styled.span<{ $verb: string }>`
  flex-shrink: 0;
  min-width: 32px;
  text-align: center;
  font-family: ${({ theme }) => theme.typography.code.fontFamily};
  font-size: ${({ theme }) => theme.typography.code.fontSize};
  text-transform: uppercase;
  padding: 2px 4px;
  border-radius: 2px;
  color: #ffffff;
  background-color: ${({ theme, $verb }) =>
    theme.colors.http[$verb] || theme.colors.text.secondary};
`;
