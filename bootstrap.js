const comparison = document.querySelector('#comparison');
const singleRun = document.querySelector('#single-run');
const runner = new URLSearchParams(location.search).get('runner');

if (runner === 'jev' || runner === 'openai') {
  document.body.classList.add('runner-mode', `runner-${runner}`);
  comparison.hidden = true;
  singleRun.hidden = false;
  await import('./game.js');
  if (window.parent !== window) {
    new ResizeObserver(() => window.parent.postMessage({
      type: 'runner-size', runner, height: Math.ceil(singleRun.getBoundingClientRect().height),
    }, location.origin)).observe(singleRun);
  }
} else {
  document.body.classList.add('comparison-mode');
  singleRun.hidden = true;
  comparison.hidden = false;
  document.title = 'Jev vs GPT-6 Luna | Flappy Arena';
  comparison.innerHTML = `
    <header class="masthead"><a class="wordmark" href="/" aria-label="Flappy Arena home"><span class="brand-icon">✦</span> FLAPPY<span>ARENA</span></a><span class="edition">THE MODEL MATCHUP / 001</span></header>
    <section class="comparison-header">
      <div><p class="eyebrow">TWO MODELS. ONE COURSE.</p><h1>Who flies <em>further?</em></h1><p class="intro">Jev vs GPT-6 Luna. Same pipes. Same physics. Let them fly.</p></div>
      <div class="match-controls"><button class="primary-button" id="start-both" disabled>Connecting…</button><span id="match-status" role="status">Getting both pilots ready</span></div>
    </section>
    <div class="match-strip"><span><i class="live-dot"></i> <span id="match-label">READY WHEN YOU ARE</span></span><span><span id="course-label">FRESH SHARED COURSE</span> <b>·</b> SHARED START</span></div>
    <div class="comparison-grid">
      <section class="comparison-lane jev-lane"><header class="lane-header"><div class="model-identity"><span class="model-icon">J</span><div><h2>Jev</h2><span>TypeSafe AI</span></div></div><span class="lane-tag">PLAYER 01</span></header><iframe title="Jev controlled Flappy Bird" src="?runner=jev"></iframe></section>
      <span class="versus" aria-hidden="true">VS</span>
      <section class="comparison-lane luna-lane"><header class="lane-header"><div class="model-identity"><span class="model-icon">✳</span><div><h2>GPT-6 Luna</h2><span>OpenAI</span></div></div><span class="lane-tag">PLAYER 02</span></header><iframe title="GPT-6 Luna controlled Flappy Bird" src="?runner=openai"></iframe></section>
    </div>
    <footer class="arena-footer"><span>A little bird. A big model matchup.</span><span>Direct FLAP / WAIT <b>·</b> Continuous physics · 50 ms model requests</span></footer>`;

  const frames = [...comparison.querySelectorAll('iframe')];
  const ready = new Set();
  const armed = new Set();
  const results = new Map();
  const startBoth = comparison.querySelector('#start-both');
  const status = comparison.querySelector('#match-status');
  const label = comparison.querySelector('#match-label');
  let matchId = null;
  let countdown;
  let launched = false;
  const send = (message) => frames.forEach((frame) => frame.contentWindow.postMessage(message, location.origin));
  window.addEventListener('message', (event) => {
    const index = frames.findIndex((frame) => frame.contentWindow === event.source);
    if (event.origin !== location.origin || index < 0) return;
    const data = event.data;
    if (data?.runner !== (index === 0 ? 'jev' : 'openai')) return;
    if (data.type === 'runner-size' && Number.isFinite(data.height)) {
      frames[index].style.height = `${Math.max(300, Math.min(1800, data.height))}px`;
    }
    if (data.type === 'runner-ready') {
      ready.add(data.runner);
      if (ready.size === 2 && !matchId) {
        startBoth.disabled = false;
        startBoth.textContent = 'Start the matchup ↗';
        status.textContent = 'Both pilots ready. Your call.';
      }
    }
    if (!matchId || data.matchId !== matchId) return;
    if (data.type === 'runner-error') {
      status.textContent = `${index === 0 ? 'Jev' : 'Luna'}: ${data.error}`;
      startBoth.textContent = 'Restart matchup ↗';
    }
    if (data.type === 'runner-armed' && !launched) {
      armed.add(data.runner);
      status.textContent = `${armed.size}/2 connections warmed up`;
      if (armed.size === 2) {
        launched = true;
        const launchAt = Date.now() + 3200;
        send({ type: 'comparison-launch', matchId, launchAt });
        const tick = () => {
          const remaining = Math.ceil((launchAt - Date.now()) / 1000);
          label.textContent = remaining > 0 ? `TAKEOFF IN ${Math.min(3, remaining)}` : 'LIVE / CONTINUOUS PHYSICS';
          if (remaining <= 0) {
            clearInterval(countdown);
            startBoth.textContent = 'Restart matchup ↗';
            status.textContent = 'Model decisions only. No fallback flaps.';
          }
        };
        tick();
        countdown = setInterval(tick, 100);
      }
    }
    if (data.type === 'runner-state' && data.phase === 'gameover') {
      results.set(data.runner, data.score);
      if (results.size === 2) {
        clearInterval(countdown);
        const jev = results.get('jev');
        const luna = results.get('openai');
        label.textContent = jev === luna ? 'MATCH COMPLETE / TIE' : `MATCH COMPLETE / ${jev > luna ? 'JEV' : 'LUNA'} WINS`;
        status.textContent = `${jev} : ${luna} pipes cleared`;
      }
    }
  });
  startBoth.addEventListener('click', () => {
    clearInterval(countdown);
    launched = false;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    comparison.querySelector('#course-label').textContent = `COURSE ${seed.toString(16).toUpperCase().padStart(8, '0')}`;
    matchId = crypto.randomUUID();
    armed.clear();
    results.clear();
    label.textContent = 'WARMING MODEL CONNECTIONS';
    status.textContent = 'Preparing both pilots before takeoff';
    startBoth.textContent = 'Restart matchup ↗';
    send({ type: 'comparison-prepare', matchId, seed });
  });
}
