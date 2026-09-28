// Shared Recipe graph vocabulary and pure layout helpers. This file is also
// embedded in the standalone Browser editor.
const RecipeGraph = Object.freeze({
  terms:Object.freeze({
    recipe:'Recipe',
    module:'Module',
    modules:'Modules',
    connection:'Connection',
    connections:'Connections',
    input:'Input',
    output:'Output',
    repeat:'Repeat group',
    loop:'Loop connection'
  }),
  moduleTemplates:Object.freeze({
    single:{ label:'Module', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['input'], outputs:['output'] }, control:{ mode:'single' } },
    repeat:{ label:'Repeat', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['items'], outputs:['result'] }, control:{ mode:'repeat', count:{ kind:'fixed', value:2 } } },
    if:{ label:'If / Else', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['condition'], outputs:['yes','no'] }, control:{ mode:'branch', kind:'if', cases:['yes','no'] } },
    switch:{ label:'Switch', kind:'pkm.step.noop/v1', config:{}, ports:{ inputs:['value'], outputs:['case1','default'] }, control:{ mode:'branch', kind:'switch', cases:['case1','default'] } },
    command:{ label:'Background command', kind:'pkm.step.command/v1', config:{ program:'python3', args:[], timeoutSeconds:300, maxOutputBytes:65536 }, ports:{ inputs:['parameters'], outputs:['result'] }, control:{ mode:'single' } },
    script:{ label:'Executable script', kind:'pkm.step.script/v1', config:{ runtime:'bash', script:'set -e\n', timeoutSeconds:300, maxOutputBytes:65536 }, ports:{ inputs:['parameters'], outputs:['result'] }, control:{ mode:'single' } },
    human:{ label:'Required user input', kind:'pkm.gate.human/v1', config:{ prompt:'Do you approve continuing?', inputKind:'approval' }, ports:{ inputs:['request'], outputs:['approved','rejected'] }, control:{ mode:'single' } }
  }),
  presentation(node) {
    if (node?.control?.mode === 'branch') return { key:'branch', label:node.control.kind === 'switch' ? 'Switch' : 'If / Else', icon:'⇆' };
    if (node?.kind === 'pkm.step.command/v1') return { key:'command', label:'Background command', icon:'›_' };
    if (node?.kind === 'pkm.step.script/v1') return { key:'script', label:'Executable script', icon:'</>' };
    if (node?.kind === 'pkm.gate.human/v1') return { key:'human', label:'Required user input', icon:'?' };
    return { key:'step', label:'Module', icon:'◆' };
  },
  repeatBadge(control) {
    if (control?.mode !== 'repeat') return '';
    return control.count?.kind === 'dynamic' ? 'xK' : `x${Math.max(1, Number(control.count?.value) || 1)}`;
  },
  topology(nodes, excludedNodeIds = []) {
    const excluded = excludedNodeIds instanceof Set ? excludedNodeIds : new Set(excludedNodeIds || []);
    const incoming = new Set(), outgoing = new Set();
    for (const node of nodes || []) for (const dependency of node.dependsOn || []) {
      if (dependency.loop) continue;
      incoming.add(node.nodeId);
      outgoing.add(dependency.from);
    }
    return {
      roots:(nodes || []).filter(node => !excluded.has(node.nodeId) && !incoming.has(node.nodeId)),
      terminals:(nodes || []).filter(node => !excluded.has(node.nodeId) && !outgoing.has(node.nodeId))
    };
  },
  unconnectedNodeIds(nodes, candidateNodeIds) {
    const candidates = candidateNodeIds instanceof Set ? candidateNodeIds : new Set(candidateNodeIds || []);
    const connected = new Set();
    for (const node of nodes || []) for (const dependency of node.dependsOn || []) {
      connected.add(node.nodeId);
      connected.add(dependency.from);
    }
    return new Set((nodes || []).filter(node => candidates.has(node.nodeId) && !connected.has(node.nodeId)).map(node => node.nodeId));
  },
  cyclePath(nodes, sourceId, targetId) {
    if (sourceId === targetId) return [sourceId, targetId];
    const outgoing = new Map((nodes || []).map(node => [node.nodeId, []]));
    for (const node of nodes || []) for (const dependency of node.dependsOn || []) {
      if (!dependency.loop && outgoing.has(dependency.from)) outgoing.get(dependency.from).push(node.nodeId);
    }
    const queue = [[targetId, [targetId]]], visited = new Set();
    while (queue.length) {
      const [current, path] = queue.shift();
      if (current === sourceId) return [...path, targetId];
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of outgoing.get(current) || []) queue.push([next, [...path, next]]);
    }
    return null;
  },
  organizedPositions(nodes, options = {}) {
    if (!(nodes || []).length) return {};
    const startX = Number(options.startX) || 24;
    const startY = Number(options.startY) || 24;
    const columnPitch = Number(options.columnPitch) || 258;
    const rowPitch = Number(options.rowPitch) || 114;
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const indegree = new Map(nodes.map(node => [node.nodeId, 0]));
    const outgoing = new Map(nodes.map(node => [node.nodeId, []]));
    for (const node of nodes) for (const dependency of node.dependsOn || []) {
      if (dependency.loop || !byId.has(dependency.from)) continue;
      indegree.set(node.nodeId, indegree.get(node.nodeId) + 1);
      outgoing.get(dependency.from).push(node.nodeId);
    }
    const rank = new Map(nodes.map(node => [node.nodeId, 0]));
    const queue = nodes.filter(node => indegree.get(node.nodeId) === 0).map(node => node.nodeId);
    const visited = new Set();
    while (queue.length) {
      const sourceId = queue.shift();
      visited.add(sourceId);
      for (const targetId of outgoing.get(sourceId)) {
        rank.set(targetId, Math.max(rank.get(targetId), rank.get(sourceId) + 1));
        indegree.set(targetId, indegree.get(targetId) - 1);
        if (indegree.get(targetId) === 0) queue.push(targetId);
      }
    }
    const fallbackRank = Math.max(0, ...rank.values()) + 1;
    nodes.filter(node => !visited.has(node.nodeId)).forEach(node => rank.set(node.nodeId, fallbackRank));
    const rows = new Map();
    for (const node of nodes) {
      const level = rank.get(node.nodeId);
      if (!rows.has(level)) rows.set(level, []);
      rows.get(level).push(node.nodeId);
    }
    const positions = {};
    const widestRow = Math.max(1, ...[...rows.values()].map(nodeIds => nodeIds.length));
    for (const [level, nodeIds] of [...rows.entries()].sort((left, right) => left[0] - right[0])) {
      const rowOffset = (widestRow - nodeIds.length) * columnPitch / 2;
      nodeIds.forEach((nodeId, index) => { positions[nodeId] = { x:startX + rowOffset + index * columnPitch, y:startY + level * rowPitch }; });
    }
    return positions;
  },
  edgeRoute(startX, startY, endX, endY, outerX) {
    if (Math.abs(endX - startX) < 3 && endY > startY) return `M ${startX} ${startY} L ${endX} ${endY}`;
    if (endY >= startY + 32) {
      const bend = Math.max(24, Math.abs(endY - startY) * .45);
      return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
    }
    const middleY = Math.round((startY + endY) / 2);
    return `M ${startX} ${startY} C ${startX} ${startY + 28}, ${outerX} ${startY + 28}, ${outerX} ${middleY} S ${endX} ${endY - 28}, ${endX} ${endY}`;
  },
  outputTop(positions, nodes, nodeHeight = 70, gap = 42) {
    return Math.max(166, ...(nodes || []).map(node => (positions?.[node.nodeId]?.y || 0) + nodeHeight + gap));
  },
  constrainBoundary(kind, requested, moduleBounds, fallback, options = {}) {
    const boundaryHeight = Number(options.boundaryHeight) || 34;
    const gap = Number(options.gap) || 24;
    const minimumX = Number(options.minimumX) || 0;
    const bounds = (moduleBounds || []).filter(bound => Number.isFinite(bound?.y));
    const x = Math.max(minimumX, Number(requested?.x ?? fallback?.x) || 0);
    if (kind === 'input') {
      const maximumY = bounds.length
        ? Math.min(...bounds.map(bound => bound.y)) - boundaryHeight - gap
        : Number(fallback?.y) || 0;
      return { x, y:Math.max(0, Math.min(Number(requested?.y ?? fallback?.y) || 0, maximumY)) };
    }
    const minimumY = bounds.length
      ? Math.max(...bounds.map(bound => bound.y + (Number(bound.height) || 70))) + gap
      : Number(fallback?.y) || 0;
    return { x, y:Math.max(Number(requested?.y ?? fallback?.y) || 0, minimumY) };
  }
});
