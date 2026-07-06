//  Zettelkasten
// ════════════════════════════════════════
async function loadZettelkasten(){
  const gd=await api.get('/api/zettelkasten/graph');
  const container=document.getElementById('zettel-network');
  const linkedIds = new Set();
  (gd.edges||[]).forEach(e=>{ linkedIds.add(e.from); linkedIds.add(e.to); });
  const visibleNodes = (gd.nodes||[]).filter(n=>linkedIds.has(n.id));
  const visibleEdges = (gd.edges||[]).filter(e=>linkedIds.has(e.from)&&linkedIds.has(e.to));
  const nodes=new vis.DataSet(visibleNodes.map(n=>({...n,shape:'box',font:{color:'#e2e8f0',size:12},color:{background:n.color||'#252836',border:'#6c8aff',highlight:{background:'#6c8aff33',border:'#a78bfa'}},borderWidth:1,borderWidthSelected:2})));
  const edges=new vis.DataSet(visibleEdges.map(e=>({...e,color:{color:'#2e3347',highlight:'#6c8aff'},width:1.5,smooth:{type:'continuous'}})));
  if(zettelNetwork) zettelNetwork.destroy();
  zettelNetwork=new vis.Network(container,{nodes,edges},{physics:{solver:'forceAtlas2Based',stabilization:{iterations:80}},interaction:{hover:true,tooltipDelay:100}});
  zettelNetwork.on('selectNode',({nodes:sel})=>{if(sel.length===1){switchView('cards');selectCard(sel[0])}});
}

// ════════════════════════════════════════
