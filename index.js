.app-wrap {
  min-height: 100vh;
  background: #000;
  color: #eee;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 24px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
}

.panel {
  width: min(1100px, 95vw);
  display: grid;
  gap: 12px;
}

h1 { margin: 0 0 8px; font-size: 22px; }

.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.inp {
  background: #111; border: 1px solid #333; color: #eee; padding: 8px 10px; border-radius: 8px;
}
.btn {
  background: #1e1e1e; border: 1px solid #444; color: #eee; padding: 8px 12px; border-radius: 10px; cursor: pointer;
}
.btn:disabled { opacity: .5; cursor: not-allowed; }

.host-controls { padding: 8px; border: 1px dashed #333; border-radius: 10px; }
.host-label { opacity: .9; }

.slider { display: grid; gap: 4px; min-width: 180px; }

.hand { display: flex; gap: 10px; align-items: center; min-height: 180px; }
.card { width: 120px; background: #111; border: 1px solid #333; border-radius: 12px; overflow: hidden; text-align: center; }
.card img { width: 100%; display: block; }
.caption { font-size: 12px; padding: 6px; color: #ccc; }
.placeholder { opacity: .6; font-style: italic; }

.players { display: flex; gap: 6px; flex-wrap: wrap; }
.pill {
  border: 1px solid #333; background: #111; padding: 6px 10px; border-radius: 999px; font-size: 14px; color: #ddd;
}
.pill.you { border-color: #999; }
.pill.dead { opacity: .5; text-decoration: line-through; }

.log { background:#0b0b0b; border:1px solid #222; border-radius:12px; overflow:hidden; }
.log-title { padding:8px 10px; background:#101010; border-bottom:1px solid #222; font-weight:600; }
.log-body { max-height: 240px; overflow:auto; display:flex; flex-direction:column; gap:4px; padding:8px 10px; }
.log-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; color:#cfcfcf; }

.status { opacity:.9; font-size: 13px; }
