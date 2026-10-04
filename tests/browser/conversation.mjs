import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {RULES} from '../../src/engine.js';

const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1',evolutionMode:'sparse',roomWorkers:false});
let browser;
try {
  const {port}=await app.listen(),url=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,executablePath:values.executable});
  const a=await browser.newPage({viewport:{width:1440,height:1000}}),b=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],connections=[];
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',ws=>connections.push(ws.url()));}
  await a.goto(url);await a.locator('#enter-lobby').click();await a.locator('#commander-name').fill('Alpha');await a.locator('#create-room').click();
  await a.locator('#room-detail').waitFor();const room=[...app.rooms.values()][0];
  await b.goto(url);await b.locator('#enter-lobby').click();await b.locator('#commander-name').fill('Beta');await b.locator('#join-code').fill(room.code);await b.locator('#join-room').click();await b.locator('#ready-game').click();
  await a.locator('#start-game').click();for(const page of [a,b])await page.locator('#game.active').waitFor();
  for(const page of [a,b])await page.waitForFunction(()=>document.querySelector('#chat-connection').textContent.startsWith('已连接'));
  assert.equal(connections.filter(url=>url.endsWith('/ws/chat')).length,2);
  room.game.cardDrawTimes=[];
  room.game.event('capture',1,'通讯面板测试事件');
  await a.waitForFunction(()=>Number(document.querySelector('#generation').textContent.replace('GEN ',''))>=10);
  assert.equal(room.conversation.entries.length,0,'battle events are not recorded in the chat channel');
  assert.ok(!(await a.locator('#conversation-preview').textContent()).includes('通讯面板测试事件'));
  assert.ok((await a.locator('#event-feed .panel-heading').textContent()).includes('通讯'));
  // Produce bursts through normal game-state delivery, including multiple
  // seconds of continued attacks, and verify only one alert can coexist.
  await a.evaluate(()=>{
    window.attackAlertPeak=0;
    new MutationObserver(()=>{window.attackAlertPeak=Math.max(window.attackAlertPeak,document.querySelectorAll('.toast[data-toast-key="base-attack"]').length);})
      .observe(document.body,{childList:true,subtree:true});
  });
  const originalState=room.game.state;
  const burst=cycle=>{room.game.state=function(viewer){const state=originalState.call(this,viewer);
    if(viewer===1&&state.generation%Math.max(1,Math.round(RULES.hz))===0)state.events=[...state.events,...Array.from({length:5},(_,i)=>
      ({type:'damage',player:1,text:`警报测试 ${cycle}/${i}`,generation:state.generation,time:Date.now()}))];return state;};};
  burst(1);await a.locator('.toast[data-toast-key="base-attack"]').waitFor();
  await new Promise(resolve=>setTimeout(resolve,2200));
  assert.equal(await a.locator('.toast[data-toast-key="base-attack"]').count(),1);
  assert.equal(await a.evaluate(()=>window.attackAlertPeak),1);
  room.game.state=originalState;await a.locator('.toast[data-toast-key="base-attack"]').waitFor({state:'detached'});
  burst(2);await a.locator('.toast[data-toast-key="base-attack"]').waitFor();room.game.state=originalState;
  assert.equal(await a.locator('.toast[data-toast-key="base-attack"]').count(),1,'a later attack can warn again after the first alert expires');
  assert.equal(await a.evaluate(()=>window.attackAlertPeak),1);
  const heading=a.locator('#event-feed .panel-heading');
  await heading.click();assert.equal(await a.locator('#event-feed').evaluate(el=>el.classList.contains('collapsed')),true);
  const rect=await heading.boundingBox();
  await a.mouse.move(rect.x+90,rect.y+15);await a.mouse.down();await a.mouse.move(rect.x+170,rect.y+45,{steps:8});await a.mouse.up();
  assert.ok(await a.locator('#event-feed').evaluate(el=>el.style.transform.includes('translate')));
  assert.equal(await a.locator('#event-feed').evaluate(el=>el.classList.contains('collapsed')),true,'drag does not toggle collapse');
  await heading.click();await a.locator('#conversation-preview').click();
  await a.locator('#conversation-dialog[open]').waitFor();assert.equal(await a.locator('#chat-input').evaluate(el=>el===document.activeElement),true);
  assert.equal(await a.locator('#chat-input').evaluate(el=>el.tagName),'INPUT');
  const transform=await a.locator('#transform-label').textContent();
  const malicious='<img src=x onerror="window.chatInjected=true">你好';
  await a.locator('#chat-input').fill(malicious);await a.locator('#chat-input').press('Enter');
  await b.waitForFunction(text=>document.querySelector('#conversation-preview').textContent.includes(text),malicious);
  await a.waitForFunction(()=>document.querySelector('#chat-input').value==='');
  assert.equal(await a.locator('#transform-label').textContent(),transform);
  assert.equal(await a.locator('#conversation-history img').count(),0);assert.equal(await a.evaluate(()=>window.chatInjected),undefined);
  assert.equal(await a.locator('#conversation-history time, #conversation-preview time').count(),0);
  await b.evaluate(()=>document.activeElement.blur());await b.keyboard.press('Enter');await b.locator('#conversation-dialog[open]').waitFor();
  await b.locator('#chat-input').fill('中文输入');
  await b.locator('#chat-input').evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));});
  assert.equal(room.conversation.entries.filter(e=>e.kind==='chat').length,1);
  await b.locator('#chat-input').evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await b.locator('#chat-input').press('Shift+Enter');
  assert.equal(await b.locator('#chat-input').inputValue(),'中文输入');
  assert.equal(room.conversation.entries.length,1,'Shift+Enter cannot create a line break or submit the single-line input');
  await b.locator('#chat-input').press('r');
  await b.locator('#chat-input').press('Enter');
  await a.waitForFunction(()=>document.querySelector('#conversation-history').textContent.includes('中文输入'));
  // Lose the response after server acceptance: reconnect must confirm the same
  // request from history without duplicating it or discarding another draft.
  const held=room.members[0].chat,originalSend=held.send;
  held.send=function(raw,...args){const msg=JSON.parse(raw);if(['conversation','chat_sent'].includes(msg.type))return;return originalSend.call(this,raw,...args);};
  await a.locator('#chat-input').fill('确认丢失后恢复');await a.locator('#chat-input').press('Enter');
  await a.waitForFunction(()=>document.querySelector('#chat-connection').textContent==='正在发送…');
  const deadline=Date.now()+3000;
  while(!room.conversation.entries.some(e=>e.text==='确认丢失后恢复')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
  held.send=originalSend;held.close();
  await a.waitForFunction(()=>document.querySelector('#chat-input').value==='');
  assert.equal(room.conversation.entries.filter(e=>e.text==='确认丢失后恢复').length,1);
  mkdirSync('artifacts/conversation',{recursive:true});
  await a.keyboard.press('Escape');await a.screenshot({path:'artifacts/conversation/nexus-panel.png'});
  await a.locator('#conversation-preview').click();
  await a.screenshot({path:'artifacts/conversation/nexus-desktop.png'});
  // Seed a long chat history without waiting on the interactive send throttle.
  const publishChat=text=>{
    room.conversation.append({kind:'chat',playerId:2,name:'Beta',text,time:Date.now()});
    for(const member of room.members){const ws=member.chat;if(!ws)continue;
      const packet=room.conversation.packet(ws.chatCursor);ws.chatCursor=room.conversation.sequence;ws.send(JSON.stringify(packet));}
  };
  for(let i=0;i<65;i++)publishChat(`滚动测试记录 ${i}`);
  await a.waitForFunction(()=>document.querySelector('#conversation-history').textContent.includes('滚动测试记录 64'));
  await a.locator('#conversation-history').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  publishChat('阅读时收到新记录');
  await a.waitForFunction(()=>document.querySelector('#conversation-history').textContent.includes('阅读时收到新记录'));
  assert.ok(await a.locator('#conversation-history').evaluate(el=>el.scrollTop<5),'new records preserve reading position');
  assert.equal(await a.locator('#conversation-new').isVisible(),true);await a.locator('#conversation-new').click();
  assert.ok(await a.locator('#conversation-history').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<40));
  const old=room.members[0].chat;old.close();
  await a.waitForFunction(()=>document.querySelector('#chat-connection').textContent.includes('连接中'));
  await a.waitForFunction(()=>document.querySelector('#chat-connection').textContent.startsWith('已连接'));
  assert.notEqual(room.members[0].chat,old);
  publishChat('短消息');
  publishChat('名字与内容连续显示，预览可以保留两行文字。');
  publishChat('这是一条超过两行的长消息，用于检查两行以后才省略。'.repeat(5));
  await a.waitForFunction(()=>document.querySelector('#conversation-preview').textContent.includes('两行以后才省略'));
  await a.evaluate(()=>window.lifeWarTheme.set('cartoon'));await a.screenshot({path:'artifacts/conversation/cartoon-desktop.png'});
  await a.locator('#chat-input').fill('未发送的草稿');
  await a.setViewportSize({width:390,height:844});await a.screenshot({path:'artifacts/conversation/cartoon-mobile.png'});
  // Capture the mobile HUD separately from the full-screen conversation.
  await a.keyboard.press('Escape');
  for(const theme of ['nexus','cartoon']){
    await a.evaluate(theme=>window.lifeWarTheme.set(theme),theme);
    await a.screenshot({path:`artifacts/conversation/${theme}-mobile-panel.png`});
    console.log('Mobile chat layout:',await a.evaluate(()=>({
      theme:document.documentElement.dataset.theme,
      rosterWidth:document.querySelector('.roster-panel').getBoundingClientRect().width,
      chatWidth:document.querySelector('#event-feed').getBoundingClientRect().width,
      previewHeight:document.querySelector('#conversation-preview').getBoundingClientRect().height,
      timeElements:document.querySelectorAll('#conversation-preview time').length,
      previewLines:getComputedStyle(document.querySelector('#conversation-preview .conversation-record')).webkitLineClamp,
      rowDisplay:getComputedStyle(document.querySelector('#conversation-preview .conversation-record')).display
    })));
  }
  await a.locator('#conversation-preview').click();
  assert.equal(await a.locator('#conversation-history').evaluate(el=>el===document.activeElement),true,'mobile open focuses history instead of opening the keyboard');
  await a.locator('#chat-input').click();
  assert.equal(await a.locator('#chat-input').evaluate(el=>el===document.activeElement),true,'mobile input focuses only after the user taps it');
  await a.evaluate(()=>{
    Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>480});
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  const keyboardGeometry=await a.evaluate(()=>({dialog:document.querySelector('#conversation-dialog').getBoundingClientRect().height,
    input:document.querySelector('#chat-input').getBoundingClientRect().bottom,form:document.querySelector('#chat-form').getBoundingClientRect().bottom}));
  assert.equal(keyboardGeometry.dialog,480);assert.ok(keyboardGeometry.form<=480);assert.ok(keyboardGeometry.input<480);
  assert.equal(await a.locator('#chat-input').inputValue(),'未发送的草稿');
  await a.screenshot({path:'artifacts/conversation/cartoon-mobile-keyboard.png'});
  await a.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});
  await a.keyboard.press('Escape');await a.waitForFunction(()=>!document.querySelector('#conversation-dialog').open);
  await a.reload();await a.locator('#game.active').waitFor();
  await a.waitForFunction(()=>document.querySelector('#conversation-preview').textContent.includes('阅读时收到新记录'));
  await a.evaluate(()=>document.activeElement.blur());await a.keyboard.press('Enter');await a.locator('#conversation-dialog[open]').waitFor();
  assert.ok((await a.locator('#conversation-history').textContent()).includes(malicious));
  await a.keyboard.press('Escape');room.game.eliminate(2);room.game.checkVictory();
  await a.locator('#result-dialog[open]').waitFor();await a.locator('#result-chat').click();
  await a.locator('#conversation-dialog[open]').waitFor();
  assert.equal(await a.locator('#chat-connection').textContent(),'已连接 · 房间全员可见');
  assert.deepEqual(errors,[]);
  assert.equal(await a.locator('#conversation-history .event').count(),0);
  console.log('PASS: single-line chat input, IME/Enter, mobile open without input focus, two-line previews without timestamps, dedicated two-player chat, safe text, title collapse/drag, reading position, reconnect/history, single attack alert, both themes and 390px viewport with simulated 480px keyboard area');
} finally {await browser?.close();await app.close();}
