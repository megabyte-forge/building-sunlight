'use strict';
const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const colors = {sun:'#389b58', building:'#df4949', terrain:'#f6c445', back:'#9ca6b3', night:'#293445'};
const textColors = {...colors, terrain:'#8a5c00', back:'#59616c'};
const names = {sun:'직사광 도달', building:'건물 차폐', terrain:'지형 차폐', back:'창 뒤편', night:'태양이 지평선 아래'};
const fmt = (value, digits=2) => Number(Number(value).toFixed(digits)).toString();
const time = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const duration = m => `${Math.floor(m/60)}시간 ${m%60}분`;
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const degrees = a => a*Math.PI/180;
let scene, initialScene, selected=null, day=today(), minute=360, result=null;
let revision=0, calculationTimer, calculating=false, dirty=false, paused=true, playTimer;
let undoStack=[], redoStack=[], committing=false, drag=null, placement=null;
let view={x:-80,y:40,span:160};
let requestId=0;
const waiting=new Map(), worker=new Worker('worker.js');
worker.onmessage=({data})=>{const item=waiting.get(data.id);if(!item)return;waiting.delete(data.id);data.error?item.reject(new Error(data.error)):item.resolve(data.result);};
worker.onerror=event=>{for(const item of waiting.values())item.reject(new Error(event.message||'계산 엔진을 불러오지 못했습니다. 새로고침해 주세요.'));waiting.clear();};
function rpc(action,values={}){return new Promise((resolve,reject)=>{const id=++requestId;waiting.set(id,{resolve,reject});worker.postMessage({id,request:{action,...values}});});}
function message(error=''){ $('error').textContent=String(error?.message||error).replace(/^PythonError:\s*/,''); }
function svg(tag,attrs={},text){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);if(text!==undefined)node.textContent=text;return node;}
function draw(parent,tag,attrs,text){const node=svg(tag,attrs,text);parent.append(node);return node;}
function bounds(poly){const xs=poly.map(p=>p[0]),ys=poly.map(p=>p[1]);return {x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys),y1:Math.max(...ys)};}
function center(building){const b=bounds(building.footprint);return [(b.x0+b.x1)/2,(b.y0+b.y1)/2];}
function target(s=scene){return s.buildings[s.observer_building];}
function inside(x,y,poly){let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function snap(s,x,y){
 const poly=target(s).footprint;let area=0,best=null;
 poly.forEach((a,i)=>{const b=poly[(i+1)%poly.length];area+=a[0]*b[1]-b[0]*a[1];});
 poly.forEach((a,i)=>{const b=poly[(i+1)%poly.length],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);if(len<1e-7)return;
  const margin=Math.min(.101/len,.5),t=Math.max(margin,Math.min(1-margin,((x-a[0])*dx+(y-a[1])*dy)/len**2));
  const nx=(area>0?dy:-dy)/len,ny=(area>0?-dx:dx)/len,px=a[0]+t*dx+.1*nx,py=a[1]+t*dy+.1*ny,d=(px-x)**2+(py-y)**2;
  if(!inside(px,py,poly)&&(!best||d<best.d))best={d,px,py,nx,ny};
 });
 if(!best)throw new Error('관측점을 놓을 외벽이 없습니다.');
 s.observer[0]=best.px;s.observer[1]=best.py;s.facing=(Math.atan2(best.nx,best.ny)*180/Math.PI+360)%360;
}
function translate(s,index,dx,dy){s.buildings[index].footprint=s.buildings[index].footprint.map(([x,y])=>[x+dx,y+dy]);if(index===s.observer_building){s.observer[0]+=dx;s.observer[1]+=dy;}}
function groundAt(s,x,y){let z=null;for(const [a,b,c]of s.terrain){const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-7)continue;const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den,v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den;if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)z=Math.max(z??-Infinity,u*a[2]+v*b[2]+(1-u-v)*c[2]);}return z;}
function stop(){paused=true;clearInterval(playTimer);$('play').textContent='▶ 재생';}
function invalidate(delay=350){stop();revision++;result=null;dirty=true;message();render();clearTimeout(calculationTimer);calculationTimer=setTimeout(calculate,delay);}
async function calculate(){
 if(calculating||!dirty)return;dirty=false;calculating=true;const version=revision;
 $('summary').textContent='일조시간을 계산하는 중입니다…';
 try{const next=await rpc('calculate',{scene:clone(scene),day,buildings:$('buildings').checked,terrain:$('terrain').checked});if(version===revision){result=next;if(!Number.isFinite(minute))minute=next.daylight?.[0]??300;render();}}
 catch(error){if(version===revision){message(error);$('summary').textContent='입력값을 확인해 주세요.';}}
 finally{calculating=false;if(dirty)calculate();}
}
async function commit(next){
 if(committing)throw new Error('직전 변경을 반영하는 중입니다. 잠시 후 다시 시도하세요.');
 committing=true;
 try{await rpc('validate',{scene:next});undoStack.push(clone(scene));if(undoStack.length>10)undoStack.shift();redoStack=[];scene=next;invalidate();}
 finally{committing=false;}
}
function history(redo=false){if(committing||drag)return;const from=redo?redoStack:undoStack,to=redo?undoStack:redoStack;if(!from.length)return;to.push(clone(scene));scene=from.pop();selected=null;invalidate();}
function mapPoint([x,y]){return [(x-view.x)/view.span*400,(view.y-y)/view.span*400];}
function clientPoint(event,node){const p=node.createSVGPoint();p.x=event.clientX;p.y=event.clientY;return p.matrixTransform(node.getScreenCTM().inverse());}
function worldPoint(event){const p=clientPoint(event,$('map'));return [view.x+p.x/400*view.span,view.y-p.y/400*view.span];}
function polygon(parent,poly,attrs){return draw(parent,'polygon',{points:poly.map(p=>p.join(',')).join(' '),...attrs});}
function intersects(a,b,pad=2){return a.x<b.x+b.w+pad&&a.x+a.w+pad>b.x&&a.y<b.y+b.h+pad&&a.y+a.h+pad>b.y;}
function drawMap(){
 if(!scene)return;const map=$('map');map.replaceChildren();const row=result?.rows[minute];
 for(const tri of scene.terrain){const z=tri.reduce((sum,p)=>sum+p[2],0)/3;if(z>target().base_z+.01)polygon(map,tri.map(mapPoint),{fill:'#47734a',opacity:Math.min(.6,.13+z/200)});}
 const firstX=Math.ceil(view.x/20)*20,firstY=Math.ceil((view.y-view.span)/20)*20;
 for(let x=firstX;x<=view.x+view.span;x+=20){const px=mapPoint([x,0])[0];draw(map,'line',{x1:px,y1:0,x2:px,y2:400,stroke:'#b6c7bc','stroke-width':.7});}
 for(let y=firstY;y<=view.y;y+=20){const py=mapPoint([0,y])[1];draw(map,'line',{x1:0,y1:py,x2:400,y2:py,stroke:'#b6c7bc','stroke-width':.7});}
 const tc=center(target()),pixelBuildings=scene.buildings.map(b=>{const ps=b.footprint.map(mapPoint),bb=bounds(ps);return {x:bb.x0,y:bb.y0,w:bb.x1-bb.x0,h:bb.y1-bb.y0};});
 if(row?.altitude>1){const az=degrees(row.azimuth),k=1/Math.tan(degrees(row.altitude));for(const b of scene.buildings){const shift=[-Math.sin(az)*b.height*k,-Math.cos(az)*b.height*k];b.footprint.forEach((a,i)=>{const c=b.footprint[(i+1)%b.footprint.length];polygon(map,[a,c,[c[0]+shift[0],c[1]+shift[1]],[a[0]+shift[0],a[1]+shift[1]]].map(mapPoint),{fill:'#59666d',opacity:.12});});}}
 for(let i=0;i<scene.buildings.length;i++){const b=scene.buildings[i];if(i!==scene.observer_building){const a=mapPoint(tc),p=mapPoint(center(b));draw(map,'line',{x1:a[0],y1:a[1],x2:p[0],y2:p[1],stroke:'#82919b','stroke-width':.8,'stroke-dasharray':'3 4'});}polygon(map,b.footprint.map(mapPoint),{fill:i===scene.observer_building?(colors[row?.state]||'#389b58'):i===selected?'#dda34d':'#8293a4',stroke:i===selected?'#163e65':'#425362','stroke-width':1.7,'fill-opacity':i===scene.observer_building?.75:1,'data-building':i});}
 const op=mapPoint(scene.observer);
 if(row?.altitude>0){const a=degrees(row.azimuth),end=[op[0]+90*Math.sin(a),op[1]-90*Math.cos(a)];for(const [stroke,width]of [['white',6],['#e49b00',3]])draw(map,'line',{x1:end[0],y1:end[1],x2:op[0],y2:op[1],stroke,'stroke-width':width});const dx=(end[0]-op[0])/90,dy=(end[1]-op[1])/90;polygon(map,[[op[0],op[1]],[op[0]+dx*11-dy*5,op[1]+dy*11+dx*5],[op[0]+dx*11+dy*5,op[1]+dy*11-dx*5]],{fill:'#e49b00',stroke:'white','stroke-width':1});draw(map,'text',{x:end[0],y:end[1]-7,fill:'#936000','font-size':12,'text-anchor':'middle',stroke:'white','stroke-width':4,'paint-order':'stroke'},'태양');}
 const used=[];const indices=[scene.observer_building,...scene.buildings.map((_,i)=>i).filter(i=>i!==scene.observer_building)];
 for(const i of indices){const b=scene.buildings[i],box=pixelBuildings[i],isTarget=i===scene.observer_building,bc=center(b),xy=isTarget?scene.observer:[bc[0],bc[1]],dx=xy[0]-tc[0],dy=xy[1]-tc[1],w=isTarget?146:104,h=isTarget?68:50;
  const options=[{x:box.x+box.w/2-w/2,y:box.y-h-7},{x:box.x+box.w+6,y:box.y},{x:box.x-w-6,y:box.y},{x:box.x+box.w/2-w/2,y:box.y+box.h+7}];
  if(!isTarget)options.unshift(options.pop());
  for(let d=20;d<=100;d+=20)options.push({x:box.x+box.w/2-w/2,y:box.y-h-7-d});
  const candidates=options.map(p=>({x:Math.max(2,Math.min(398-w,p.x)),y:Math.max(2,Math.min(398-h,p.y)),w,h}));
  const chosen=candidates.find(r=>!pixelBuildings.some(p=>intersects(r,p))&&!used.some(p=>intersects(r,p)));
  if(!chosen)continue;used.push(chosen);const {x,y}=chosen,g=draw(map,'g',{'pointer-events':'none'});
  draw(g,'rect',{x,y,width:w,height:h,fill:'white','fill-opacity':.94,stroke:'#b6c5d5','stroke-width':.7});let yy=y+14;
  if(isTarget){draw(g,'text',{x:x+5,y:yy,'font-size':12,fill:'#19496c'},'[거주 건물]');yy+=15;}
  draw(g,'text',{x:x+5,y:yy,'font-size':12,fill:'#19496c'},`${isTarget?'높이 ':''}${fmt(b.height)}m`);
  [[`${isTarget?'관측점 ':''}X ${dx<0?'서':'동'}`,Math.abs(dx)],[`${isTarget?'관측점 ':''}Y ${dy>0?'북':'남'}`,Math.abs(dy)]].forEach(([prefix,value],j)=>{const yv=yy+15+j*13,parts=value.toFixed(2).split('.'),fraction=parts[1].replace(/0+$/,'');draw(g,'text',{x:x+4,y:yv,'font-size':10,fill:'#728899'},prefix);draw(g,'text',{x:x+w-42,y:yv,'font-size':10,'text-anchor':'end',fill:'#728899'},parts[0]);draw(g,'text',{x:x+w-42,y:yv,'font-size':10,fill:'#728899'},fraction?'.'+fraction:'');draw(g,'text',{x:x+w-3,y:yv,'font-size':10,'text-anchor':'end',fill:'#728899'},'(m)');});
 }
 draw(map,'circle',{cx:op[0],cy:op[1],r:5.5,fill:'white',stroke:'#087dd1','stroke-width':2,'data-observer':'true'});
 draw(map,'text',{x:5,y:394,fill:'#74868e','font-size':10,'pointer-events':'none'},'진한 녹색: 높은 지형 · 회색: 참고용 건물 그림자');
}
function drawSpec(){const b=scene?.buildings[selected];$('buildingTitle').textContent=b?b.name:'건물을 선택하세요';$('editSelected').disabled=!b;const table=$('spec');table.replaceChildren();const c=b?center(b):[0,0],t=scene?center(target()):[0,0],bb=b?bounds(b.footprint):{};
 const rows=[['중심 X',b?fmt(Math.abs(c[0]-t[0]),3):'—',c[0]<t[0]?'서':'동'],['중심 Y',b?fmt(Math.abs(c[1]-t[1]),3):'—',c[1]>t[1]?'북':'남'],['기초 표고 Z',b?fmt(b.base_z,3):'—'],['건물 높이',b?fmt(b.height,3):'—'],['지붕 표고',b?fmt(b.base_z+b.height,3):'—'],['동서 폭',b?fmt(bb.x1-bb.x0,3):'—'],['남북 길이',b?fmt(bb.y1-bb.y0,3):'—']];
 for(const [label,value,dir]of rows){const tr=table.insertRow();tr.insertCell().textContent=label;const td=tr.insertCell();if(b&&dir){const span=document.createElement('span');span.className='dir';span.textContent=dir;td.append(span);}td.append(document.createTextNode(value));}}
function drawSky(){const sky=$('sky');sky.replaceChildren();const rows=result?.rows.filter(r=>r.altitude>=0)||[],peak=rows.length?Math.max(...rows.map(r=>r.altitude)):0,max=document.querySelector('input[name=sky]:checked').value==='90'?90:Math.max(15,Math.ceil(peak/15)*15);const x=a=>35+a/360*250,y=a=>365-a/max*335;
 for(let a=0;a<=max;a+=15){draw(sky,'line',{x1:35,y1:y(a),x2:285,y2:y(a),stroke:'#cbd7e8','stroke-width':.8});draw(sky,'text',{x:27,y:y(a)+4,'text-anchor':'end','font-size':11,fill:'#315070'},a);}
 ['북','동','남','서','북'].forEach((s,i)=>draw(sky,'text',{x:x(i*90),y:389,'font-size':12,'text-anchor':'middle'},s));
 if(rows.length){draw(sky,'line',{x1:35,y1:y(peak),x2:285,y2:y(peak),stroke:'#637fa2','stroke-dasharray':'12 5'});draw(sky,'text',{x:39,y:y(peak)-7,'font-size':11,fill:'#34577e'},`${peak.toFixed(1)}°`);for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];if(Math.abs(a.azimuth-b.azimuth)>180)continue;draw(sky,'line',{x1:x(a.azimuth),y1:y(a.altitude),x2:x(b.azimuth),y2:y(b.altitude),stroke:b.state==='building'?'#f3a0aa':colors[b.state],'stroke-width':3.5,'stroke-linecap':'round'});}const r=result.rows[minute];if(r?.altitude>=0)draw(sky,'circle',{cx:x(r.azimuth),cy:y(r.altitude),r:6,fill:'none',stroke:'#087bd1','stroke-width':2});}}
function runs(){const list=[];for(const r of result?.rows||[]){const prev=list.at(-1);if(prev&&prev.state===r.state)prev.end=r.minute+1;else list.push({state:r.state,start:r.minute,end:r.minute+1});}return list;}
function drawTimeline(){const node=$('timeline');node.replaceChildren();const x=m=>20+(m-300)/960*920,list=runs().filter(r=>r.end>300&&r.start<1260);draw(node,'rect',{x:20,y:28,width:920,height:26,fill:'#e8edf3'});
 for(const r of list)draw(node,'rect',{x:x(Math.max(300,r.start)),y:28,width:x(Math.min(1260,r.end))-x(Math.max(300,r.start)),height:26,fill:colors[r.state]});
 for(const r of list){const l=x(Math.max(300,r.start)),right=x(Math.min(1260,r.end));if(['building','terrain','back'].includes(r.state)&&right-l<3)draw(node,'rect',{x:Math.min(937,Math.max(20,(l+right)/2-1.5)),y:28,width:3,height:26,fill:colors[r.state]});if(r.state==='sun')draw(node,'text',{x:(l+right)/2,y:17,'font-size':11,'text-anchor':'middle',fill:'#25683d'},duration(r.end-r.start));}
 for(const m of [300,360,720,1080,1260])draw(node,'text',{x:x(m),y:74,'font-size':11,'text-anchor':'middle',fill:'#29465d'},time(m));
 const ends=[-Infinity,-Infinity,-Infinity];for(const r of list.slice(1)){const xx=x(r.start);let level=ends.findIndex(last=>xx-last>42);if(level<0)level=ends.indexOf(Math.min(...ends));ends[level]=xx;const yy=91+level*16;draw(node,'line',{x1:xx,y1:54,x2:xx,y2:yy-11,stroke:'#8d9cab','stroke-dasharray':'3 3','stroke-width':.7});draw(node,'text',{x:xx,y:yy,'font-size':11,'text-anchor':'middle',fill:'#29465d'},time(r.start));}
 if(minute>=300&&minute<=1260)draw(node,'line',{x1:x(minute),y1:21,x2:x(minute),y2:59,stroke:'#e4323a','stroke-width':2.5});}
function drawIntervals(){const list=result?.intervals||[],half=Math.ceil(list.length/2);for(const [side,id]of ['intervalLeft','intervalRight'].entries()){const table=$(id);table.replaceChildren();const head=table.createTHead().insertRow();for(const title of ['번호','차폐 종류','원인','시작 시각','종료 시각']){const th=document.createElement('th');th.textContent=title;head.append(th);}const body=table.createTBody();list.slice(side*half,(side+1)*half).forEach((item,i)=>{const tr=body.insertRow();for(const value of [side*half+i+1,names[item.key[0]],item.key[1],time(item.start),time(item.end)])tr.insertCell().textContent=value;});}}
function render(){if(!scene)return;$('dateDisplay').value=day;$('ox').value=fmt(scene.observer[0],3);$('oy').value=fmt(scene.observer[1],3);if(document.activeElement!==$('oz'))$('oz').value=fmt(scene.observer[2],3);$('facing').value=['북','북동','동','남동','남','남서','서','북서'][Math.floor((scene.facing+22.5)%360/45)];$('clock').textContent=Number.isFinite(minute)?time(minute):'—';const r=result?.rows[minute];$('state').textContent=r?(r.state==='building'?`${r.blocker}에 의해 차단`:names[r.state]):'계산 중';$('state').style.color=textColors[r?.state]||'#758799';$('altitude').textContent=r?`${r.altitude.toFixed(1)}°`:'—';$('azimuth').textContent=r?`${r.azimuth.toFixed(1)}°`:'—';if(result)$('summary').textContent=`가조시간 ${duration(result.baseline_minutes)} | 일조시간 ${duration(result.sun_minutes)} | 최장연속 ${duration(result.longest_minutes)}`;drawMap();drawSpec();drawSky();drawTimeline();drawIntervals();}
function seek(value,daylight=false){if(!result)return;const range=daylight?result.daylight:[300,1260];if(!range)return;minute=Math.max(range[0],Math.min(range[1],Math.round(value)));render();}
function rewind(){stop();if(result?.daylight)seek(result.daylight[0],true);}
function play(){if(!paused){stop();return;}if(!result?.daylight)return;const [start,end]=result.daylight;if(minute>=end||minute<start)minute=start;paused=false;$('play').textContent='Ⅱ 일시정지';render();playTimer=setInterval(()=>{const step=+$('step').value;seek(Math.min(end,(Math.floor(minute/step)+1)*step),true);if(minute>=end)stop();},150);}
function activeDialog(){return [...document.querySelectorAll('dialog[open]')].at(-1);}
function openDialog(id){stop();$(id).showModal();$(id).querySelector('input:not([readonly]),button')?.focus();}
function dateYear(){const raw=$('year').value.trim();if(!raw)return +today().slice(0,4);if(!/^\d{2,4}$/.test(raw))throw new Error('년도는 숫자 2~4자리로 입력하세요.');const year=+(raw.length===2?'20'+raw:raw.length===3?'2'+raw:raw);if(year<1||year>9999)throw new Error('올바른 년도를 입력하세요.');return year;}
function parseDay(text,year){text=text.replace(/^\D*/,'');const separated=text.match(/^(\d{1,2})[\W_]+(\d{1,2})/);let candidates=[];if(separated)candidates=[[+separated[1],+separated[2]]];else{const digits=(text.match(/^\d+/)?.[0]||'').slice(0,4);if(digits.length===2)candidates=[[+digits[0],+digits[1]]];if(digits.length===3)candidates=[[+digits[0],+digits.slice(1)],[+digits.slice(0,2),+digits[2]]];if(digits.length===4)candidates=[[+digits.slice(0,2),+digits.slice(2)]];}const valid=new Set();for(const [m,d]of candidates){const dt=new Date(0);dt.setUTCFullYear(year,m-1,d);if(dt.getUTCFullYear()===year&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d)valid.add(`${String(year).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);}if(valid.size>1)throw new Error('두 날짜로 해석됩니다. 월/일 또는 MMDD 형식으로 다시 입력하세요.');if(!valid.size)throw new Error('존재하는 월·일을 입력하세요.');return [...valid][0];}
function setDay(value,button){day=value;document.querySelectorAll('.dates button').forEach(b=>b.classList.toggle('selected',b===button));minute=NaN;invalidate(0);}
document.querySelectorAll('[data-season]').forEach(button=>button.onclick=async()=>{try{const dates=await rpc('seasons',{year:dateYear()});button.title=button.dataset.season==='0'?`춘분 ${dates[0]} / 추분 ${dates[2]}`:dates[+button.dataset.season];setDay(dates[+button.dataset.season],button);}catch(e){message(e);}});
$('today').onclick=()=>setDay(today(),$('today'));
$('applyDate').onclick=()=>{try{setDay(parseDay($('monthDay').value,dateYear()));}catch(e){message(e);}};
for(const id of ['year','monthDay'])$(id).onkeydown=e=>{if(e.key==='Enter')$('applyDate').click();};
$('play').onclick=play;$('rewind').onclick=rewind;
for(const id of ['buildings','terrain'])$(id).onchange=()=>invalidate(0);
let elevationTimer;
$('oz').oninput=()=>{clearTimeout(elevationTimer);elevationTimer=setTimeout(async()=>{if($('oz').value==='')return;const next=clone(scene);next.observer[2]=+$('oz').value;try{await commit(next);}catch(e){message(e);}},350);};
document.querySelectorAll('input[name=sky]').forEach(el=>el.onchange=drawSky);
let timelineDrag=false;
$('timeline').onpointerdown=e=>{if(!result)return;stop();timelineDrag=true;$('timeline').setPointerCapture(e.pointerId);seek(300+(clientPoint(e,$('timeline')).x-20)/920*960);};
$('timeline').onpointermove=e=>{if(timelineDrag)seek(300+(clientPoint(e,$('timeline')).x-20)/920*960);};
$('timeline').onpointerup=$('timeline').onpointercancel=()=>timelineDrag=false;
$('map').onwheel=e=>{e.preventDefault();const [x,y]=worldPoint(e),ratio=Math.exp(Math.sign(e.deltaY)*.12),span=Math.max(40,Math.min(2400,view.span*ratio)),r=span/view.span;view={x:x+(view.x-x)*r,y:y+(view.y-y)*r,span};drawMap();};
$('map').onpointerdown=async e=>{if(e.button!==0||committing)return;$('map').focus();stop();const p=worldPoint(e);if(placement){const next=clone(scene),ground=groundAt(next,...p);if(ground===null){message('지형 범위 안에 배치하세요.');return;}const b=clone(placement);b.footprint=b.footprint.map(([x,y])=>[x+p[0],y+p[1]]);b.base_z=ground;next.buildings.push(b);try{await commit(next);selected=scene.buildings.length-1;placement=null;render();}catch(err){message(err);}return;}
 const observer=e.target.hasAttribute('data-observer');let index=observer?scene.observer_building:null;
 if(!observer){for(let i=scene.buildings.length-1;i>=0;i--)if(inside(...p,scene.buildings[i].footprint)){index=i;break;}}
 if(index===null){selected=null;drawSpec();return;}selected=index;drag={before:clone(scene),point:p,index,observer,moved:false};$('map').setPointerCapture(e.pointerId);render();};
$('map').onpointermove=e=>{if(!drag)return;const p=worldPoint(e),next=clone(drag.before);if(drag.observer)snap(next,...p);else translate(next,drag.index,p[0]-drag.point[0],p[1]-drag.point[1]);drag.moved=true;scene=next;drawMap();drawSpec();$('ox').value=fmt(scene.observer[0],3);$('oy').value=fmt(scene.observer[1],3);};
async function finishDrag(cancel=false){if(!drag)return;const state=drag,next=scene;scene=state.before;drag=null;if(state.moved&&!cancel){try{await commit(next);}catch(e){message(e);}}render();}
$('map').onpointerup=()=>finishDrag();$('map').onpointercancel=()=>finishDrag(true);
$('map').ondblclick=e=>{const p=worldPoint(e);let i=scene.buildings.findIndex(b=>inside(...p,b.footprint));if(i>=0)openBuilding(i);};
$('map').onkeydown=async e=>{if(selected===null||committing)return;const delta={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,.1],ArrowDown:[0,-.1]}[e.key];if(delta){e.preventDefault();const next=clone(scene);translate(next,selected,...delta);try{await commit(next);}catch(err){message(err);}}else if(e.key==='Delete'){e.preventDefault();if(selected===scene.observer_building){message('거주 건물은 삭제할 수 없습니다.');return;}const next=clone(scene);next.buildings.splice(selected,1);if(selected<next.observer_building)next.observer_building--;try{await commit(next);selected=null;render();}catch(err){message(err);}}};
$('notices').onclick=()=>openDialog('noticeDialog');
$('reset').onclick=async()=>{if(committing)return;try{await commit(clone(initialScene));selected=null;view={x:-80,y:40,span:160};minute=NaN;render();}catch(e){message(e);}};
// Shared add/edit form. Cancel leaves the scene unchanged.
const form=$('buildingForm'),field=name=>form.elements.namedItem(name);
let editing=null,shapeDirty=false,previewRevision=0,previewTimer,previewPoly=null,xSign=1,ySign=-1;
function parameters(){const p={shape:field('shape').value,mode:field('mode').value};for(const k of ['width','depth','vx','vy','dx','dy','arm','thickness','rotation'])p[k]=Number(field(k).value);if(p.mode==='triangle')p.thickness=Number(field('rectDepth').value);if(Object.values(p).some(v=>typeof v==='number'&&!Number.isFinite(v)))throw new Error('유한한 숫자를 입력하세요.');return p;}
function shapeVisibility(){const s=field('shape').value,m=field('mode').value;form.querySelectorAll('.barsOnly').forEach(el=>el.hidden=s!=='bars');form.querySelectorAll('.yOnly').forEach(el=>el.hidden=s!=='y');form.querySelectorAll('.triangleOnly').forEach(el=>el.hidden=s!=='y'||m!=='triangle');$('horizontalHeading').textContent=s==='bars'?'가로바':'값';field('width').disabled=field('depth').disabled=s==='y'&&m==='triangle';field('thickness').disabled=s==='y'&&m==='triangle';}
function paintPreview(poly){previewPoly=poly;const node=$('preview');node.replaceChildren();if(!poly)return;const bb=bounds(poly),span=Math.max(bb.x1-bb.x0,bb.y1-bb.y0)*1.3;polygon(node,poly.map(([x,y])=>[120+x/span*220,120-y/span*220]),{fill:'#8192a4',stroke:'#425364','stroke-width':2});draw(node,'text',{x:10,y:18,'font-size':12,fill:'#2d526b'},'N ↑ 평면 미리보기');}
async function updatePreview(){const rev=++previewRevision;try{const poly=editing!==null&&!shapeDirty?scene.buildings[editing].footprint.map(([x,y])=>{const c=center(scene.buildings[editing]);return [x-c[0],y-c[1]];}):await rpc('shape',{parameters:parameters()});if(rev===previewRevision){paintPreview(poly);form.querySelector('.dialogError').textContent='';}}catch(e){if(rev===previewRevision){paintPreview(null);form.querySelector('.dialogError').textContent=e.message;}}}
function openBuilding(index=null){if(committing||drag)return;editing=index;shapeDirty=false;const b=index===null?null:scene.buildings[index],c=b?center(b):center(target()),tc=center(target()),bb=b?bounds(b.footprint):null;
 form.reset();const defaults={name:b?.name||'새 건물',category:index===scene.observer_building?'거주 건물':'주변 건물',x:Math.abs(c[0]-tc[0]),y:Math.abs(c[1]-tc[1]),base:b?.base_z||0,width:bb?bb.x1-bb.x0:40,depth:bb?bb.y1-bb.y0:12,height:b?.height||30,vx:12,vy:40,dx:0,dy:0,thickness:12,arm:20,rectDepth:12,rotation:0};for(const [k,v]of Object.entries(defaults))field(k).value=v;
 if(b?.web_shape){const p=b.web_shape;for(const [k,v]of Object.entries(p))if(field(k))field(k).value=v;field('rectDepth').value=p.thickness;}
 xSign=c[0]<tc[0]?-1:1;ySign=c[1]>tc[1]?1:-1;$('xDir').textContent=xSign===1?'동':'서';$('yDir').textContent=ySign===-1?'남':'북';const own=index===scene.observer_building;field('x').readOnly=field('y').readOnly=own;$('xDir').disabled=$('yDir').disabled=own;
 $('buildingHeading').textContent=b?'건물 정보 수정':'건물 추가';$('saveBuilding').innerHTML=b?'확인<br>(Shift+Enter)':'지도에 배치<br>(Shift+Enter)';form.querySelector('.dialogError').textContent='';shapeVisibility();openDialog('buildingDialog');updatePreview();}
$('add').onclick=()=>openBuilding();$('editSelected').onclick=()=>{if(selected!==null)openBuilding(selected);};
$('xDir').onclick=()=>{xSign*=-1;$('xDir').textContent=xSign===1?'동':'서';};$('yDir').onclick=()=>{ySign*=-1;$('yDir').textContent=ySign===-1?'남':'북';};
form.onsubmit=e=>e.preventDefault();
form.oninput=e=>{if(['width','depth','vx','vy','dx','dy','arm','thickness','rectDepth','rotation','shape','mode'].includes(e.target.name)){shapeDirty=true;if(e.target.name==='shape'){field('width').value=40;field('depth').value=field('shape').value==='i'?12:40;}shapeVisibility();clearTimeout(previewTimer);previewTimer=setTimeout(updatePreview,350);}};
document.querySelectorAll('[data-turn]').forEach(b=>b.onclick=()=>{field('rotation').value=(Number(field('rotation').value)+Number(b.dataset.turn)+360)%360;shapeDirty=true;updatePreview();});
['┌','┬','┐','├','┼','┤','└','┴','┘'].forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.textContent=s;b.onclick=()=>{field('dx').value=(i%3-1)*(Number(field('width').value)-Number(field('vx').value))/2;field('dy').value=(1-Math.floor(i/3))*(Number(field('vy').value)-Number(field('depth').value))/2;shapeDirty=true;updatePreview();};$('presets').append(b);});
let savingBuilding=false;
$('saveBuilding').onclick=async()=>{if(savingBuilding||!form.reportValidity())return;savingBuilding=true;$('saveBuilding').disabled=true;try{const p=parameters(),poly=editing!==null&&!shapeDirty?scene.buildings[editing].footprint.map(([x,y])=>{const c=center(scene.buildings[editing]);return [x-c[0],y-c[1]];}):await rpc('shape',{parameters:p});const height=Number(field('height').value),base=Number(field('base').value);if(!Number.isFinite(height)||height<=0||!Number.isFinite(base))throw new Error('높이는 양수, 기초 표고는 유한한 숫자로 입력하세요.');const b={name:field('name').value.trim(),height,base_z:base,footprint:poly};if(!b.name)throw new Error('건물 이름을 입력하세요.');if(shapeDirty||editing===null)b.web_shape=p;else if(scene.buildings[editing].web_shape)b.web_shape=clone(scene.buildings[editing].web_shape);
 if(editing===null){placement=b;message('배치도에서 건물 중심 위치를 클릭하세요. Esc: 배치 취소');}
 else{const next=clone(scene),tc=center(target()),old=next.buildings[editing],bc=editing===scene.observer_building?tc:[tc[0]+xSign*Number(field('x').value),tc[1]+ySign*Number(field('y').value)];b.footprint=poly.map(([x,y])=>[x+bc[0],y+bc[1]]);next.buildings[editing]=b;if(editing===scene.observer_building){next.observer[2]+=base-old.base_z;snap(next,next.observer[0],next.observer[1]);}await commit(next);selected=editing;render();}
 $('buildingDialog').close();
 }catch(e){form.querySelector('.dialogError').textContent=e.message;}finally{savingBuilding=false;$('saveBuilding').disabled=false;}};
// Floor-height helper, shared by observation and building-height fields.
let floorDestination='observer',floorTimer;
function floorValue(){let floor=Number($('floorNumber').value),height=Number($('floorHeight').value),ceiling=Number($('ceiling').value);if(![$('floorNumber'),$('floorHeight'),$('ceiling')].every(el=>el.value!==''))throw new Error('세 값을 입력하세요.');if(![floor,height,ceiling].every(Number.isFinite)||floor<.5||height<=0||ceiling<0)throw new Error('층수는 0.5 이상, 층고는 양수로 입력하세요.');if(!Number.isInteger(floor))floor=Math.floor(floor)+.5;height=+height.toFixed(3);ceiling=+ceiling.toFixed(3);$('floorNotice').textContent='';if(floorDestination==='observer'){const max=target().base_z+target().height,maxFloor=Math.floor(((max-ceiling)/height+1)*2)/2;if((floor-1)*height+ceiling>max){if(maxFloor<.5)throw new Error('현재 층고와 천장고로는 건물 높이 안에 배치할 수 없습니다.');floor=maxFloor;$('floorNotice').textContent='최대치로 자동변경';}}$('floorNumber').value=fmt(floor,3);$('floorHeight').value=fmt(height,3);$('ceiling').value=fmt(ceiling,3);const z=(floor-1)*height+ceiling;$('floorResult').value=fmt(z,3);return z;}
function updateFloor(){try{floorValue();}catch(e){$('floorResult').value='';$('floorNotice').textContent=e.message;}}
function openFloor(destination){floorDestination=destination;openDialog('floorDialog');updateFloor();}
$('observerFloor').onclick=()=>openFloor('observer');$('buildingFloor').onclick=()=>openFloor('building');
for(const id of ['floorNumber','floorHeight','ceiling'])$(id).oninput=()=>{clearTimeout(floorTimer);floorTimer=setTimeout(updateFloor,350);};
$('floorReset').onclick=()=>{$('floorNumber').value=12;$('floorHeight').value=2.7;$('ceiling').value=2.3;updateFloor();};
$('floorApply').onclick=async()=>{try{const z=floorValue();if(floorDestination==='building'){if(z<=0)throw new Error('건물 높이는 0보다 커야 합니다.');field('height').value=fmt(z,3);}else{const next=clone(scene);next.observer[2]=z;await commit(next);}$('floorDialog').close();}catch(e){$('floorNotice').textContent=e.message;}};
// Terrain mesh editor; shared vertices are edited together, then validated on Apply.
let terrainDraft=[],terrainOriginal=[],terrainSelection=new Set(),terrainNodes=[],terrainTimer,terrainDirty=false,terrainZTimer;
const pointKey=p=>`${p[0]},${p[1]}`;
function paintTerrain(){const node=$('terrainMap');node.replaceChildren();const unique=new Map();terrainDraft.flat().forEach(p=>unique.set(pointKey(p),p));terrainNodes=[...unique.values()];if(!terrainNodes.length)return;const bb=bounds(terrainNodes),span=Math.max(bb.x1-bb.x0,bb.y1-bb.y0)||1,project=([x,y])=>[20+(x-bb.x0)/span*360,380-(y-bb.y0)/span*360],heights=terrainNodes.map(p=>p[2]),low=Math.min(...heights),high=Math.max(...heights);for(const tri of terrainDraft){const z=tri.reduce((s,p)=>s+p[2],0)/3;polygon(node,tri.map(project),{fill:`hsl(120 18% ${90-(z-low)/(high-low||1)*43}%)`,stroke:'#9cb29d','stroke-width':.6});}for(const b of scene.buildings)polygon(node,b.footprint.map(project),{fill:'#78899a',opacity:.7});terrainNodes.forEach((p,i)=>{const [x,y]=project(p),chosen=terrainSelection.has(pointKey(p));draw(node,'circle',{cx:x,cy:y,r:chosen?6:4,fill:chosen?'#e48b27':'#216997','data-point':i});if(terrainNodes.length<=81||chosen)draw(node,'text',{x:x+6,y:y-5,'font-size':10,'pointer-events':'none'},fmt(p[2],1));});}
function openTerrain(){terrainOriginal=clone(scene.terrain);terrainDraft=clone(scene.terrain);terrainSelection.clear();terrainDirty=false;$('terrainDialog').querySelector('.dialogError').textContent='';clearTimeout(terrainTimer);clearTimeout(terrainZTimer);openDialog('terrainDialog');paintTerrain();}
function generateTerrain(){terrainDirty=false;const w=+$('terrainWidth').value,d=+$('terrainDepth').value,n=+$('terrainCells').value,low=+$('terrainLow').value,high=+$('terrainHigh').value,kind=$('terrainKind').value;if(![w,d,low,high].every(Number.isFinite)||w<=0||d<=0||(kind!=='flat'&&high<low)){terrainDirty=true;throw new Error('양수 범위와 평지 이상인 언덕 표고를 입력하세요.');}const c=center(target()),point=(i,j)=>{const progress={flat:0,south:1-j/n,north:j/n,east:i/n,west:1-i/n}[kind];return [c[0]+w*(i/n-.5),c[1]+d*(j/n-.5),low+(high-low)*Math.max(0,(progress-.75)*4)];};const mesh=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++){const a=point(i,j),b=point(i+1,j),c=point(i+1,j+1),d=point(i,j+1);mesh.push([a,b,c],[a,c,d]);}terrainDraft=mesh;terrainSelection.clear();paintTerrain();}
$('terrainEdit').onclick=openTerrain;
for(const id of ['terrainKind','terrainWidth','terrainDepth','terrainCells','terrainLow','terrainHigh'])$(id).oninput=()=>{terrainDirty=true;clearTimeout(terrainTimer);terrainTimer=setTimeout(()=>{try{generateTerrain();$('terrainDialog').querySelector('.dialogError').textContent='';}catch(e){$('terrainDialog').querySelector('.dialogError').textContent=e.message;}},500);};
$('terrainMap').onclick=e=>{const id=e.target.getAttribute('data-point');if(id===null)return;const point=terrainNodes[+id],key=pointKey(point);if(!e.shiftKey)terrainSelection.clear();if(terrainSelection.has(key))terrainSelection.delete(key);else terrainSelection.add(key);$('terrainZ').value=fmt(point[2],3);paintTerrain();};
$('allTerrain').onclick=()=>{terrainSelection=new Set(terrainNodes.map(pointKey));paintTerrain();};$('clearTerrain').onclick=()=>{terrainSelection.clear();paintTerrain();};
function applyTerrainZ(){clearTimeout(terrainZTimer);terrainZTimer=null;if(!terrainSelection.size)return;const z=Number($('terrainZ').value);if($('terrainZ').value===''||!Number.isFinite(z))throw new Error('표고를 숫자로 입력하세요.');terrainDraft=terrainDraft.map(tri=>tri.map(p=>terrainSelection.has(pointKey(p))?[p[0],p[1],z]:p));paintTerrain();}
$('terrainZ').oninput=()=>{clearTimeout(terrainZTimer);terrainZTimer=setTimeout(()=>{try{applyTerrainZ();}catch(e){$('terrainDialog').querySelector('.dialogError').textContent=e.message;}},350);};
$('terrainReset').onclick=()=>{clearTimeout(terrainTimer);clearTimeout(terrainZTimer);terrainZTimer=null;terrainDirty=false;terrainDraft=clone(terrainOriginal);terrainSelection.clear();$('terrainDialog').querySelector('.dialogError').textContent='';paintTerrain();};
$('terrainApply').onclick=async()=>{try{clearTimeout(terrainTimer);if(terrainDirty)generateTerrain();if(terrainZTimer)applyTerrainZ();const next=clone(scene);next.terrain=clone(terrainDraft);await commit(next);$('terrainDialog').close();}catch(e){$('terrainDialog').querySelector('.dialogError').textContent=e.message;}};
$('terrainDialog').addEventListener('close',()=>{clearTimeout(terrainTimer);clearTimeout(terrainZTimer);});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.addEventListener('keydown',e=>{const modal=activeDialog();if(modal){if(e.key==='Enter'){e.preventDefault();if(e.shiftKey)({buildingDialog:$('saveBuilding'),floorDialog:$('floorApply'),terrainDialog:$('terrainApply')})[modal.id]?.click();}if(e.key==='F5'){e.preventDefault();({floorDialog:$('floorReset'),terrainDialog:$('terrainReset')})[modal.id]?.click();}return;}if(!scene||$('application').inert)return;
 const editable=e.target.matches('input,textarea,select,[contenteditable=true]');if(editable)return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();history(e.shiftKey);return;}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();history(true);return;}if(e.ctrlKey||e.metaKey||e.altKey)return;
 if(e.key==='F3'){e.preventDefault();$('add').click();}else if(e.key==='F5'){e.preventDefault();$('reset').click();}else if(e.code==='Space'){e.preventDefault();play();}else if(e.code==='KeyR'||['r','R','ㄱ','ㄲ'].includes(e.key)){e.preventDefault();rewind();}else if(['KeyK','KeyL','Comma','Period'].includes(e.code)){e.preventDefault();stop();seek(minute+({KeyK:-5,KeyL:5,Comma:-1,Period:1}[e.code]),true);}else if(e.key==='Escape'&&placement){placement=null;message('건물 배치를 취소했습니다.');}});
async function boot(){for(const [key,label]of Object.entries({sun:'직사광',building:'건물 차폐',terrain:'지형 차폐',back:'창 뒤편',night:'태양이 지평선 아래'})){const span=document.createElement('span'),square=document.createElement('i');square.style.background=colors[key];span.style.color=textColors[key];span.append(square,document.createTextNode(label));$('legend').append(span);}try{scene=await rpc('init');initialScene=clone(scene);$('loading').hidden=true;$('application').inert=false;minute=NaN;invalidate(0);}catch(e){$('loading').className='error';$('loading').textContent=`계산 엔진을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요. ${e.message}`;}}
boot();
