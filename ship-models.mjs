/** Layered armor planes, engine nacelles and cockpits sampled into the shared palette. */
function inside(x, y, points) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}
export function modelRows(name) {
  const hero = name.startsWith('aegis'), boss = name === 'mothership';
  const scout = name === 'scoutDrone', unknown = name === 'unknown';
  const miner = name === 'minelayer', wing = name === 'wingDrone';
  const w = hero ? 44 : boss ? 48 : scout ? 20 : unknown ? 12 : 30;
  const h = hero ? 44 : boss ? 36 : scout ? 18 : unknown ? 12 : 26;
  const pixels = Array.from({ length: h }, () => Array(w).fill('.'));
  const face = (color, polygon) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (inside((x + .5) / w, (y + .5) / h, polygon)) pixels[y][x] = color;
    }
  };
  const rect = (color,x,y,width,height) => face(color, [[x,y],[x+width,y],[x+width,y+height],[x,y+height]]);
  if (unknown) {
    face('A', [[.5,.1],[.9,.5],[.5,.9],[.1,.5]]);
    face('G', [[.5,.25],[.75,.5],[.5,.75],[.25,.5]]);
    rect('W', .46,.33,.08,.25);
    return pixels.map(row => row.join(''));
  }
  const light = hero ? 'H' : boss || wing ? 'n' : 'Z';
  const mid = hero ? 'h' : boss || wing ? 'N' : 'z';
  const dark = hero ? 'G' : boss || wing ? 'o' : 'u';
  const core = hero ? 'e' : 'V', glow = hero ? 'C' : 'v';
  const poly = (color,points) => face(color,points.map(([x,y]) => [hero ? 1-x : x,y]));
  const box = (color,x,y,width,height) => rect(color,hero ? 1-x-width : x,y,width,height);
  poly('k', [[.13,.5],[.44,.13],[.83,.06],[.94,.21],[.82,.39],[.92,.5],[.82,.61],[.94,.79],[.83,.94],[.44,.87]]);
  poly(dark, [[.19,.51],[.48,.18],[.84,.11],[.89,.22],[.74,.43],[.86,.5],[.74,.57],[.89,.78],[.84,.89],[.48,.82]]);
  poly(light, [[.19,.47],[.49,.2],[.82,.13],[.69,.37],[.49,.48]]);
  poly(mid, [[.2,.5],[.49,.28],[.73,.35],[.83,.5],[.72,.65],[.49,.73]]);
  poly(dark, [[.2,.53],[.5,.52],[.72,.65],[.85,.84],[.49,.78]]);
  poly(light, [[.08,.48],[.48,.36],[.72,.43],[.78,.5],[.47,.55]]);
  poly(mid, [[.08,.51],[.47,.55],[.78,.5],[.72,.59],[.44,.65]]);
  for (const y of [.19,.72]) {
    box('k',.62,y,.32,.10); box(mid,.64,y,.25,.065);
    box(glow,.87,y+.015,.065,.055); box(core,.87,y+.027,.025,.03);
  }
  poly('k', [[.29,.47],[.44,.42],[.58,.45],[.58,.53],[.4,.56]]);
  poly(core, [[.31,.47],[.44,.45],[.54,.47],[.45,.52],[.33,.52]]);
  box(dark,.64,.42,.055,.16); box(light,.63,.43,.02,.10); box(glow,.74,.47,.08,.06);
  if (boss) {
    for (const y of [.32,.6]) { box('k',.51,y,.25,.065); box('n',.53,y,.15,.025); box('V',.69,y,.035,.035); }
    box('V',.82,.41,.045,.19);
  }
  if (miner) for (const y of [.27,.64]) { box('y',.55,y,.13,.09); box('W',.57,y,.03,.03); }
  if (scout) box('V',.57,.45,.10,.08);
  if (hero) {
    rect('G',.65,.46,.26,.10); rect('H',.65,.46,.20,.035);
    rect(name === 'aegisStrike' ? 'W' : 'Y',.86,.46,.08,.07);
    if (name === 'aegisWind') rect('e',.78,.39,.08,.07);
    if (name === 'aegisStrike') rect('W',.94,.45,.06,.09);
  }
  return pixels.map(row => row.join(''));
}
