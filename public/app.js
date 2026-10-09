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
// tone: "ok" (green), "warn" (amber: under review / in flight), "bad" (red)
const TONE = { ok: ["ok", "arr-ok"], warn: ["amb", "arr-amb"], bad: ["bad", "arr-bad"] };
function drawSeg(a, b, tone, animate) {
  const [cls, marker] = TONE[tone === true ? "bad" : tone === false ? "ok" : tone] || TONE.ok;
  const curve = ROW.includes(a) && ROW.includes(b) && !adjacent(a, b);
  return seg(NODE[a], NODE[b], { curve, cls: `${cls} ${animate ? "flow" : ""}`, marker });
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
  for (const [a, b, t] of lastPath.segs) drawSeg(a, b, t, false);
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
    n.classList.remove("lit", "bad", "warn", "busy"); n.classList.add("dim");
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
function lightSvc(k, st, tone) {
  const n = $(NODE[k]);
  n.classList.remove("dim", "busy", "bad", "warn"); n.classList.add("lit");
  if (tone === "bad" || tone === "warn") n.classList.add(tone);
  const out = lateUpdates[k]?.output ?? st.output;
  delete lateUpdates[k];
  n.querySelector(".st").textContent = short(out);
  n.title = out;
  if (st.trace) n.dataset.href = st.trace;
}

// ── RUN ──
$("#run").onclick = async () => {
  if (busy) return;
  busy = true; $("#run").disabled = true;
  resetNodes();
  await sleep(30);
  try { sauronOn ? await runGated() : await runDirect(); } catch (e) { console.warn(e); }
  busy = false; $("#run").disabled = false;
  pump();
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
let busy = false;
let lastRunId = null;
let activeRun = null, wake = null;
const buffers = new Map(); // runId -> events not yet drawn
const foreign = []; // runs started elsewhere (Claude Code via the MCP gateway), in order
const ownRuns = new Set();
const lateUpdates = {}; // a service's real answer that landed before its node lit
const es = new EventSource("/api/events");
es.onmessage = (m) => {
  let ev, p; try { ev = JSON.parse(m.data); p = JSON.parse(ev.detail); } catch { return; }
  if (ev.type !== "stage" || !p.runId) return;
  if (p.kind === "svc-update") {
    // e.g. Guild's agent finishing its written decision a few seconds later
    if (p.runId !== lastRunId) return;
    const n = $(NODE[p.key]);
    if (n.classList.contains("lit")) { n.querySelector(".st").textContent = short(p.output); n.title = p.output; }
    else lateUpdates[p.key] = p;
    return;
  }
  if (!buffers.has(p.runId)) {
    if (!ownRuns.has(p.runId) && p.kind !== "gate") return; // joined mid-run; skip it
    buffers.set(p.runId, []);
    if (!ownRuns.has(p.runId)) foreign.push(p.runId);
  }
  buffers.get(p.runId).push(p);
  if (p.runId === activeRun) wake?.();
  pump();
};

// Follow the next run Claude Code started, once the stage is free.
async function pump() {
  if (busy || !foreign.length) return;
  const runId = foreign.shift();
  busy = true; $("#run").disabled = true;
  if (!sauronOn) $("#t-sauron").click(); // a gateway run always goes through Sauron
  loadMode(); // keep the MCP toggle honest about the server's current face
  resetNodes();
  await sleep(30);
  try { await follow(runId, null); } catch (e) { console.warn(e); }
  busy = false; $("#run").disabled = false;
  setTimeout(pump, 600);
}

// Where the request goes next. First sight or drift runs the whole chain;
// a call that matches the approved baseline goes straight to Guild.
const NEXT = {
  review: { sauron: "ch", ch: "semgrep", semgrep: "akash", akash: "senso", senso: "guild", guild: "agent" },
  pass: { sauron: "ch", ch: "guild", guild: "agent" },
};

// Sauron on, from the dashboard's RUN button.
async function runGated() {
  const runId = Math.random().toString(36).slice(2);
  ownRuns.add(runId);
  buffers.set(runId, []);
  const call = fetch("/api/agent/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) })
    .then((r) => r.json());
  await follow(runId, call);
  ownRuns.delete(runId);
}

// Follow the REAL path as it happens. A flowing wire means that service is
// being called right now; it lights when its real answer arrives.
async function follow(runId, call) {
  lastRunId = runId; activeRun = runId;
  for (const k in lateUpdates) delete lateUpdates[k];
  const buf = buffers.get(runId) || [];
  let d = null, posted = !call, doneEv = null;
  call?.then((x) => { d = x; }).catch((e) => console.warn(e)).finally(() => { posted = true; wake?.(); });
  const next = () => new Promise((res) => {
    if (buf.length || (posted && call)) return res();
    const t = setTimeout(() => { wake = null; res(); }, call ? 60000 : 45000); // never hang on a lost run
    wake = () => { clearTimeout(t); wake = null; res(); };
  });

  gate("", "⏳ checking…", ["fetching the MCP's current tools"]);
  drawBase(true, false);

  const keys = ["sauron"], segs = [];
  let review = false, tone = "ok", pending = null, lastLit = 0, gotGate = false, source = "dashboard";
  const inFlight = (from) => {
    const to = NEXT[review ? "review" : "pass"][from];
    if (!to) return;
    pending = drawSeg(from, to, "warn", true);
    if (to !== "agent") { const n = $(NODE[to]); n.classList.add("busy"); n.querySelector(".st").textContent = "calling…"; }
  };
  const showGate = (p) => {
    gotGate = true; review = !!p.review; source = p.source || source;
    if (source === "claude") agentAsk(`Claude Code → ${p.request || "tools/list"}`);
    renderMcp(p.tools || []);
    drawBase(false);
    if (p.firstSeen) gate("review", "🆕 NEW SERVER · full review", p.reasons || []);
    else if (review) gate("detected", "🚨 DRIFT · full review", p.reasons || []);
    else gate("pass", "✓ PASS", [p.sauron || "matches the approved baseline"]);
    inFlight("sauron");
  };
  const showSvc = async (st) => {
    await sleep(Math.max(0, 450 - (Date.now() - lastLit))); // keep each step readable
    pending?.remove(); pending = null;
    const t = st.tone || (st.bad ? "bad" : "ok");
    drawSeg(keys[keys.length - 1], st.key, t, false);
    segs.push([keys[keys.length - 1], st.key, t]);
    lightSvc(st.key, st, t);
    keys.push(st.key); lastLit = Date.now(); tone = t;
    inFlight(st.key);
  };

  for (;;) {
    await next();
    if (buf.length) {
      const p = buf.shift();
      if (p.kind === "gate") showGate(p);
      else if (p.kind === "svc") await showSvc(p);
      else if (p.kind === "done") { doneEv = p; break; }
      continue;
    }
    if (posted && call) { await sleep(400); if (!buf.length) break; continue; } // stragglers
    if (!call) break; // a followed run went quiet
  }
  activeRun = null; buffers.delete(runId);

  // Anything the stream missed, fill in from the final response.
  if (d && !gotGate) showGate({ review: d.review, reasons: d.reasons, tools: d.tools, sauron: d.stages.find((s) => s.key === "sauron")?.output });
  if (d) for (const st of d.stages.filter((s) => s.key !== "sauron").slice(keys.length - 1)) await showSvc(st);
  const fin = doneEv || d;
  pending?.remove(); pending = null;
  if (!fin) { gate("detected", "⚠ no answer", ["the gateway call did not finish"]); return; }

  await sleep(Math.max(0, 450 - (Date.now() - lastLit)));
  if (!fin.allowed) gate("detected", "⛔ QUARANTINED", ["permanent block awaits a human in Guild"]);
  else if (fin.review) gate("pass", "✓ APPROVED · new baseline", ["reviewed safe; stored as the approved baseline"]);
  const endTone = fin.allowed ? "ok" : "bad";
  drawSeg(keys[keys.length - 1], "agent", endTone, false);
  segs.push([keys[keys.length - 1], "agent", endTone]);
  agentOut(agentText(source, fin), !fin.allowed);
  lastPath = { segs };
}

function agentText(source, fin) {
  if (source !== "claude") return fin.agent || fin.agentMessage;
  if (!fin.allowed) return "Claude Code ← Blocked by Sauron. The weather server changed after approval, so the call never reached it.";
  return fin.result ? `Claude Code ← ${fin.result}` : "Claude Code ← tools approved and listed";
}
function agentAsk(text) {
  $("#n-agent").className = "node agent";
  $("#agent-body").innerHTML = `<div class="agent-out">${esc(text)}</div>`;
}

async function loadMode() {
  try { const r = await fetch("/api/canary/mode").then((x) => x.json()); setMcpMode(r.mode === "malicious" ? "malicious" : "honest"); } catch {}
}
loadMode();
requestAnimationFrame(() => drawBase());
