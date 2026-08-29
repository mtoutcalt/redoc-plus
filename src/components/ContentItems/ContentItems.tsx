import { observer } from 'mobx-react';
import * as React from 'react';

import { ExternalDocumentation } from '../ExternalDocumentation/ExternalDocumentation';
import { AdvancedMarkdown } from '../Markdown/AdvancedMarkdown';
import { H2, H3, MiddlePanel, Row, Section, ShareLink } from '../../common-elements';
import type { ContentItemModel } from '../../services';
import type { GroupModel, OperationModel } from '../../services/models';
import { Operation } from '../Operation/Operation';

@observer
export class ContentItems extends React.Component<{
  items: ContentItemModel[];
}> {
  render() {
    const items = this.props.items;
    if (items.length === 0) {
      return null;
    }
    return items.map(item => {
      return <ContentItem key={item.id} item={item} />;
    });
  }
}

export interface ContentItemProps {
  item: ContentItemModel;
  /**
   * Whether to also render this item's descendants. Focus mode renders a single
   * item at a time and passes false; the default document view renders the whole
   * tree and leaves it true.
   */
  renderChildren?: boolean;
}

@observer
export class ContentItem extends React.Component<ContentItemProps> {
  render() {
    const { item, renderChildren = true } = this.props;
    let content;
    const { type } = item;
    switch (type) {
      case 'group':
        content = null;
        break;
      case 'tag':
      case 'section':
        content = <SectionItem {...this.props} />;
        break;
      case 'operation':
        content = <OperationItem item={item as any} />;
        break;
      default:
        content = <SectionItem {...this.props} />;
    }

    return (
      <>
        {content && (
          <Section id={item.id} $underlined={item.type === 'operation'}>
            {content}
          </Section>
        )}
        {renderChildren && item.items && <ContentItems items={item.items} />}
      </>
    );
  }
}

const middlePanelWrap = component => <MiddlePanel $compact={true}>{component}</MiddlePanel>;

@observer
export class SectionItem extends React.Component<ContentItemProps> {
  render() {
    const { name, description, externalDocs, level } = this.props.item as GroupModel;

    const Header = level === 2 ? H3 : H2;
    return (
      <>
        <Row>
          <MiddlePanel $compact={false}>
            <Header>
              <ShareLink to={this.props.item.id} />
              {name}
            </Header>
          </MiddlePanel>
        </Row>
        <AdvancedMarkdown
          parentId={this.props.item.id}
          source={description || ''}
          htmlWrap={middlePanelWrap}
        />
        {externalDocs && (
          <Row>
            <MiddlePanel>
              <ExternalDocumentation externalDocs={externalDocs} />
            </MiddlePanel>
          </Row>
        )}
      </>
    );
  }
}

@observer
export class OperationItem extends React.Component<{
  item: OperationModel;
}> {
  render() {
    return <Operation operation={this.props.item} />;
  }
}
