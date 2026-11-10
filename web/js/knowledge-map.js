/**
 * 轻量 SVG 树状思维导图渲染器。
 * 只依赖浏览器原生 SVG / Pointer Events，不引入第三方库。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_FONT =
  '600 12.5px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif';
const ROOT_FONT =
  '680 15px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif';
const BADGE_FONT =
  '600 9.5px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const NODE_MIN_WIDTH = 116;
const NODE_MAX_WIDTH = 188;
const NODE_PAD_X = 14;
const NODE_LINE_HEIGHT = 16;
const NODE_HEIGHT_ONE = 38;
const NODE_HEIGHT_TWO = 54;
const ROOT_MIN_WIDTH = 210;
const ROOT_MAX_WIDTH = 258;
const ROOT_LINE_HEIGHT = 19;
const H_GAP = 54;
const V_GAP = 12;
const MAX_DEPTH = 12;

let measureContext = null;

function measureText(text, font) {
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  measureContext.font = font;
  return measureContext.measureText(String(text || '')).width;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function wrapText(text, maxWidth, font, maxLines) {
  const chars = Array.from(String(text || '').trim());
  if (!chars.length) return ['未命名'];
  const lines = [];
  let current = '';
  let consumed = 0;
  for (const char of chars) {
    const next = current + char;
    if (current && measureText(next, font) > maxWidth) {
      lines.push(current);
      consumed += current.length;
      current = char;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
    consumed += current.length;
  }
  if (!lines.length) lines.push('未命名');
  if (consumed < chars.length) {
    let last = lines[lines.length - 1] || '';
    while (last && measureText(`${last}…`, font) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function sizeNode(node, isRoot) {
  if (isRoot) {
    const lines = wrapText(node.label, ROOT_MAX_WIDTH - 32, ROOT_FONT, 2);
    const lineWidth = Math.max(...lines.map((line) => measureText(line, ROOT_FONT)));
    node.lines = lines;
    node.width = clamp(lineWidth + 36, ROOT_MIN_WIDTH, ROOT_MAX_WIDTH);
    node.height = (lines.length > 1 ? 30 : 22) + ROOT_LINE_HEIGHT * lines.length + 30;
    return;
  }
  const lines = wrapText(node.label, NODE_MAX_WIDTH - NODE_PAD_X * 2 - 18, NODE_FONT, 2);
  const lineWidth = Math.max(...lines.map((line) => measureText(line, NODE_FONT)));
  node.lines = lines;
  node.width = clamp(lineWidth + NODE_PAD_X * 2 + 18, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
  node.height = lines.length > 1 ? NODE_HEIGHT_TWO : NODE_HEIGHT_ONE;
}

/**
 * @param {HTMLElement} host
 * @param {{ onSelect?: (node: object) => void }} options
 */
export function createMindMap(host, options = {}) {
  if (!host) throw new Error('缺少思维导图容器。');

  const collapsed = new Set();
  const nodeById = new Map();
  const parentById = new Map();
  const transform = { x: 0, y: 0, scale: 1 };
  const abort = new AbortController();
  const signal = abort.signal;

  let rootNode = null;
  let selectedId = '';
  let matches = new Set();
  let drag = null;
  let suppressClick = false;
  let destroyed = false;
  let userAdjusted = false;
  let fitPending = false;
  let resizeObserver = null;
  let lastWidth = 0;
  let lastHeight = 0;

  const svg = el('svg', {
    class: 'kg-svg',
    role: 'application',
    'aria-label': '知识图谱思维导图',
  });
  const viewport = el('g', { class: 'kg-viewport' });
  svg.appendChild(viewport);
  host.replaceChildren(svg);

  function kids(node) {
    return node && !node.collapsed ? node.children || [] : [];
  }

  function prepare(node) {
    if (!node) return;
    sizeNode(node, node.kind === 'root');
    node.collapsed = collapsed.has(node.id);
    for (const child of node.children || []) prepare(child);
  }

  function measureSubtree(node, depth = 0) {
    const children = kids(node);
    if (!children.length || depth > MAX_DEPTH) {
      node.subtreeHeight = node.height;
      return node.subtreeHeight;
    }
    let total = 0;
    for (const child of children) {
      total += measureSubtree(child, depth + 1) + V_GAP;
    }
    total -= V_GAP;
    node.subtreeHeight = Math.max(node.height, total);
    return node.subtreeHeight;
  }

  function placeVertical(node, top, depth = 0) {
    const children = kids(node);
    if (!children.length || depth > MAX_DEPTH) {
      node.y = top + node.height / 2;
      return node.height;
    }
    let childrenHeight = 0;
    for (const child of children) childrenHeight += child.subtreeHeight + V_GAP;
    childrenHeight -= V_GAP;
    const total = Math.max(node.height, childrenHeight);
    let cursor = top + (total - childrenHeight) / 2;
    for (const child of children) {
      placeVertical(child, cursor, depth + 1);
      cursor += child.subtreeHeight + V_GAP;
    }
    node.y = (children[0].y + children[children.length - 1].y) / 2;
    return total;
  }

  function placeHorizontal(node, x, direction, depth = 0) {
    node.x = x;
    node.dir = direction;
    if (depth > MAX_DEPTH) return;
    for (const child of kids(node)) {
      const childX = x + direction * (node.width / 2 + H_GAP + child.width / 2);
      placeHorizontal(child, childX, direction, depth + 1);
    }
  }

  function layout() {
    prepare(rootNode);
    const children = kids(rootNode);
    if (!children.length) {
      rootNode.x = 0;
      rootNode.y = 0;
      rootNode.dir = 1;
      rootNode.subtreeHeight = rootNode.height;
      return;
    }
    for (const child of children) measureSubtree(child);
    const right = [];
    const left = [];
    let rightHeight = 0;
    let leftHeight = 0;
    for (const child of children) {
      if (rightHeight <= leftHeight) {
        right.push(child);
        rightHeight += child.subtreeHeight + V_GAP;
      } else {
        left.push(child);
        leftHeight += child.subtreeHeight + V_GAP;
      }
    }
    function placeSide(list, direction) {
      if (!list.length) return;
      const total =
        list.reduce((sum, child) => sum + child.subtreeHeight, 0) + V_GAP * (list.length - 1);
      let cursor = -total / 2;
      for (const child of list) {
        placeVertical(child, cursor);
        const childX = direction * (rootNode.width / 2 + H_GAP + child.width / 2);
        placeHorizontal(child, childX, direction);
        cursor += child.subtreeHeight + V_GAP;
      }
    }
    placeSide(right, 1);
    placeSide(left, -1);
    rootNode.x = 0;
    rootNode.y = 0;
    rootNode.dir = 1;
  }

  function computeBBox() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    function visit(node, depth = 0) {
      if (!node || depth > MAX_DEPTH) return;
      minX = Math.min(minX, node.x - node.width / 2 - 18);
      maxX = Math.max(maxX, node.x + node.width / 2 + 18);
      minY = Math.min(minY, node.y - node.height / 2 - 18);
      maxY = Math.max(maxY, node.y + node.height / 2 + 18);
      for (const child of kids(node)) visit(child, depth + 1);
    }
    visit(rootNode);
    if (!Number.isFinite(minX)) {
      return { minX: -100, minY: -100, maxX: 100, maxY: 100, width: 200, height: 200 };
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function drawEdges(node, depth = 0) {
    if (!node || depth > MAX_DEPTH) return;
    for (const child of kids(node)) {
      const direction = child.x >= node.x ? 1 : -1;
      const startX = node.x + direction * (node.width / 2);
      const endX = child.x - direction * (child.width / 2);
      const bend = Math.max(26, Math.abs(endX - startX) * 0.45);
      viewport.appendChild(
        el('path', {
          class: `kg-edge tone-${child.tone || 'none'}`,
          d: `M ${startX} ${node.y} C ${startX + direction * bend} ${node.y}, ${
            endX - direction * bend
          } ${child.y}, ${endX} ${child.y}`,
        }),
      );
      drawEdges(child, depth + 1);
    }
  }

  function drawNode(node, depth = 0) {
    if (!node || depth > MAX_DEPTH) return;
    const isRoot = node.kind === 'root';
    const group = el('g', {
      class: `kg-node ${isRoot ? 'is-root' : ''} tone-${node.tone || 'none'}${
        node.id === selectedId ? ' is-selected' : ''
      }`,
      'data-node-id': node.id,
      transform: `translate(${node.x - node.width / 2} ${node.y - node.height / 2})`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${node.label || '节点'}${
        node.questionCount ? `，${node.questionCount} 道题` : ''
      }`,
    });
    group.appendChild(
      el('rect', {
        class: 'kg-node-box',
        width: node.width,
        height: node.height,
        rx: isRoot ? 16 : 12,
      }),
    );

    if (isRoot) {
      const lines = node.lines || [node.label];
      const startY = lines.length > 1 ? 26 : 28;
      lines.forEach((line, index) => {
        const text = el('text', {
          x: node.width / 2,
          y: startY + index * ROOT_LINE_HEIGHT,
          'text-anchor': 'middle',
          class: 'kg-root-label',
        });
        text.textContent = line;
        group.appendChild(text);
      });
      const subtitle = el('text', {
        x: node.width / 2,
        y: node.height - 16,
        'text-anchor': 'middle',
        class: 'kg-root-sub',
      });
      subtitle.textContent = node.rootSubtitle || '';
      group.appendChild(subtitle);
    } else {
      const lines = node.lines || [node.label];
      const startY = node.height / 2 - ((lines.length - 1) * NODE_LINE_HEIGHT) / 2 + 4.5;
      lines.forEach((line, index) => {
        const text = el('text', {
          x: node.width / 2,
          y: startY + index * NODE_LINE_HEIGHT,
          'text-anchor': 'middle',
          class: 'kg-node-label',
        });
        text.textContent = line;
        group.appendChild(text);
      });
    }

    if (!isRoot && node.questionCount > 0) {
      const label = String(node.questionCount);
      const badgeWidth = Math.max(18, measureText(label, BADGE_FONT) + 10);
      const badge = el('g', {
        class: 'kg-node-badge',
        transform: `translate(${node.width - badgeWidth / 2 - 4} -6)`,
        'pointer-events': 'none',
      });
      badge.appendChild(
        el('rect', {
          x: -badgeWidth / 2,
          y: 0,
          width: badgeWidth,
          height: 16,
          rx: 8,
          class: 'kg-badge-box',
        }),
      );
      const badgeText = el('text', {
        x: 0,
        y: 11.5,
        'text-anchor': 'middle',
        class: 'kg-badge-text',
      });
      badgeText.textContent = label;
      badge.appendChild(badgeText);
      group.appendChild(badge);
    }

    if (!isRoot && (node.children || []).length) {
      const direction = node.dir || (node.x >= 0 ? 1 : -1);
      const cx = direction > 0 ? node.width + 9 : -9;
      const cy = node.height / 2;
      const toggle = el('g', {
        class: 'kg-toggle',
        'data-toggle-id': node.id,
        transform: `translate(${cx} ${cy})`,
        role: 'button',
        'aria-label': node.collapsed ? '展开子节点' : '收起子节点',
      });
      toggle.appendChild(el('circle', { r: 8, class: 'kg-toggle-circle' }));
      const toggleText = el('text', {
        x: 0,
        y: 3.5,
        'text-anchor': 'middle',
        class: 'kg-toggle-text',
      });
      toggleText.textContent = node.collapsed ? '+' : '−';
      toggle.appendChild(toggleText);
      group.appendChild(toggle);
    }

    viewport.appendChild(group);
    for (const child of kids(node)) drawNode(child, depth + 1);
  }

  function applyTransform() {
    viewport.setAttribute(
      'transform',
      `translate(${transform.x} ${transform.y}) scale(${transform.scale})`,
    );
  }

  function applyMatches() {
    viewport.querySelectorAll('.kg-node').forEach((node) => {
      node.classList.toggle('is-match', matches.has(node.dataset.nodeId));
    });
  }

  function indexTree(node, parent = null, depth = 0) {
    if (!node || depth > MAX_DEPTH) return;
    nodeById.set(node.id, node);
    parentById.set(node.id, parent);
    for (const child of node.children || []) indexTree(child, node, depth + 1);
  }

  function visibleNodes() {
    const result = [];
    function visit(node, depth = 0) {
      if (!node || depth > MAX_DEPTH) return;
      result.push(node);
      for (const child of kids(node)) visit(child, depth + 1);
    }
    visit(rootNode);
    return result;
  }

  function isVisible(node) {
    let parent = parentById.get(node.id);
    while (parent) {
      if (collapsed.has(parent.id)) return false;
      parent = parentById.get(parent.id);
    }
    return true;
  }

  function applySelection() {
    viewport.querySelectorAll('.kg-node').forEach((node) => {
      node.classList.toggle('is-selected', node.dataset.nodeId === selectedId);
    });
  }

  function select(nodeId, notify = true) {
    const node = nodeById.get(nodeId);
    if (!node) return;
    selectedId = nodeId;
    applySelection();
    if (notify) options.onSelect?.(node);
  }

  function renderTree({ fit: shouldFit = false } = {}) {
    if (!rootNode) return;
    layout();
    viewport.replaceChildren();
    drawEdges(rootNode);
    drawNode(rootNode);
    applyTransform();
    applyMatches();
    applySelection();
    if (shouldFit) {
      fit();
      fitPending = true;
      requestAnimationFrame(() => {
        if (!destroyed) fit();
      });
    }
  }

  function fit() {
    if (!rootNode) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const box = computeBBox();
    const padding = 40;
    const scale = clamp(
      Math.min(
        (rect.width - padding * 2) / Math.max(box.width, 1),
        (rect.height - padding * 2) / Math.max(box.height, 1),
      ),
      0.2,
      1.35,
    );
    transform.scale = scale;
    transform.x = rect.width / 2 - ((box.minX + box.maxX) / 2) * scale;
    transform.y = rect.height / 2 - ((box.minY + box.maxY) / 2) * scale;
    userAdjusted = false;
    fitPending = false;
    applyTransform();
  }

  function centerOn(node) {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    transform.x = rect.width / 2 - node.x * transform.scale;
    transform.y = rect.height / 2 - node.y * transform.scale;
    userAdjusted = true;
    applyTransform();
  }

  function zoomAt(px, py, factor) {
    const next = clamp(transform.scale * factor, 0.2, 2.4);
    if (next === transform.scale) return;
    const worldX = (px - transform.x) / transform.scale;
    const worldY = (py - transform.y) / transform.scale;
    transform.scale = next;
    transform.x = px - worldX * next;
    transform.y = py - worldY * next;
    userAdjusted = true;
    applyTransform();
  }

  function zoomBy(factor) {
    const rect = host.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function toggleCollapse(nodeId) {
    const node = nodeById.get(nodeId);
    if (!node || !(node.children || []).length) return;
    if (collapsed.has(nodeId)) collapsed.delete(nodeId);
    else collapsed.add(nodeId);
    renderTree();
  }

  function search(query) {
    const text = String(query || '').trim().toLowerCase();
    matches = new Set();
    if (!text) {
      applyMatches();
      return;
    }
    let first = null;
    for (const node of nodeById.values()) {
      const haystack = [node.label, node.summary, ...(node.keywords || [])]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(text)) {
        matches.add(node.id);
        if (!first) first = node;
      }
    }
    let changed = false;
    for (const nodeId of matches) {
      let parent = parentById.get(nodeId);
      while (parent) {
        if (collapsed.has(parent.id)) {
          collapsed.delete(parent.id);
          changed = true;
        }
        parent = parentById.get(parent.id);
      }
    }
    if (changed) renderTree();
    applyMatches();
    if (first && isVisible(first)) centerOn(first);
  }

  svg.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      suppressClick = false;
      if (event.target.closest?.('[data-toggle-id]')) return;
      host.focus({ preventScroll: true });
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: transform.x,
        originY: transform.y,
        moved: false,
      };
      svg.classList.add('is-panning');
    },
    { signal },
  );

  svg.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        svg.setPointerCapture?.(event.pointerId);
      }
      if (!drag.moved) return;
      transform.x = drag.originX + dx;
      transform.y = drag.originY + dy;
      userAdjusted = true;
      applyTransform();
    },
    { signal },
  );

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasMoved = drag.moved;
    drag = null;
    suppressClick = wasMoved;
    svg.classList.remove('is-panning');
    if (wasMoved) return;
    const nodeElement = event.target.closest?.('[data-node-id]');
    if (nodeElement) select(nodeElement.dataset.nodeId);
  }

  svg.addEventListener('pointerup', endDrag, { signal });
  svg.addEventListener(
    'pointercancel',
    () => {
      drag = null;
      suppressClick = false;
      svg.classList.remove('is-panning');
    },
    { signal },
  );

  svg.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const toggle = event.target.closest?.('[data-toggle-id]');
      if (!toggle) return;
      event.preventDefault();
      event.stopPropagation();
      toggleCollapse(toggle.dataset.toggleId);
    },
    { signal },
  );

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * 0.0015),
      );
    },
    { passive: false, signal },
  );

  host.setAttribute('tabindex', '0');
  host.addEventListener(
    'keydown',
    (event) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.15);
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        zoomBy(1 / 1.15);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        fit();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const nodes = visibleNodes();
        if (!nodes.length) return;
        let index = nodes.findIndex((node) => node.id === selectedId);
        if (index < 0) index = 0;
        const nextIndex =
          event.key === 'ArrowDown'
            ? Math.min(nodes.length - 1, index + 1)
            : Math.max(0, index - 1);
        const next = nodes[nextIndex];
        select(next.id);
        centerOn(next);
        return;
      }
      if (event.key === 'ArrowRight') {
        const node = nodeById.get(selectedId);
        const child = node && kids(node)[0];
        if (child) {
          event.preventDefault();
          select(child.id);
          centerOn(child);
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        const parent = parentById.get(selectedId);
        if (parent) {
          event.preventDefault();
          select(parent.id);
          centerOn(parent);
        }
      }
    },
    { signal },
  );

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      if (Math.abs(width - lastWidth) < 2 && Math.abs(height - lastHeight) < 2) return;
      lastWidth = width;
      lastHeight = height;
      if (!userAdjusted || fitPending) fit();
    });
    resizeObserver.observe(host);
  }

  return {
    render(nextRoot) {
      rootNode = nextRoot;
      nodeById.clear();
      parentById.clear();
      matches = new Set();
      if (rootNode) {
        indexTree(rootNode);
        if (!nodeById.has(selectedId)) selectedId = rootNode.id;
      }
      renderTree({ fit: true });
    },
    select,
    fit,
    zoomIn() {
      zoomBy(1.18);
    },
    zoomOut() {
      zoomBy(1 / 1.18);
    },
    search,
    getSelectedId() {
      return selectedId;
    },
    destroy() {
      destroyed = true;
      abort.abort();
      resizeObserver?.disconnect();
      host.replaceChildren();
    },
  };
}
