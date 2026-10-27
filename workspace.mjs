const $ = id => document.getElementById(id);
const duration = ms => !Number.isFinite(ms) ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`;
const time = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

export function mountWorkspace(engine) {
  let backend = null;
  let serverAvailable = false;
  let lastVersion = -1;
  let statusBusy = false;
  let disposed = false;
  let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const set = (id, value) => { const el = $(id); if (el && el.textContent !== String(value)) el.textContent = value; };
  function notice(message = '') {
    $('appNotice').hidden = !message;
    set('appNotice', message);
  }
  async function api(path, options) {
    const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || `请求失败 (${res.status})`);
    return value;
  }
  async function refreshSessions() {
    $('refreshSessions').disabled = true;
    try {
      const { sessions } = await api('/api/sessions');
      const selected = backend?.source?.id || $('sessionSelect').value;
      $('sessionSelect').replaceChildren();
      if (!sessions.length) {
        const option = new Option('尚未发现 Codex 会话', '');
        $('sessionSelect').append(option);
      }
      for (const session of sessions) {
        const project = session.cwd?.split(/[\\/]/).filter(Boolean).pop() || '本机会话';
        const option = new Option(`${project} · ${session.title}`, session.id);
        option.selected = session.id === selected;
        option.title = session.title;
        $('sessionSelect').append(option);
      }
    } catch {
      if (!serverAvailable) $('sessionSelect').replaceChildren(new Option('使用 npm start 启用自动接入', ''));
      else notice('会话列表刷新失败，当前事件源继续运行。');
    } finally { $('refreshSessions').disabled = false; }
  }
  function connect() {
    if (!serverAvailable) {
      notice('当前是静态预览。请在项目目录运行 npm start，即可自动发现并连接本机 Codex 会话。');
      $('importDetails').open = true;
      return;
    }
    if (!backend?.source) { notice('尚未发现可连接的 Codex 会话。启动一个 Codex 聊天后刷新会话列表。'); return; }
    if (backend.error) { notice(backend.error + '。请在列表中重新选择会话恢复读取。'); return; }
    notice();
    engine.connectHook(location.origin);
  }
  function openSource() {
    $('startPanel').classList.remove('hidden');
    $('liveConnect').focus();
  }
  $('liveConnect').addEventListener('click', connect);
  $('openSourceButton').addEventListener('click', openSource);
  $('sourceNav').addEventListener('click', openSource);
  $('battleNav').addEventListener('click', () => {
    if (engine.workspace().playing) $('startPanel').classList.add('hidden');
    $('stage').scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
  });
  $('refreshSessions').addEventListener('click', refreshSessions);
  $('sessionSelect').addEventListener('change', async () => {
    const id = $('sessionSelect').value;
    if (!id) return;
    $('sessionSelect').disabled = true;
    try {
      backend = await api('/api/session', { method: 'POST', body: JSON.stringify({ id }) });
      connect();
    } catch (err) { notice(`切换失败：${err.message}`); $('sessionSelect').value = backend?.source?.id || ''; }
    finally { $('sessionSelect').disabled = false; }
  });
  $('pauseButton').addEventListener('click', () => engine.pause());
  function applyMotion() {
    engine.motion(reduced);
    document.body.classList.toggle('reduced-motion', reduced);
    $('motionButton').setAttribute('aria-pressed', String(reduced));
    $('motionButton').textContent = reduced ? '柔和特效 ✓' : '柔和特效';
  }
  applyMotion();
  $('motionButton').addEventListener('click', () => { reduced = !reduced; applyMotion(); });
  $('helpNav').addEventListener('click', () => $('helpDialog').showModal());
  $('closeHelp').addEventListener('click', () => $('helpDialog').close());
  $('helpDialog').addEventListener('click', e => { if (e.target === $('helpDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && engine.workspace().playing) $('startPanel').classList.add('hidden');
  });

  function renderActivity(state) {
    if (state.activityVersion === lastVersion) return;
    lastVersion = state.activityVersion;
    set('activityCount', state.stats.seen);
    const fragment = document.createDocumentFragment();
    if (!state.activity.length) {
      const empty = document.createElement('div');
      empty.className = 'activity-empty';
      const mark = document.createElement('span'); mark.textContent = '⌁';
      const title = document.createElement('strong'); title.textContent = '等待第一条真实事件';
      const hint = document.createElement('p'); hint.textContent = '调用名称、结果和耗时会记录在这里。';
      empty.append(mark, title, hint); fragment.append(empty);
    }
    for (const item of state.activity) {
      const row = document.createElement('div'); row.className = 'activity-row';
      const icon = document.createElement('span'); icon.className = `activity-icon ${item.status}`;
      icon.textContent = item.status === 'running' ? '↗' : item.status === 'failed' ? '×' : '✓';
      const body = document.createElement('div');
      const name = document.createElement('div'); name.className = 'activity-name'; name.textContent = item.tool; name.title = item.tool;
      const meta = document.createElement('span'); meta.className = 'activity-meta';
      meta.textContent = `${time(item.ts)} · ${item.status === 'running' ? '执行中' : item.status === 'failed' ? '执行失败' : '执行成功'}`;
      body.append(name, meta);
      const elapsed = document.createElement('span'); elapsed.className = 'activity-time'; elapsed.textContent = duration(item.realMs);
      row.append(icon, body, elapsed); fragment.append(row);
    }
    $('activityList').replaceChildren(fragment);
  }
  function render() {
    if (disposed) return;
    const state = engine.workspace();
    state.stats = engine.stats();
    const s = state.stats;
    set('metricTotal', s.seen);
    set('metricActive', s.alive);
    set('metricSuccess', s.kills);
    set('metricDuration', state.durationSamples ? duration(state.actualDuration) : '—');
    const replay = !state.live && (state.playing || s.seen > 0);
    set('metricSource', state.live ? '当前连接已接收的真实调用（含恢复）' : replay ? `${state.meta.tools} 次调用的历史回放` : '等待真实事件');
    set('metricActiveHint', state.live ? '完成记录接入 · 不含尚未完成的调用' : '以事件开始与结束为准');
    set('metricSuccessHint', s.failures ? `${s.failures} 次失败 · 未计入成功` : s.seen ? `${s.seen - s.kills} 次尚未成功结算` : '尚无已完成调用');
    set('metricDurationHint', state.durationSamples ? `${state.durationSamples} 次含耗时记录 · 非会话总时长` : '仅统计日志中的真实耗时');
    const online = state.connection === 'online' && !backend?.error;
    const text = state.live ? state.paused ? '已暂停 · 持续接收' : online ? '实况已连接' : state.connection === 'error' ? '连接需恢复' : '正在重连' : replay ? state.paused ? '回放已暂停' : state.playing ? '历史回放' : '回放已结束' : '等待连接';
    const badge = $('connectionBadge'); badge.classList.toggle('online', online && state.live); badge.classList.toggle('error', state.live && (state.connection === 'error' || !!backend?.error)); badge.lastElementChild.textContent = text;
    set('modeBadge', state.live ? state.paused ? `已暂停 · 缓冲 ${state.pending}` : 'LIVE / 完成后同步' : replay ? state.playing ? 'REPLAY / 3×' : 'REPLAY / 已结束' : '待机');
    $('modeBadge').classList.toggle('live', state.live && online);
    $('pauseButton').disabled = !state.playing;
    set('pauseButton', state.paused ? '继续' : '暂停');
    $('sourceLight').classList.toggle('online', online && state.live);
    set('sourceKind', state.live ? 'CODEX / LOCAL' : replay ? 'REPLAY' : 'LOCAL');
    set('sourceName', state.live ? backend?.source?.cwd?.split(/[\\/]/).filter(Boolean).pop() || '本地事件源' : replay ? '历史会话回放' : 'Codex 会话');
    set('sourceSubtitle', state.live ? backend?.source?.id?.slice(-19, -6) || 'HTTP 事件通道' : replay ? state.label.replace('样本：', '') : '等待连接');
    set('syncMode', state.live ? '工具完成后同步' : replay ? '历史事件 · 3 倍速' : '工具完成后同步');
    set('sourceIssues', `${(backend?.reader?.issues || 0) + state.wireIssues} / ${s.unmapped}`);
    set('lastEventTime', state.live && backend?.lastEventAt ? time(backend.lastEventAt) : state.activity[0] ? time(state.activity[0].ts) : '尚未收到');
    set('sourceCaption', state.live ? backend?.error || (backend?.reader?.issues ? `有 ${backend.reader.issues} 条记录缺少必要字段，已跳过。` : '自动读取所选会话的新记录。仅同步调用名称、结果与时间，不传输对话正文。') : '样本回放与实况使用独立状态。切回实况后继续接收所选会话的新记录。');
    const idle = state.live && s.alive === 0 && !state.paused && $('startPanel').classList.contains('hidden');
    $('idleState').hidden = !idle;
    set('idleTitle', backend?.error ? '日志读取已停止' : !online ? '正在恢复事件连接' : '航道巡逻中，等待任务敌舰');
    set('idleHint', backend?.error || '任务完成后自动同步 · 环境飞弹不计任务战绩');
    set('renderFps', `${state.fps} FPS`);
    $('pilotHp').value = state.pilot.hp;
    set('pilotHpText', `${state.pilot.hp} / ${state.pilot.maxHp}`);
    set('pilotState', state.paused ? '飞行已暂停' : state.pilot.hit ? '护盾受击 · 保护中' : state.dodging ? '自动规避' : '自动巡航');
    renderActivity(state);
  }
  async function pollStatus() {
    if (statusBusy || disposed) return;
    statusBusy = true;
    try {
      const previousId = backend?.source?.id;
      const hadError = !!backend?.error;
      backend = await api('/api/status');
      serverAvailable = true;
      if (previousId && previousId !== backend.source?.id && engine.workspace().live) engine.connectHook(location.origin);
      if (hadError && !backend.error) notice();
      if (backend.error && engine.workspace().live) notice(backend.error + '。请选择会话以重新连接。');
    } catch {
      if (serverAvailable && engine.workspace().live) notice('本地服务暂时不可用，已保留当前画面。服务恢复后将自动重连。');
    } finally { statusBusy = false; }
  }
  const renderTimer = setInterval(render, 250);
  const statusTimer = setInterval(pollStatus, 2000);
  const observer = new ResizeObserver(() => window.dispatchEvent(new Event('resize')));
  observer.observe($('stage'));
  window.addEventListener('pagehide', () => { disposed = true; clearInterval(renderTimer); clearInterval(statusTimer); observer.disconnect(); }, { once: true });
  void (async () => {
    await pollStatus();
    await refreshSessions();
    if (backend?.source) connect();
    render();
  })();
}
