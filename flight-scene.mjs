/** Pilot combat is presentation state. Only real events settle task enemies. */
export class FlightScene {
  constructor() { this.reset(); }
  reset() {
    this.time=0; this.phase=0; this.missiles=[]; this.shots=[]; this.effects=[];
    this.hero={x:0,y:155,bank:0}; this.sequence=0;
    this.spawnClock=.3; this.fireClock=0; this.dodging=false;
    this.hp=100; this.maxHp=100; this.invulnerableUntil=0; this.hits=0;
  }
  damage(amount) {
    if(this.time<this.invulnerableUntil) return false;
    const before=this.hp;
    this.hp=Math.max(1,this.hp-amount); this.hits++;
    this.invulnerableUntil=this.time+.65;
    this.effects.push({x:this.hero.x,y:this.hero.y,age:0,kind:'hit',text:this.hp===1?'锁血保护':`−${before-this.hp}`});
    return true;
  }
  heal(kills=1) {
    const gained=Math.min(this.maxHp-this.hp,kills*12);
    this.hp+=gained;
    this.effects.push({x:this.hero.x,y:this.hero.y,age:0,kind:'heal',text:gained?`+${gained} HP`:'补给充足'});
    return gained;
  }
  place(enemy) {
    if(enemy.flight) return;
    const lane=this.sequence++;
    const x=Math.sin(lane*2.399963)*170;
    enemy.flight={x,y:enemy.tier===2?-175:-190+(lane%3)*48,phase:lane*1.7,entered:0,hull:1,fireClock:.8};
    enemy.x=x; enemy.y=-210+(lane%3)*38;
  }
  advance(dt,enemies) {
    if(dt<=0) return this.hero;
    this.time+=dt; this.phase+=dt*34;
    for(const e of this.effects) e.age+=dt;
    this.effects=this.effects.filter(e=>e.age<.9);
    const oldHero={...this.hero};
    this.spawnClock-=dt;
    if(this.spawnClock<=0) {
      this.spawnClock=1.4;
      const n=this.sequence+Math.floor(this.time/1.4);
      for(let i=-1;i<=1;i++) this.missiles.push({
        x:Math.max(-205,Math.min(205,this.hero.x+i*54+Math.sin(n*2.3)*34)),
        y:-285-Math.abs(i)*30,vx:Math.sin(n+i)*6,speed:92+n%3*12,warning:.5,age:0});
    }
    for(const m of this.missiles) {
      m.px=m.x; m.py=m.y; m.age+=dt;
      if(m.warning>0) m.warning-=dt;
      else {m.x+=m.vx*dt;m.y+=m.speed*dt;}
    }
    let avoidance=0;
    for(const m of this.missiles) {
      if(m.y< -55||m.y>this.hero.y+38) continue;
      const dx=this.hero.x-(m.x+m.vx*Math.max(0,(this.hero.y-m.y)/m.speed));
      if(Math.abs(dx)<63) avoidance+=(dx>=0?1:-1)*(63-Math.abs(dx))*3;
    }
    this.dodging=Math.abs(avoidance)>8;
    const desired=Math.max(-178,Math.min(178,Math.sin(this.time*.42)*115+avoidance));
    const step=(this.dodging?160:70)*dt;
    this.hero.x+=Math.max(-step,Math.min(step,desired-this.hero.x));
    this.hero.y=155+Math.sin(this.time*.9)*9;
    this.hero.bank+=((this.hero.x-oldHero.x)/dt/600-this.hero.bank)*Math.min(1,dt*8);
    for(const m of this.missiles) {
      if(m.warning>0) continue;
      if(segmentDistance(m.px-oldHero.x,m.py-oldHero.y,m.x-this.hero.x,m.y-this.hero.y,0,0)<17) {
        this.damage(m.boss?18:10);m.y=999;
      }
    }
    this.missiles=this.missiles.filter(m=>m.y<315);
    for(const enemy of enemies) {
      this.place(enemy);
      const f=enemy.flight;
      if(enemy.diedAt!==null) continue;
      f.entered=Math.min(1,f.entered+dt*1.6);
      const ease=1-Math.pow(1-f.entered,3);
      enemy.x=f.x+Math.sin(this.time*.7+f.phase)*16;
      enemy.y=-260+(f.y+260)*ease+Math.sin(this.time+f.phase)*5;
      if(enemy.tier===2) {
        f.fireClock-=dt;
        if(f.fireClock<=0) {
          f.fireClock=1.15;
          const angle=Math.atan2(this.hero.y-enemy.y,this.hero.x-enemy.x);
          for(const spread of [-.18,0,.18]) this.missiles.push({x:enemy.x,y:enemy.y+20,
            vx:Math.cos(angle+spread)*155,speed:Math.sin(angle+spread)*155,warning:0,age:0,boss:true});
        }
      }
    }
    this.fireClock-=dt;
    const targets=enemies.filter(e=>e.diedAt===null||e.deathT<.65);
    if(targets.length&&this.fireClock<=0) {
      this.fireClock=.16;
      const target=targets[Math.floor(this.time*7)%targets.length];
      for(const side of [-1,1]) {
        const x=this.hero.x+side*11,y=this.hero.y-23;
        const dx=target.x-x,dy=target.y-y,len=Math.hypot(dx,dy)||1;
        this.shots.push({x,y,vx:dx/len*700,vy:dy/len*700,age:0,target});
      }
    }
    for(const s of this.shots) {
      const px=s.x,py=s.y;
      s.x+=s.vx*dt;s.y+=s.vy*dt;s.age+=dt;
      if(s.target.diedAt===null&&segmentDistance(px,py,s.x,s.y,s.target.x,s.target.y)<22) {
        if(s.target.tier===2) s.target.flight.hull=Math.max(.05,s.target.flight.hull-.003);
        this.effects.push({x:s.target.x,y:s.target.y+14,kind:'spark',age:0});s.age=1;
      }
    }
    this.shots=this.shots.filter(s=>s.age<.7&&s.y> -290);
    return this.hero;
  }
}
function segmentDistance(ax,ay,bx,by,x,y) {
  const dx=bx-ax,dy=by-ay;
  const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(ax+t*dx-x,ay+t*dy-y);
}
