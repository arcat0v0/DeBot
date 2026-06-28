export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      const replacement = ENTITIES[body];
      return replacement ?? match;
    },
  );
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4] ?? "";
    attributes[key] = decodeEntities(value);
  }
  return attributes;
}

export function parseXml(input: string): XmlElement {
  const root: XmlElement = {
    name: "#root",
    attributes: {},
    children: [],
    text: "",
  };
  const stack: XmlElement[] = [root];
  let index = 0;
  const length = input.length;

  while (index < length) {
    const lt = input.indexOf("<", index);
    if (lt === -1) {
      break;
    }
    if (lt > index) {
      const text = decodeEntities(input.slice(index, lt));
      if (text.trim().length > 0) {
        stack[stack.length - 1].text += text.trim();
      }
    }

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const data = input.slice(lt + 9, end === -1 ? length : end);
      stack[stack.length - 1].text += data;
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (input.startsWith("<?", lt) || input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt);
      index = end === -1 ? length : end + 1;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) break;
    const tagContent = input.slice(lt + 1, gt);
    index = gt + 1;

    if (tagContent.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = tagContent.endsWith("/");
    const normalized = selfClosing
      ? tagContent.slice(0, -1).trim()
      : tagContent.trim();
    const spaceIndex = normalized.search(/\s/);
    const name = spaceIndex === -1
      ? normalized
      : normalized.slice(0, spaceIndex);
    const attrRaw = spaceIndex === -1 ? "" : normalized.slice(spaceIndex + 1);

    const element: XmlElement = {
      name,
      attributes: parseAttributes(attrRaw),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }

  return root;
}

export function firstChild(
  element: XmlElement | undefined,
  name: string,
): XmlElement | undefined {
  return element?.children.find((child) => child.name === name);
}

export function childElements(
  element: XmlElement | undefined,
  name: string,
): XmlElement[] {
  if (!element) return [];
  return element.children.filter((child) => child.name === name);
}

export function childText(
  element: XmlElement | undefined,
  name: string,
): string | undefined {
  const child = firstChild(element, name);
  if (!child) return undefined;
  return child.text;
}

export function findElement(
  element: XmlElement | undefined,
  name: string,
): XmlElement | undefined {
  if (!element) return undefined;
  for (const child of element.children) {
    if (child.name === name) return child;
    const nested = findElement(child, name);
    if (nested) return nested;
  }
  return undefined;
}

export function pathText(
  element: XmlElement | undefined,
  path: string[],
): string | undefined {
  let current = element;
  for (const segment of path) {
    current = firstChild(current, segment);
    if (!current) return undefined;
  }
  return current?.text;
}
