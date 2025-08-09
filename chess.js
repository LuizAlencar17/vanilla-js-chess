/* =====================================================================
   Vanilla JS Chess — modular version (no frameworks)
   Features:
   - Legal move generation (checks, castling, en passant, promotion)
   - Click-to-move with highlights
   - Smooth animations (piece slide, capture fade)
   - AI opponent with difficulty slider (0=random, 1–4=depth search)
   - Black pieces start on the top ranks (as requested)
   ===================================================================== */

/* ----------------------
   Constants & Utilities
   ---------------------- */
const SQ = 72; // must match --sq in CSS

// Unicode glyphs for pieces
const GLYPH = {
  wP:'♙', wN:'♘', wB:'♗', wR:'♖', wQ:'♕', wK:'♔',
  bP:'♟', bN:'♞', bB:'♝', bR:'♜', bQ:'♛', bK:'♚'
};

// Material values for a tiny eval (used by the AI)
const VAL = { P:100, N:320, B:330, R:500, Q:900, K:20000 };

// Board math helpers
const idx  = (f,r) => r*8 + f;                // file,rank -> 0..63
const file = i => i % 8;                       // 0..7
const rank = i => Math.floor(i / 8);           // 0..7
const inBoard = (f,r) => f>=0 && f<8 && r>=0 && r<8;
const opp = side => side === 'w' ? 'b' : 'w';

// DOM references
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// App state: board, turn, rights, etc.
let state;                 // current game state object
let selected = null;       // currently selected square + moves
let aiThinking = false;    // simple re-entrancy guard
let perspectiveWhite = true; // true => white drawn at bottom

// Map: square index -> DOM <div class="piece">
const pieceDom = new Map();

/* -----------------------------------
   1) Build static grid (.sq elements)
   ----------------------------------- */
function buildBoardSquares(){
  boardEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  // We create squares top-to-bottom so CSS grid indexes match visuals
  for(let r=7; r>=0; r--){
    for(let f=0; f<8; f++){
      const s = document.createElement('div');
      s.className = 'sq ' + ((r+f)%2===0 ? 'light' : 'dark');
      s.dataset.f = f;
      s.dataset.r = r;
      frag.appendChild(s);
    }
  }
  boardEl.appendChild(frag);
}

/* -----------------------------------
   2) Initial position and FEN helpers
   ----------------------------------- */
function startPosition(){
  // Black on top (ranks 7 & 6), White on bottom (ranks 0 & 1)
  const b = Array(64).fill(null);
  const back = ['R','N','B','Q','K','B','N','R'];
  for(let f=0; f<8; f++){
    b[idx(f,0)] = 'w' + back[f];
    b[idx(f,1)] = 'wP';
    b[idx(f,6)] = 'bP';
    b[idx(f,7)] = 'b' + back[f];
  }
  return {
    board: b,
    turn: 'w',
    castling: { wK:true, wQ:true, bK:true, bQ:true },
    ep: -1,            // en passant target square (index), -1 if none
    halfmove: 0,       // 50-move rule clock (not fully enforced here)
    fullmove: 1        // move number
  };
}

function cloneState(s){
  return {
    board: s.board.slice(),
    turn: s.turn,
    castling: { ...s.castling },
    ep: s.ep,
    halfmove: s.halfmove,
    fullmove: s.fullmove
  };
}

// FEN serialization (handy for debugging and copy/paste)
function toFEN(s){
  let rows = [];
  for(let r=7; r>=0; r--){
    let row = '', empty = 0;
    for(let f=0; f<8; f++){
      const p = s.board[idx(f,r)];
      if(!p){ empty++; continue; }
      if(empty){ row += empty; empty = 0; }
      row += pieceToFen(p);
    }
    if(empty) row += empty;
    rows.push(row);
  }
  let castle = '';
  castle += s.castling.wK ? 'K' : '';
  castle += s.castling.wQ ? 'Q' : '';
  castle += s.castling.bK ? 'k' : '';
  castle += s.castling.bQ ? 'q' : '';
  if(!castle) castle = '-';
  const ep = s.ep >= 0 ? idxToAlg(s.ep) : '-';
  return rows.join('/') + ' ' + s.turn + ' ' + castle + ' ' + ep + ' ' + s.halfmove + ' ' + s.fullmove;
}

// FEN parsing
function fromFEN(fen){
  const parts = fen.trim().split(/\s+/);
  if(parts.length < 4) throw new Error('Bad FEN');
  const [boardStr, turn, castleStr, epStr, half='0', full='1'] = parts;

  const b = Array(64).fill(null);
  const rows = boardStr.split('/');
  if(rows.length !== 8) throw new Error('Bad FEN ranks');

  for(let r=7; r>=0; r--){
    const row = rows[7-r];
    let f = 0;
    for(const ch of row){
      if(/[1-8]/.test(ch)){ f += +ch; continue; }
      b[idx(f,r)] = fenToPiece(ch);
      f++;
    }
  }

  const castling = { wK:false, wQ:false, bK:false, bQ:false };
  if(castleStr && castleStr !== '-'){
    for(const c of castleStr){
      if(c==='K') castling.wK = true;
      if(c==='Q') castling.wQ = true;
      if(c==='k') castling.bK = true;
      if(c==='q') castling.bQ = true;
    }
  }

  const ep = (epStr && epStr !== '-') ? algToIdx(epStr) : -1;
  return {
    board: b,
    turn: (turn==='b' ? 'b' : 'w'),
    castling, ep,
    halfmove: (+half)|0,
    fullmove: (+full)|0
  };
}

// Helpers for FEN piece symbols
function pieceToFen(p){
  const map = { P:'P', N:'N', B:'B', R:'R', Q:'Q', K:'K' };
  const sym = map[p[1]];
  return p[0] === 'w' ? sym : sym.toLowerCase();
}
function fenToPiece(ch){
  const map = { p:'P', n:'N', b:'B', r:'R', q:'Q', k:'K' };
  return (ch===ch.toLowerCase() ? 'b' : 'w') + map[ch.toLowerCase()];
}
function idxToAlg(i){ return 'abcdefgh'[file(i)] + (rank(i)+1); }
function algToIdx(s){ return idx('abcdefgh'.indexOf(s[0]), parseInt(s[1],10)-1); }

/* --------------------------------------------------
   3) Move generation, checks, castling, en passant
   -------------------------------------------------- */

// Returns true if square `sq` is attacked by side `by`
function isAttacked(sq, by, s){
  const B = s.board;
  const kingSteps = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  // Pawn attacks: note the relative direction
  const dr = by === 'w' ? 1 : -1;
  for(const df of [-1, 1]){
    const f = file(sq) + df, r = rank(sq) - dr; // attacker sits one rank behind target
    if(inBoard(f,r) && B[idx(f,r)] === by + 'P') return true;
  }
  // Knight attacks
  const KJ = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
  for(const [df,dr2] of KJ){
    const f = file(sq) + df, r = rank(sq) + dr2;
    if(inBoard(f,r) && B[idx(f,r)] === by + 'N') return true;
  }
  // Bishop/queen diagonals
  for(const [df,dr3] of [[1,1],[-1,1],[1,-1],[-1,-1]]){
    let f = file(sq)+df, r = rank(sq)+dr3;
    while(inBoard(f,r)){
      const p = B[idx(f,r)];
      if(p){ if(p[0]===by && (p[1]==='B' || p[1]==='Q')) return true; break; }
      f+=df; r+=dr3;
    }
  }
  // Rook/queen orthogonals
  for(const [df,dr4] of [[1,0],[-1,0],[0,1],[0,-1]]){
    let f = file(sq)+df, r = rank(sq)+dr4;
    while(inBoard(f,r)){
      const p = B[idx(f,r)];
      if(p){ if(p[0]===by && (p[1]==='R' || p[1]==='Q')) return true; break; }
      f+=df; r+=dr4;
    }
  }
  // King
  for(const [df,dr5] of kingSteps){
    const f = file(sq)+df, r = rank(sq)+dr5;
    if(inBoard(f,r) && B[idx(f,r)] === by + 'K') return true;
  }
  return false;
}

// Pseudo-legal move generation + legality filter
function genMoves(s){
  const moves = [];
  const B = s.board, turn = s.turn;
  const forward = turn === 'w' ? 1 : -1;
  const startR  = turn === 'w' ? 1 : 6;
  const promR   = turn === 'w' ? 7 : 0;

  const add = (from,to,flags={}) => moves.push({from,to,flags});

  for(let i=0; i<64; i++){
    const P = B[i];
    if(!P || P[0] !== turn) continue;

    const f = file(i), r = rank(i), t = P[1];

    if(t === 'P'){
      // Forward pushes
      const r1 = r + forward;
      if(inBoard(f,r1) && !B[idx(f,r1)]){
        if(r1 === promR) add(i, idx(f,r1), {promo:'Q'}); else add(i, idx(f,r1));
        // Double from starting rank
        if(r === startR){
          const r2 = r + 2*forward;
          if(!B[idx(f,r2)]) add(i, idx(f,r2), {epSet: idx(f,r1)});
        }
      }
      // Captures
      for(const df of [-1,1]){
        const f1 = f + df, r1c = r + forward;
        if(!inBoard(f1,r1c)) continue;
        const tSq = idx(f1,r1c);
        if(B[tSq] && B[tSq][0] !== turn){
          if(r1c===promR) add(i, tSq, {capture:true, promo:'Q'});
          else add(i, tSq, {capture:true});
        }
      }
      // En passant
      if(s.ep >= 0){
        const epF = file(s.ep), epR = rank(s.ep);
        if(epR === r + forward && Math.abs(epF - f) === 1){
          add(i, s.ep, {ep:true, capture:true});
        }
      }
    } else if(t === 'N'){
      for(const [df,dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]){
        const f1=f+df, r1=r+dr; if(!inBoard(f1,r1)) continue;
        const T = idx(f1,r1); if(!B[T] || B[T][0]!==turn) add(i, T, {capture: !!B[T]});
      }
    } else if(t === 'B' || t === 'R' || t === 'Q'){
      const dirs = [];
      if(t !== 'B') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      if(t !== 'R') dirs.push([1,1],[-1,1],[1,-1],[-1,-1]);
      for(const [df,dr] of dirs){
        let f1=f+df, r1=r+dr;
        while(inBoard(f1,r1)){
          const T = idx(f1,r1), q = B[T];
          if(!q) add(i,T);
          else { if(q[0]!==turn) add(i,T,{capture:true}); break; }
          f1+=df; r1+=dr;
        }
      }
    } else if(t === 'K'){
      for(const [df,dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
        const f1=f+df, r1=r+dr; if(!inBoard(f1,r1)) continue;
        const T = idx(f1,r1), q = B[T];
        if(!q || q[0]!==turn) add(i, T, {capture: !!q});
      }
      // Castling (requires empty squares and not passing through check)
      if(turn==='w' && r===0 && f===4){
        if(s.castling.wK && !B[idx(5,0)] && !B[idx(6,0)]
           && !isAttacked(idx(4,0),'b',s) && !isAttacked(idx(5,0),'b',s) && !isAttacked(idx(6,0),'b',s)){
          add(i, idx(6,0), {castle:'K'});
        }
        if(s.castling.wQ && !B[idx(1,0)] && !B[idx(2,0)] && !B[idx(3,0)]
           && !isAttacked(idx(4,0),'b',s) && !isAttacked(idx(3,0),'b',s) && !isAttacked(idx(2,0),'b',s)){
          add(i, idx(2,0), {castle:'Q'});
        }
      }
      if(turn==='b' && r===7 && f===4){
        if(s.castling.bK && !B[idx(5,7)] && !B[idx(6,7)]
           && !isAttacked(idx(4,7),'w',s) && !isAttacked(idx(5,7),'w',s) && !isAttacked(idx(6,7),'w',s)){
          add(i, idx(6,7), {castle:'K'});
        }
        if(s.castling.bQ && !B[idx(1,7)] && !B[idx(2,7)] && !B[idx(3,7)]
           && !isAttacked(idx(4,7),'w',s) && !isAttacked(idx(3,7),'w',s) && !isAttacked(idx(2,7),'w',s)){
          add(i, idx(2,7), {castle:'Q'});
        }
      }
    }
  }

  // King-safety filter: apply move, then test if own king is attacked
  const legal = [];
  for(const m of moves){
    const s2 = makeMove(s, m);
    const kingSq = s2.board.findIndex(p => p === s.turn + 'K');
    if(!isAttacked(kingSq, opp(s.turn), s2)) legal.push(m);
  }
  return legal;
}

// Apply a move and return the NEW state (no animations here)
function makeMove(s, m){
  const B = s.board.slice();
  const from = m.from, to = m.to;
  const P = B[from], turn = s.turn, other = opp(turn);

  // En passant capture removes pawn *behind* the destination
  if(m.flags?.ep){
    const capSq = idx(file(to), rank(to) + (turn==='w' ? -1 : 1));
    B[capSq] = null;
  }

  // Move the piece
  B[to] = P;
  B[from] = null;

  // Promotion (auto-queen; easy to extend to a picker UI)
  if(P[1] === 'P'){
    const lastRank = turn === 'w' ? 7 : 0;
    if(rank(to) === lastRank){
      B[to] = turn + (m.flags?.promo || 'Q');
    }
  }

  // Castling: move rook accordingly, and kill rights
  if(P[1] === 'K'){
    if(turn === 'w'){ s.castling.wK = s.castling.wQ = false; }
    else            { s.castling.bK = s.castling.bQ = false; }
    if(m.flags?.castle === 'K'){
      const r = (turn==='w') ? 0 : 7;
      B[idx(5,r)] = turn + 'R'; B[idx(7,r)] = null;
    } else if(m.flags?.castle === 'Q'){
      const r = (turn==='w') ? 0 : 7;
      B[idx(3,r)] = turn + 'R'; B[idx(0,r)] = null;
    }
  }

  // If a rook moves (or gets captured on its original square), update castling rights
  if(P[1] === 'R'){
    if(from === idx(7,0)) s.castling.wK = false;
    if(from === idx(0,0)) s.castling.wQ = false;
    if(from === idx(7,7)) s.castling.bK = false;
    if(from === idx(0,7)) s.castling.bQ = false;
  }
  if(m.flags?.capture){
    if(to === idx(7,0)) s.castling.wK = false;
    if(to === idx(0,0)) s.castling.wQ = false;
    if(to === idx(7,7)) s.castling.bK = false;
    if(to === idx(0,7)) s.castling.bQ = false;
  }

  // Produce next state object
  const s2 = cloneState(s);
  s2.board = B;
  s2.turn = other;
  s2.ep = m.flags?.epSet ?? -1;
  s2.halfmove = (P[1]==='P' || m.flags?.capture) ? 0 : s.halfmove + 1;
  s2.fullmove = (other === 'w') ? s.fullmove + 1 : s.fullmove;
  return s2;
}

/* ----------------------------------------
   4) Rendering: positions, highlights, UI
   ---------------------------------------- */

// Convert a board index to pixel coordinates, honoring perspective
function squareToXY(i){
  const f = file(i), r = rank(i);
  const drawR = perspectiveWhite ? r : 7 - r;
  const drawF = perspectiveWhite ? f : 7 - f;
  return { x: drawF * SQ, y: (7 - drawR) * SQ }; // (0,0) is top-left in pixels
}

// Move a DOM piece element to a board square (optionally snap without animation)
function movePieceElementTo(el, i, snap=false){
  const {x,y} = squareToXY(i);
  if(snap) el.style.transition = 'none';
  el.style.transform = `translate(${x}px, ${y}px)`;
  if(snap){ void el.offsetWidth; el.style.transition = ''; }
}

// Create/update/remove piece nodes to reflect `state.board`
function renderPieces(){
  const present = new Set();

  // Create or update all living pieces
  for(let i=0; i<64; i++){
    const p = state.board[i];
    if(!p) continue;
    present.add(i);

    let el = pieceDom.get(i);
    const glyph = GLYPH[p];

    if(!el){
      el = document.createElement('div');
      el.className = 'piece ' + (p[0]==='w' ? 'white' : 'black');
      el.textContent = glyph;
      pieceDom.set(i, el);
      boardEl.appendChild(el);
      movePieceElementTo(el, i, true); // snap on first paint
    } else {
      el.className = 'piece ' + (p[0]==='w' ? 'white' : 'black');
      if(el.textContent !== glyph) el.textContent = glyph;
      movePieceElementTo(el, i, true); // reconcile position (in case of flip)
    }
  }

  // Remove any DOM nodes for squares that no longer have pieces
  for(const [k, el] of pieceDom){
    if(!present.has(k)){ el.remove(); pieceDom.delete(k); }
  }

  // Belt & suspenders: remove any stray .piece not tracked in map
  const live = new Set([...pieceDom.values()]);
  boardEl.querySelectorAll('.piece').forEach(el => { if(!live.has(el)) el.remove(); });

  // Update FEN field & status
  document.getElementById('fenIn').value = toFEN(state);
  updateStatus();
}

// Helper to get a .sq element for a given index
function atGridSquare(i){
  const {x,y} = squareToXY(i);
  const col = Math.round(x / SQ);
  const row = Math.round(y / SQ);
  const squares = boardEl.querySelectorAll('.sq'); // crucial: only cells, not pieces
  return squares[row*8 + col] || null;
}

// Selection highlighting
function clearHighlights(){
  boardEl.querySelectorAll('.sq').forEach(sq => {
    sq.classList.remove('sel');
    const dot = sq.querySelector('.dot');
    if(dot) dot.remove();
  });
}
function highlight(from, moves){
  clearHighlights();
  const fromEl = atGridSquare(from);
  if(fromEl) fromEl.classList.add('sel');

  const squares = boardEl.querySelectorAll('.sq');
  for(const m of moves){
    const {x,y} = squareToXY(m.to);
    const col = Math.round(x / SQ), row = Math.round(y / SQ);
    const cell = squares[row*8 + col];
    if(!cell) continue;
    const dot = document.createElement('div');
    dot.className = 'dot';
    cell.appendChild(dot);
  }
}

/* ----------------------------------------------------
   5) Animated makeMove (DOM sync + capture/fade/castle)
   ---------------------------------------------------- */
async function applyMoveAnimated(m){
  const moverEl = pieceDom.get(m.from);
  const moverPiece = state.board[m.from];

  // Determine captured piece element BEFORE changing the map
  let capIdx = -1;
  if(m.flags?.ep){
    capIdx = idx(file(m.to), rank(m.to) + (moverPiece[0]==='w' ? -1 : 1));
  } else if(m.flags?.capture){
    capIdx = m.to;
  }
  const capEl = capIdx >= 0 ? pieceDom.get(capIdx) : null;

  // Advance game state
  state = makeMove(state, m);

  // Update the index->node map in safe order
  pieceDom.delete(m.from);
  if(capIdx >= 0) pieceDom.delete(capIdx);
  pieceDom.set(m.to, moverEl);

  // Slide mover to target
  movePieceElementTo(moverEl, m.to, false);
  await waitMs(190);

  // Fade captured after the mover lands
  if(capEl){
    capEl.style.opacity = '0';
    await waitMs(120);
    capEl.remove();
  }

  // Animate rook during castling
  if(m.flags?.castle){
    const r = (moverPiece[0]==='w') ? 0 : 7;
    if(m.flags.castle === 'K'){
      const rookFrom = idx(7,r), rookTo = idx(5,r);
      const rookEl = pieceDom.get(rookFrom);
      if(rookEl){ pieceDom.delete(rookFrom); pieceDom.set(rookTo, rookEl); movePieceElementTo(rookEl, rookTo, false); }
    } else {
      const rookFrom = idx(0,r), rookTo = idx(3,r);
      const rookEl = pieceDom.get(rookFrom);
      if(rookEl){ pieceDom.delete(rookFrom); pieceDom.set(rookTo, rookEl); movePieceElementTo(rookEl, rookTo, false); }
    }
  }

  // Promotion glyph update (auto-queen)
  const landed = state.board[m.to];
  if(landed && landed[1] === 'Q'){
    const el = pieceDom.get(m.to);
    if(el) el.textContent = GLYPH[landed];
  }

  // Reconcile everything (also updates FEN + status)
  renderPieces();

  // If AI should move now, trigger it
  if(!gameOver(state)){
    const aiBlack = document.getElementById('aiPlaysBlack').checked;
    if( (state.turn==='b' && aiBlack) || (state.turn==='w' && !aiBlack) ){
      aiMove();
    }
  }
}

/* ----------------------------
   6) Status, endgame, and AI
   ---------------------------- */
function gameOver(s){
  const legal = genMoves(s);
  if(legal.length > 0) return false;

  const k = s.board.findIndex(p => p === s.turn + 'K');
  const check = isAttacked(k, opp(s.turn), s);
  statusEl.textContent = check
    ? (s.turn==='w' ? 'White' : 'Black') + ' is checkmated'
    : 'Stalemate';
  return true;
}

function updateStatus(){
  const k = state.board.findIndex(p => p === state.turn + 'K');
  const inCk = isAttacked(k, opp(state.turn), state);
  const base = `${state.turn==='w' ? 'White' : 'Black'} to move`;
  statusEl.textContent = inCk ? base + ' — check!' : base;
}

// Tiny evaluation + negamax(alpha-beta) for 1..4 ply
const INF = 1e9;
function evaluate(s){
  // Material
  let score = 0;
  for(let i=0; i<64; i++){
    const p = s.board[i]; if(!p) continue;
    score += (p[0]==='w' ? 1 : -1) * (VAL[p[1]] || 0);
  }
  // Mobility (very small nudge)
  const ms = genMoves(s).length;
  const s2 = cloneState(s); s2.turn = opp(s.turn);
  const mo = genMoves(s2).length;
  score += (s.turn==='w' ? 1 : -1) * (ms - mo) * 1.5;
  return score;
}
function evalStatic(s){ const e = evaluate(s); return s.turn==='w' ? e : -e; }
function orderMoves(moves,s){
  // Captures first (basic MVV/LVA-ish)
  const B=s.board;
  return moves.slice().sort((a,b)=>{
    const ca = a.flags?.capture ? (VAL[B[a.to]?.[1]||'P'] - VAL[B[a.from][1]]) : -1e6;
    const cb = b.flags?.capture ? (VAL[B[b.to]?.[1]||'P'] - VAL[B[b.from][1]]) : -1e6;
    return cb - ca;
  });
}
function negamax(s, depth, alpha, beta){
  if(depth === 0) return { score: evalStatic(s) };
  const moves = genMoves(s);
  if(moves.length === 0){
    const k = s.board.findIndex(p => p === s.turn + 'K');
    const inCheck = isAttacked(k, opp(s.turn), s);
    return { score: inCheck ? -INF : 0 };
  }
  let best = { score: -INF, move: null };
  for(const m of orderMoves(moves, s)){
    const s2 = makeMove(cloneState(s), m);
    const { score } = negamax(s2, depth-1, -beta, -alpha);
    const n = -score;
    if(n > best.score) best = { score: n, move: m };
    if(n > alpha) alpha = n;
    if(alpha >= beta) break; // cutoff
  }
  return best;
}

// Orchestrate an AI move based on the difficulty slider (0..4)
async function aiMove(){
  if(aiThinking) return;
  aiThinking = true;
  setStatus('AI thinking…');
  await flush();

  const depth = +document.getElementById('difficulty').value;
  const legal = genMoves(state);
  let chosen = null;

  if(depth === 0){
    // Random legal move
    chosen = legal[Math.floor(Math.random() * legal.length)];
  } else {
    // Depth-limited search
    let best = { score: -INF, move: null };
    let alpha = -INF, beta = INF;
    for(const m of orderMoves(legal, state)){
      const s2 = makeMove(cloneState(state), m);
      const { score } = negamax(s2, depth-1, -beta, -alpha);
      const n = -score;
      if(n > best.score) best = { score: n, move: m };
      if(n > alpha) alpha = n;
    }
    chosen = best.move ?? legal[0];
  }

  if(chosen) await applyMoveAnimated(chosen);
  aiThinking = false;
}

function setStatus(t){ statusEl.textContent = t; }
function waitMs(ms){ return new Promise(r => setTimeout(r, ms)); }
function flush(){ return new Promise(requestAnimationFrame); }

/* ----------------------------
   7) Input handling (clicks)
   ---------------------------- */
boardEl.addEventListener('click', (e)=>{
  if(aiThinking) return;

  // Translate click to visual cell
  const rect = boardEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let col = Math.floor(x / SQ);
  let visRow = Math.floor(y / SQ);
  if(col < 0 || col > 7 || visRow < 0 || visRow > 7) return;

  // Convert visual row/col to board file/rank under current perspective
  const f = perspectiveWhite ? col : (7 - col);
  const r = perspectiveWhite ? (7 - visRow) : visRow;
  const sq = idx(f,r);

  // Determine which side is human based on the checkbox
  const humanIsWhite = document.getElementById('aiPlaysBlack').checked; // AI black => human white
  const humanTurn = humanIsWhite ? 'w' : 'b';

  if(selected){
    // Try to complete a move if the clicked square is one of the targets
    const mv = selected.moves.find(m => m.to === sq);
    if(mv){
      selected = null; clearHighlights();
      applyMoveAnimated(mv);
      return;
    }
  }

  // Otherwise (re)select a piece if it's the human side's turn
  const p = state.board[sq];
  if(p && p[0] === state.turn && p[0] === humanTurn){
    const legal = genMoves(state).filter(m => m.from === sq);
    if(legal.length){
      selected = { from: sq, moves: legal };
      highlight(sq, legal);
    } else {
      selected = null; clearHighlights();
    }
  } else {
    selected = null; clearHighlights();
  }
});

/* ----------------------------
   8) Controls wiring
   ---------------------------- */
document.getElementById('newBtn').addEventListener('click', ()=>{
  state = startPosition();
  selected = null; clearHighlights(); renderPieces(); updateStatus();
});

document.getElementById('flipBtn').addEventListener('click', ()=>{
  perspectiveWhite = !perspectiveWhite;
  renderPieces(); // repositions everything
});

document.getElementById('difficulty').addEventListener('input', (e)=>{
  document.getElementById('diffLabel').textContent = e.target.value;
});

document.getElementById('loadFen').addEventListener('click', ()=>{
  try{
    state = fromFEN(document.getElementById('fenIn').value);
    selected = null; clearHighlights(); renderPieces();
  } catch(err){
    alert('Bad FEN: ' + err.message);
  }
});

document.getElementById('copyFen').addEventListener('click', async ()=>{
  try{
    await navigator.clipboard.writeText(toFEN(state));
    const btn = document.getElementById('copyFen');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy FEN', 900);
  } catch(_){}
});

document.getElementById('aiPlaysBlack').addEventListener('change', ()=>{
  const aiBlack = document.getElementById('aiPlaysBlack').checked;
  // If toggle puts AI on the side to move, make it play immediately
  if( (state.turn==='b' && aiBlack) || (state.turn==='w' && !aiBlack) ){
    aiMove();
  }
});

/* ----------------------------
   9) Boot the app
   ---------------------------- */
(function init(){
  buildBoardSquares();         // make the 8x8 grid
  state = startPosition();     // set initial pieces (black on top)
  renderPieces();              // draw pieces & FEN
  updateStatus();              // "White to move"
})();
