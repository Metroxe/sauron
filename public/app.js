const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url) { const r = await fetch(url, { method: "POST" }); return r.json(); }
const short = (s, n = 72) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

let mcpMode = "honest";
let sauronOn = false;
let lastPath = null; // { keys, bad } — redrawn on resize

const NODE = {
  sauron: "#n-gate", ch: "#n-ch", semgrep: "#n-semgrep", akash: "#n-akash",
  senso: "#n-senso", guild: "#n-guild", agent: "#n-agent", gw: "#n-gw", mcp: "#n-mcp",
};
// Pipeline order along the bottom row. Clean runs skip the middle three.
const ROW = ["ch", "semgrep", "akash", "senso", "guild"];

const PORTALS = {
  ch: { name: "ClickHouse", logo: "logos/clickhouse.png", url: "https://console.clickhouse.cloud/" },
  semgrep: { name: "Semgrep", logo: "logos/semgrep.png", url: "https://github.com/Metroxe/sauron/blob/main/semgrep/mcp-rules.yaml" },
  akash: { name: "Akash", logo: "logos/akash.png", url: "https://playground.akashml.com/inferences" },
  senso: { name: "Senso", logo: "logos/senso.png", url: "https://geo.senso.ai/knowledge-base" },
  guild: { name: "Guild", logo: "logos/guild.png", url: "https://app.guild.ai" },
};

for (const k of ROW) {
  const p = PORTALS[k];
  const n = $(NODE[k]);
  n.classList.add("dim");
  n.innerHTML = `<img src="${p.logo}" alt="" /><div class="nm">${p.name}</div><div class="st"></div><div class="go">open trace →</div>`;
  n.onclick = () => window.open(n.dataset.href || p.url, "_blank");
}

// ── geometry: draw wires between the real node positions ──
const stage = $("#stage");
const layer = $("#wire-layer");
const SVGNS = "http://www.w3.org/2000/svg";

function box(sel) {
  const s = stage.getBoundingClientRect();
  const r = $(sel).getBoundingClientRect();
  return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width, h: r.height };
}
function clip(b, tx, ty) {
  const dx = tx - b.x, dy = ty - b.y;
  if (!dx && !dy) return { x: b.x, y: b.y };
  const sx = dx ? (b.w / 2 + 5) / Math.abs(dx) : Infinity;
  const sy = dy ? (b.h / 2 + 5) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: b.x + dx * s, y: b.y + dy * s };
}
function seg(from, to, o = {}) {
  const a = box(from), b = box(to);
  let d;
  if (o.curve) {
    // bypass underneath the services this run skips
    const p1 = { x: a.x, y: a.y + a.h / 2 + 4 };
    const p2 = { x: b.x, y: b.y + b.h / 2 + 9 };
    const cy = Math.max(p1.y, p2.y) + 52;
    d = `M${p1.x},${p1.y} C${p1.x},${cy} ${p2.x},${cy} ${p2.x},${p2.y}`;
  } else {
    const p1 = clip(a, b.x, b.y), p2 = clip(b, a.x, a.y);
    d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
  }
  const el = document.createElementNS(SVGNS, "path");
  el.setAttribute("d", d);
  el.setAttribute("class", "wire " + (o.cls || ""));
  if (o.marker !== "none") el.setAttribute("marker-end", `url(#${o.marker || "arr"})`);
  layer.appendChild(el);
  return el;
}
const adjacent = (a, b) => { const i = ROW.indexOf(a), j = ROW.indexOf(b); return i >= 0 && j >= 0 && Math.abs(i - j) === 1; };
function drawSeg(a, b, bad, animate) {
  const curve = ROW.includes(a) && ROW.includes(b) && !adjacent(a, b);
  return seg(NODE[a], NODE[b], { curve, cls: `${bad ? "bad" : "ok"} ${animate ? "flow" : ""}`, marker: bad ? "arr-bad" : "arr-ok" });
}

// The request path, always present: agent → gateway → MCP. Plus Sauron's install line.
function drawBase(flowing = false, bad = false) {
  layer.innerHTML = "";
  const cls = flowing ? `flow ${bad ? "bad" : "amb"}` : "";
  const marker = flowing ? (bad ? "arr-bad" : "arr-amb") : "arr";
  seg(NODE.agent, NODE.gw, { cls, marker });
  seg(NODE.gw, NODE.mcp, { cls, marker });
  if (sauronOn) seg(NODE.gw, NODE.sauron, { cls: "install", marker: "none" });
}
function redraw() {
  drawBase();
  if (!lastPath) return;
  for (let i = 1; i < lastPath.keys.length; i++) drawSeg(lastPath.keys[i - 1], lastPath.keys[i], lastPath.bad, false);
}
window.addEventListener("resize", redraw);

// ── toggles ──
$("#t-mcp").onclick = async () => {
  const next = mcpMode !== "malicious";
  const r = await fetch("/api/canary/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ malicious: next }) });
  setMcpMode((await r.json()).mode);
};
function setMcpMode(m) {
  mcpMode = m;
  const t = $("#t-mcp");
  t.textContent = m === "malicious" ? "😈 Malicious" : "😇 Honest";
  t.className = "toggle " + (m === "malicious" ? "malicious" : "honest");
  const pill = $("#mcp-pill"); pill.textContent = m; pill.className = "pill " + (m === "malicious" ? "bad" : "ok");
}
$("#t-sauron").onclick = () => {
  sauronOn = !sauronOn;
  const t = $("#t-sauron");
  t.textContent = sauronOn ? "● On" : "○ Off";
  t.className = "toggle " + (sauronOn ? "on" : "off");
  $("#stage").classList.toggle("sauron-on", sauronOn);
  $("#gw-body").textContent = sauronOn ? "Sauron installed ✓ — vets every call" : "every MCP call routes through here";
  resetNodes();
};
$("#reset").onclick = async () => {
  await post("/api/gate/reset");
  setMcpMode("honest");
  resetNodes();
};

// ── node state ──
function resetNodes() {
  lastPath = null;
  for (const k of ROW) {
    const n = $(NODE[k]);
    n.classList.remove("lit", "bad", "busy"); n.classList.add("dim");
    n.querySelector(".st").textContent = ""; n.removeAttribute("data-href"); n.removeAttribute("title");
  }
  $("#n-gate").className = "node gate"; $("#gate-body").textContent = "installed in the gateway";
  $("#n-agent").className = "node agent"; $("#agent-body").innerHTML = "asks: “What's the weather in San Francisco?”";
  $("#n-mcp").classList.remove("bad");
  requestAnimationFrame(() => drawBase());
}
function renderMcp(tools) {
  const bad = tools.some((t) => t.flagged);
  $("#n-mcp").classList.toggle("bad", bad);
  $("#mcp-body").innerHTML = `<div class="muted" style="font-size:10.5px">returned ${tools.length} tool definitions:</div>` +
    tools.map((t) => `<div class="tool ${t.flagged ? "bad" : ""}"><div class="tn">${esc(t.name)}</div><div class="td">${esc(t.description)}</div></div>`).join("");
}
function agentOut(text, bad) {
  $("#n-agent").className = "node agent " + (bad ? "bad" : "good");
  $("#agent-body").innerHTML = `<div class="agent-out">${esc(text)}</div>`;
}
function gate(cls, hd, lines) {
  $("#n-gate").className = "node gate " + cls;
  $("#gate-body").innerHTML = `<b style="font-size:13px">${hd}</b>` + lines.map((l) => `<div style="margin-top:3px">• ${esc(l)}</div>`).join("");
}
function lightSvc(k, st, bad) {
  const n = $(NODE[k]);
  n.classList.remove("dim", "busy"); n.classList.add("lit"); n.classList.toggle("bad", bad);
  const out = lateUpdates[k]?.output ?? st.output;
  delete lateUpdates[k];
  n.querySelector(".st").textContent = short(out);
  n.title = out;
  if (st.trace) n.dataset.href = st.trace;
}

// ── RUN ──
$("#run").onclick = async () => {
  $("#run").disabled = true;
  resetNodes();
  await sleep(30);
  try { sauronOn ? await runGated() : await runDirect(); } catch (e) { console.warn(e); }
  $("#run").disabled = false;
};

// Sauron off: the agent's request goes straight through the gateway to the MCP.
async function runDirect() {
  const bad = mcpMode === "malicious";
  drawBase(true, bad);
  $("#mcp-body").textContent = "…";
  await sleep(400);
  const d = await post("/api/mcp/peek");
  renderMcp(d.tools);
  await sleep(250);
  drawBase(false);
  agentOut(d.agent || "(no answer)", d.poisoned);
}

// ── live stage stream: the server emits each stage the moment its real call returns ──
let onStage = null;
let lastRunId = null;
const lateUpdates = {}; // a service's real answer that landed before its node lit
const es = new EventSource("/api/events");
es.onmessage = (m) => {
  let ev, p; try { ev = JSON.parse(m.data); p = JSON.parse(ev.detail); } catch { return; }
  if (ev.type !== "stage") return;
  if (p.kind === "svc-update") {
    // e.g. Guild's agent finishing its written decision a few seconds later
    if (p.runId !== lastRunId) return;
    const n = $(NODE[p.key]);
    if (n.classList.contains("lit")) { n.querySelector(".st").textContent = short(p.output); n.title = p.output; }
    else lateUpdates[p.key] = p;
    return;
  }
  onStage?.(p);
};

// Where the request goes next. Drift runs the whole chain; clean skips to Guild.
const NEXT = {
  bad: { sauron: "ch", ch: "semgrep", semgrep: "akash", akash: "senso", senso: "guild", guild: "agent" },
  ok: { sauron: "ch", ch: "guild", guild: "agent" },
};

// Sauron on: follow the REAL path as it happens. A flowing wire means that
// service is being called right now; it lights when its real answer arrives.
async function runGated() {
  const runId = Math.random().toString(36).slice(2);
  lastRunId = runId;
  for (const k in lateUpdates) delete lateUpdates[k];
  gate("", "⏳ checking…", ["fetching the MCP's current tools"]);
  drawBase(true, false);

  const queue = [];
  let wake = null, done = false, d = null;
  onStage = (p) => { if (p.runId === runId) { queue.push(p); wake?.(); } };
  fetch("/api/agent/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) })
    .then((r) => r.json()).then((x) => { d = x; }).catch((e) => console.warn(e))
    .finally(() => { done = true; wake?.(); });
  const next = () => new Promise((res) => { if (queue.length || done) res(); else wake = () => { wake = null; res(); }; });

  const keys = ["sauron"];
  let bad = false, pending = null, lastLit = 0, gotGate = false;
  const inFlight = (from) => {
    const to = NEXT[bad ? "bad" : "ok"][from];
    if (!to) return;
    pending = drawSeg(from, to, bad, true);
    if (to !== "agent") { const n = $(NODE[to]); n.classList.add("busy"); n.querySelector(".st").textContent = "calling…"; }
  };
  const showGate = (p) => {
    gotGate = true; bad = !!p.detected;
    renderMcp(p.tools || []);
    drawBase(false);
    if (bad) gate("detected", "🚨 DRIFT DETECTED", p.reasons || []);
    else gate("pass", "✓ PASS", [p.sauron || "matches the approved baseline"]);
    inFlight("sauron");
  };
  const showSvc = async (st) => {
    await sleep(Math.max(0, 450 - (Date.now() - lastLit))); // keep each step readable
    pending?.remove(); pending = null;
    drawSeg(keys[keys.length - 1], st.key, bad, false);
    lightSvc(st.key, st, bad);
    keys.push(st.key); lastLit = Date.now();
    inFlight(st.key);
  };

  for (;;) {
    await next();
    if (queue.length) {
      const p = queue.shift();
      if (p.kind === "gate") showGate(p);
      else if (p.kind === "svc") await showSvc(p);
      continue;
    }
    if (done) break;
  }
  onStage = null;
  if (!d) { pending?.remove(); gate("detected", "⚠ error", ["the gateway call failed"]); return; }

  // Anything the stream missed, fill in from the final response.
  if (!gotGate) showGate({ detected: d.detected, reasons: d.reasons, tools: d.tools, sauron: d.stages.find((s) => s.key === "sauron")?.output || d.reasons[0] });
  for (const st of d.stages.filter((s) => s.key !== "sauron").slice(keys.length - 1)) await showSvc(st);

  await sleep(Math.max(0, 450 - (Date.now() - lastLit)));
  pending?.remove(); pending = null;
  drawSeg(keys[keys.length - 1], "agent", bad, false);
  agentOut(d.agent || d.agentMessage, !d.allowed);
  keys.push("agent");
  lastPath = { keys, bad };
}

async function loadMode() {
  try { const r = await fetch("/api/canary/mode").then((x) => x.json()); setMcpMode(r.mode === "malicious" ? "malicious" : "honest"); } catch {}
}
loadMode();
requestAnimationFrame(() => drawBase());
