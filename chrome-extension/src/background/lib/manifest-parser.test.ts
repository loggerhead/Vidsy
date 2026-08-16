import { parseDashVariants } from './manifest-parser';
import assert from 'node:assert/strict';
import test from 'node:test';

test('parseDashVariants resolves representation URLs from an AdaptationSet BaseURL', async () => {
  type Node = {
    attributes: Record<string, string>;
    textContent?: string;
    parent?: Node;
    children: Node[];
  };
  const node = (attributes: Record<string, string> = {}, textContent?: string): Node => ({
    attributes,
    textContent,
    children: [],
  });
  const find = (root: Node, name: string): Node[] =>
    root.children.flatMap(child => [child, ...find(child, name)]).filter(child => child.attributes.__name === name);
  const base = node({ __name: 'BaseURL' }, 'video/');
  const adaptation = node({ __name: 'AdaptationSet', mimeType: 'video/mp4' });
  const representations = [
    node({ __name: 'Representation', id: 'v1080', bandwidth: '4000000', width: '1920', height: '1080' }),
    node({ __name: 'Representation', id: 'v720', bandwidth: '2000000', width: '1280', height: '720' }),
  ];
  adaptation.children = [base, ...representations];
  const period = node({ __name: 'Period' });
  period.children = [adaptation];
  const mpd = node({ __name: 'MPD' });
  mpd.children = [period];
  const asElement = (value: Node): Element =>
    ({
      textContent: value.textContent ?? null,
      getAttribute: (name: string) => value.attributes[name] ?? null,
      querySelector: (selector: string) => {
        const name = selector.replace(' > ', '');
        return (find(value, name)[0] ?? null) as unknown as Element;
      },
      querySelectorAll: (selector: string) => find(value, selector) as unknown as Element[],
      closest: (selector: string) => {
        let current: Node | undefined = value;
        while (current) {
          if (current.attributes.__name === selector) return asElement(current);
          current = current.parent;
        }
        return null;
      },
    }) as unknown as Element;
  const connect = (parent: Node) =>
    parent.children.forEach(child => {
      child.parent = parent;
      connect(child);
    });
  connect(mpd);

  const result = await parseDashVariants('https://cdn.example/media/manifest.mpd', {
    fetchImpl: async () => new Response('<MPD/>', { status: 200 }),
    parseDocument: () =>
      ({
        querySelectorAll: (selector: string) => find(mpd, selector).map(asElement) as unknown as NodeListOf<Element>,
        querySelector: (selector: string) => asElement(mpd).querySelector(selector),
      }) as unknown as Document,
  });

  assert.deepEqual(
    result.variants.map(variant => variant.resolution),
    [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ],
  );
});
