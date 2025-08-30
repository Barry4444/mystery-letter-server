import React, { useEffect, useMemo, useState } from 'react';
import { socket } from './socket';
import './app.css'; // zwarte achtergrond etc.

const cardImg = (key) => `/cards/${key}.png`;

export default function App() {
  // join
  const [roomId, setRoomId] = useState('kamer1');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');

  // state uit server
  const [state, setState] = useState(null);      // room:state
  const [myHand, setMyHand] = useState([]);      // player:hand
  const youId = socket.id;
  useEffect(() => {
    const onConnect = () => { /* noop */ };
    const onState = (s) => setState(s);
    const onHand = ({ hand }) => setMyHand(hand ?? []);
    socket.on('connect', onConnect);
    socket.on('room:state', onState);
    socket.on('player:hand', onHand);
    return () => {
      socket.off('connect', onConnect);
      socket.off('room:state', onState);
      socket.off('player:hand', onHand);
    };
  }, []);

  const you = useMemo(() => {
    if (!state) return null;
    return state.players?.find(p => p.id === youId) || null;
  }, [state, youId]);

  const isHost = state?.hostId === youId;
  const isYourTurn = state?.turn === youId;

  // bots configuratie (client-side controls)
  const [botsCount, setBotsCount] = useState(0);
  const [botLevel, setBotLevel] = useState(1);

  // -------- actions --------
  const doJoin = () => {
    setStatus('Bezig met join…');
    socket.timeout(8000).emit('join', { roomId, name }, (res) => {
      if (!res?.ok) return setStatus(`Join mislukt: ${res?.error ?? 'geen ack'}`);
      setStatus(`Gejoined als ${name} — room ${roomId}`);
    });
  };

  const claimHost = () => {
    socket.timeout(5000).emit('host:claim', {}, (res) => {
      if (!res?.ok) setStatus(`Host claim faalde: ${res?.error}`);
    });
  };

  const toggleMusic = () => {
    socket.timeout(5000).emit('music:toggle', {}, (res) => {
      if (!res?.ok) setStatus(`Muziek toggle faalde: ${res?.error}`);
    });
  };

  const applyBots = () => {
    socket.timeout(5000).emit('bots:configure', { botsCount, botLevel }, (res) => {
      if (!res?.ok) setStatus(`Bots instellen faalde: ${res?.error}`);
    });
  };

  const newGame = () => {
    socket.timeout(5000).emit('game:new', {}, (res) => {
      if (!res?.ok) setStatus(`Nieuw spel faalde: ${res?.error}`);
    });
  };

  const startRound = () => {
    socket.timeout(5000).emit('game:startRound', {}, (res) => {
      if (!res?.ok) setStatus(`Start ronde faalde: ${res?.error}`);
    });
  };

  const drawCard = () => {
    socket.timeout(5000).emit('game:draw', {}, (res) => {
      if (!res?.ok) setStatus(`Trek kaart faalde: ${res?.error}`);
    });
  };

  // -------- UI --------
  return (
    <div className="app-wrap">
      <div className="panel">
        <h1>Mystery Letter</h1>

        {/* Join */}
        <div className="row">
          <input className="inp" placeholder="Room ID"
                 value={roomId} onChange={e=>setRoomId(e.target.value)} />
          <input className="inp" placeholder="Naam"
                 value={name} onChange={e=>setName(e.target.value)} />
          <button className="btn" onClick={doJoin}>Join</button>
        </div>

        {/* Host */}
        <div className="row">
          <label className="host-label">
            Host: {state?.hostId ? (state.hostId === youId ? 'jij' : 'bezet') : 'niemand'}
          </label>
          <button className="btn" disabled={!!state?.hostId && !isHost} onClick={claimHost}>
            Claim host
          </button>
        </div>

        {/* Host controls */}
        {isHost && (
          <div className="host-controls">
            <div className="row">
              <button className="btn" onClick={toggleMusic}>
                Muziek {state?.settings?.music ? 'uit' : 'aan'}
              </button>
              <button className="btn" onClick={newGame}>Nieuw spel</button>
              <button className="btn" onClick={startRound}>Start ronde</button>
            </div>

            <div className="row">
              <div className="slider">
                <label># Bots: {botsCount}</label>
                <input type="range" min="0" max="3" value={botsCount}
                  onChange={e=>setBotsCount(parseInt(e.target.value))} />
              </div>
              <div className="slider">
                <label>Bot-niveau: {botLevel}</label>
                <input type="range" min="1" max="3" value={botLevel}
                  onChange={e=>setBotLevel(parseInt(e.target.value))} />
              </div>
              <button className="btn" onClick={applyBots}>Toepassen</button>
            </div>
          </div>
        )}

        {/* Spel status */}
        <div className="row">
          <span>Ronde: {state?.round ?? 0}</span>
          <span> | Beurt: {state?.turn ? (state.players?.find(p=>p.id===state.turn)?.name ?? '—') : '—'}</span>
        </div>

        {/* Acties speler */}
        <div className="row">
          <button className="btn"
                  disabled={!isYourTurn || (myHand?.length ?? 0) !== 1 || !state?.started}
                  onClick={drawCard}>
            Trek kaart
          </button>
          {/* (Later: knoppen om 1 van 2 kaarten te spelen) */}
        </div>

        {/* Jouw hand */}
        <div className="hand">
          {(myHand ?? []).map((c, i) => (
            <div className="card" key={i} title={`${c.name} (${c.rank})`}>
              <img src={cardImg(c.key)} alt={c.name} />
              <div className="caption">{c.name}</div>
            </div>
          ))}
          {(!myHand || myHand.length === 0) && <div className="placeholder">Nog geen kaarten</div>}
        </div>

        {/* Spelers */}
        <div className="players">
          {(state?.players ?? []).map(p => (
            <div className={`pill ${p.id===youId?'you':''} ${p.alive?'':'dead'}`} key={p.id}>
              <span>{p.name}{p.isBot?' 🤖':''}{p.id===state?.hostId?' ⭐':''}</span>
            </div>
          ))}
        </div>

        {/* Log (nieuwste boven) */}
        <div className="log">
          <div className="log-title">Logboek</div>
          <div className="log-body">
            {(state?.logs ?? []).map((line, idx) => (
              <div className="log-line" key={idx}>{line}</div>
            ))}
          </div>
        </div>

        {/* Status/ fouten */}
        <div className="status">{status}</div>
      </div>
    </div>
  );
}
