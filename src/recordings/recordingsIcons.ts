/**
 * @file recordings/recordingsIcons.ts
 *
 * The recordings page's inline SVGs. Built rather than pasted as markup so a
 * path never reaches `innerHTML`, and so every icon shares one `viewBox` and
 * `aria-hidden` treatment.
 */

export function svg(viewBox: string, className: string, paths: Array<{ d: string; attrs?: Record<string, string> }>): SVGSVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', viewBox);
  element.setAttribute('fill', 'none');
  element.setAttribute('aria-hidden', 'true');
  if (className) element.setAttribute('class', className);
  for (const { d, attrs = {} } of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    for (const [name, value] of Object.entries(attrs)) path.setAttribute(name, value);
    element.appendChild(path);
  }
  return element;
}

export function checkIcon(): SVGSVGElement {
  return svg('0 0 16 16', '', [{
    d: 'M3.5 8.5l3 3 6-7',
    attrs: { stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  }]);
}

export function cloudIcon(): SVGSVGElement {
  const icon = svg('0 0 16 16', 'destination-icon', [{
    d: 'M4.5 13a3 3 0 01-.3-5.99A4 4 0 0112 6.5a2.75 2.75 0 01-.25 5.5H4.5z',
    attrs: { fill: 'currentColor' },
  }]);
  return icon;
}

export function diskIcon(): SVGSVGElement {
  return svg('0 0 16 16', 'destination-icon destination-icon--local', [
    { d: 'M2.5 3.5h11v9h-11z', attrs: { stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' } },
    { d: 'M2.5 6.5h11', attrs: { stroke: 'currentColor', 'stroke-width': '1.4' } },
  ]);
}

export function editIcon(): SVGSVGElement {
  return svg('0 0 16 16', 'detail-title__icon', [{
    d: 'M11.5 2.1l2.4 2.4-8.8 8.8-3 .6.6-3 8.8-8.8z',
    attrs: { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  }]);
}
