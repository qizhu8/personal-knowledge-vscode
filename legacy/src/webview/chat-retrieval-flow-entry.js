import { sankey, sankeyLinkHorizontal } from "d3-sankey";

const colors = { memory: '#52bb80', skill: '#5ba5e0', note: '#d5ad58', script: '#55bcb3', recipe: '#b889bd', research: '#dd8278', api: '#99b765', function: '#db98af' };

globalThis.PkmRetrievalFlow = (container, receipt, topK = 10, kind = 'all', inspect = () => {}) => {
  container.replaceChildren();
  if (!receipt) return;
  const candidates = receipt.candidates.filter(candidate => kind === 'all' || candidate.kind === kind).slice(0, topK === 20 ? 20 : 10);
  const width = Math.max(180, container.clientWidth);
  const sourceX = Math.min(174, width * 0.42);
  const targetX = width - Math.min(136, width * 0.28);
  const height = Math.max(160, candidates.length * 34 + 28);
  const maximum = new Map();
  for (const candidate of receipt.candidates.filter(candidate => candidate.selected)) maximum.set(candidate.method, Math.max(maximum.get(candidate.method) || 0, Math.max(0, candidate.score)));
  const nodes = candidates.map((candidate, index) => ({ id: `candidate-${index}`, candidate, fixedValue: 5 }));
  const links = candidates.flatMap((candidate, index) => candidate.selected ? [{ source: `candidate-${index}`, target: 'model', candidate,
    value: 0.5 + 3 * Math.max(0, candidate.score) / (maximum.get(candidate.method) || 1) }] : []);
  nodes.push({ id: 'model', fixedValue: Math.max(5, links.reduce((sum, link) => sum + link.value, 0)) });
  let graph;
  if (links.length) graph = sankey().nodeId(node => node.id).nodeAlign(node => node.id === 'model' ? 1 : 0).nodeSort(null)
    .nodeWidth(10).nodePadding(12).extent([[sourceX, 12], [targetX, height - 12]])({ nodes, links });
  else graph = { nodes: nodes.map((node, index) => ({ ...node, x0: node.id === 'model' ? targetX - 10 : sourceX, x1: node.id === 'model' ? targetX : sourceX + 10,
    y0: node.id === 'model' ? height / 2 - 24 : index * 34 + 12, y1: node.id === 'model' ? height / 2 + 24 : index * 34 + 32 })), links: [] };
  const element = (name, attributes = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const title = (node, text) => { const label = element('title'); label.textContent = text; node.append(label); };
  const svg = element('svg', { width, height, role: 'img', 'aria-label': `Retrieval candidates to model ${receipt.model}` });
  for (const link of graph.links) {
    const flow = element('path', { d: sankeyLinkHorizontal()(link), fill: 'none', stroke: colors[link.candidate.kind] || '#a1a1a1', 'stroke-width': Math.max(1, link.width), opacity: 0.55,
      'data-retrieval-link': link.candidate.id, 'data-score': link.candidate.score });
    title(flow, `${link.candidate.method}\nScore: ${link.candidate.score}\n${link.candidate.reason}\nLine width normalized within this scoring method; not a probability.`); svg.append(flow);
  }
  for (const node of graph.nodes) {
    const candidate = node.candidate;
    const group = element('g', { 'data-retrieval-node': candidate?.id || 'model', tabindex: 0, role: candidate ? 'button' : 'img',
      'aria-label': candidate ? `${candidate.kind}: ${candidate.label}; ${candidate.selected ? 'Selected' : 'Not selected'}; score ${candidate.score}` : `Model: ${receipt.model}` });
    group.append(element('rect', { x: node.x0, y: node.y0, width: node.x1 - node.x0, height: Math.max(2, node.y1 - node.y0), fill: candidate ? colors[candidate.kind] || '#a1a1a1' : '#9da3a8', opacity: candidate && !candidate.selected ? 0.4 : 1 }));
    const label = element('text', { x: candidate ? 6 : node.x1 + 8, y: (node.y0 + node.y1) / 2, 'dominant-baseline': 'middle', fill: 'currentColor', 'font-size': 12 });
    const text = candidate ? `${candidate.kind}: ${candidate.label}` : receipt.model;
    const limit = Math.max(5, Math.floor((candidate ? sourceX - 12 : width - targetX - 12) / 7));
    label.textContent = text.length > limit ? text.slice(0, limit - 3) + '...' : text;
    group.append(label); title(group, candidate ? `${candidate.label}\n${candidate.sourceUri}\n${candidate.method}: ${candidate.score}\n${candidate.reason}` : `${receipt.sessionId || receipt.chatId}\n${receipt.model}`);
    if (candidate) { group.addEventListener('click', () => inspect(candidate)); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(candidate); } }); }
    svg.append(group);
  }
  container.append(svg);
};