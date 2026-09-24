import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CARD_CONFIG, isTargetedCard } from '../public/cards.js';

// Exercise the existing browser handlers with a minimal DOM/event adapter.
// Keep server snapshots between pointer events: that is the regression trigger.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const interaction = app.slice(app.indexOf("const cardGridEl = $('.card-grid');"), app.indexOf('let audioContext;'));
const rendering = app.slice(app.indexOf('function renderCards('), app.indexOf('let shownDraftGen'));
const messages = app.slice(app.indexOf('function onMessage(msg)'), app.indexOf('async function loadInfo()'));

class Element {
  constructor(className = '') {
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.offsetWidth = 168;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
      remove: value => { this.className = this.className.split(' ').filter(v => v !== value).join(' '); },
    };
  }
  set innerHTML(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.html = value;
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  insertBefore(child, before) {
    child.remove();
    const index = this.children.indexOf(before);
    assert.notEqual(index, -1, 'insertion anchor must still exist');
    child.parent = this;
    this.children.splice(index, 0, child);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    if (selector === '.card' && this.classList.contains('card')) return this;
    return this.parent?.closest(selector) || null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 500, bottom: 300, width: 168, height: 235 }; }
  getContext() { return new Proxy({}, {get: (target,key) => target[key] ?? (()=>{}), set:(target,key,value)=>{target[key]=value;return true;}}); }
  setPointerCapture(id) { this.pointerId = id; }
  releasePointerCapture() { this.pointerId = null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, values = {}) {
    const event = { target: this, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: 40, clientY: 40, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

const energy = { id: 'energy_burst', name: '能量爆发', desc: '+60', type: 'buff', effect: { kind: 'energy', amount: 60 } };
const purge = { id: 'purge', name: '净化', desc: '清除', type: 'item', effect: { kind: 'purge', radius: 20 } };

function setup(card = energy) {
  const document = new Element(), grid = new Element('card-grid'), container = new Element();
  document.body = new Element();
  document.body.appendChild(container);
  container.appendChild(grid);
  document.createElement = () => new Element();
  const sent = [], frames = [];
  let frameTime = 0;
  const context = vm.createContext({
    document, browserMetrics: null, state: null, playerId: 1, battlefield: {}, CARD_CONFIG, isTargetedCard,
    formatClock: ms => `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`,
    $: selector => selector === '.card-grid' ? grid : container,
    getComputedStyle: () => ({ getPropertyValue: () => '#67f5d1' }),
    requestAnimationFrame: cb => frames.push(cb), window:{devicePixelRatio:1}, performance:{now:()=>frameTime}, escapeHTML: String, toast() {}, sound() {},
    send: async message => { sent.push(message); return true; },
  });
  vm.runInContext(interaction + '\n' + rendering + '\n' + messages, context);
  const update = card => {
    // WebSocket JSON decoding produces a new object on every state update.
    context.state = { cards: { hand: [card ? structuredClone(Array.isArray(card) ? card : [card]) : []] } };
    vm.runInContext('renderCards()', context);
  };
  update(card);
  return { context, document, grid, sent, update,
    animate: () => { for(let i=0;frames.length && i<200;i++){frameTime+=50;const callbacks=frames.splice(0);for(const cb of callbacks)cb(frameTime);}assert.equal(frames.length,0); },
    card: () => grid.querySelector('.card'),
    event: (type, target, options = {}) => grid.emit(type, { target, ...options }) };
}

test('PC: repeated state snapshots during dragging never create a second card or replace the placeholder', () => {
  const ui = setup(), card = ui.card();
  ui.event('pointerdown', card);
  const placeholder = ui.grid.querySelector('.card-placeholder');
  assert.equal(card.parent, ui.document.body);
  for (let i = 0; i < 10; i++) ui.update(energy);
  assert.equal(ui.document.body.querySelectorAll('.card').length, 1);
  assert.equal(ui.grid.querySelector('.card-placeholder'), placeholder);
  ui.document.emit('pointerup');
  assert.equal(ui.card(), card);
  assert.equal(ui.grid.querySelector('.card-placeholder'), null);
  ui.update(energy);
  assert.equal(ui.card(), card);
});

test('touch: tap selection survives snapshots, selected card drags, cancellation returns it', () => {
  const ui = setup(), card = ui.card(), touch = { pointerType: 'touch' };
  ui.event('pointerdown', card, touch);
  ui.update(energy);
  ui.event('pointerup', card, touch);
  assert.ok(card.classList.contains('selected'));
  for (let i = 0; i < 5; i++) ui.update(energy);
  assert.equal(ui.card(), card);
  assert.ok(card.classList.contains('selected'));
  ui.event('pointerdown', card, touch);
  ui.event('pointermove', card, { ...touch, clientX: 70 });
  assert.equal(card.parent, ui.document.body);
  ui.document.emit('pointerup', { pointerId: 2 });
  assert.equal(card.parent, ui.document.body, 'a second finger must not end the drag');
  ui.document.emit('pointercancel');
  assert.equal(ui.card(), card);
  assert.equal(ui.grid.querySelector('.card-placeholder'), null);
  ui.event('pointerdown', card, touch);
  ui.event('pointerup', card, touch);
  assert.ok(!card.classList.contains('selected'), 'tapping again deselects');
});

test('touch: swiping an unselected card or the background remains available for native scrolling', () => {
  const ui = setup(), card = ui.card(), touch = { pointerType: 'touch' };
  for (const target of [card, ui.grid]) {
    assert.equal(ui.event('pointerdown', target, touch).defaultPrevented, false);
    assert.equal(ui.event('pointermove', target, { ...touch, clientX: 100 }).defaultPrevented, false);
    ui.update(energy);
    ui.event('pointerup', target, { ...touch, clientX: 100 });
    assert.ok(!card.classList.contains('selected'));
    assert.equal(ui.card(), card);
    assert.equal(ui.grid.querySelector('.card-placeholder'), null);
  }
});

test('a hand change during dragging removes the old card, placeholder and drag listeners', () => {
  const ui = setup(), card = ui.card();
  ui.event('pointerdown', card);
  ui.update(purge);
  assert.equal(card.parent, null);
  assert.equal(ui.card().dataset.cardId, 'purge');
  assert.equal(ui.document.body.querySelectorAll('.card').length, 1);
  assert.equal(ui.grid.querySelector('.card-placeholder'), null);
  assert.equal(ui.document.listeners.get('pointermove').size, 0);
  ui.document.emit('pointerup', { clientY: 600 });
  assert.equal(ui.sent.length, 0);
});

test('purge: dragging out returns one unselected card and snapshots preserve targeting', () => {
  const ui = setup(purge), card = ui.card(), touch = { pointerType: 'touch' };
  ui.event('pointerdown', card, touch);
  ui.event('pointerup', card, touch);
  ui.event('pointerdown', card, touch);
  ui.event('pointermove', card, { ...touch, clientY: 100 });
  ui.document.emit('pointerup', { ...touch, clientY: 600 });
  assert.equal(ui.card(), card);
  assert.ok(!card.classList.contains('selected'));
  ui.update(purge);
  assert.equal(ui.context.battlefield.cardTarget.cardId, 'purge');
  assert.equal(ui.document.body.querySelectorAll('.card').length, 1);
});

test('rejected play restores the hand even when the server card has not changed', () => {
  const ui = setup();
  ui.grid.innerHTML = ''; // Card has left the hand for its consumption animation.
  vm.runInContext("pendingCardPlay = {cardId:'energy_burst'}", ui.context);
  ui.update(energy);
  assert.equal(ui.card(), null, 'snapshots must not respawn a pending card');
  vm.runInContext("onMessage({ type: 'error', message: '无法使用卡牌' })", ui.context);
  assert.equal(ui.card().dataset.cardId, energy.id);
  ui.update(null);
  assert.equal(ui.card(), null);
  assert.ok(ui.grid.querySelector('.card-empty'));
});

for (const card of [energy,purge]) test(`${card.id}: no request before animation completes, including snapshots and duplicate attempts`,()=>{
  const ui=setup([card,card,energy]);
  const el=ui.card();
  if(card===purge){
    ui.event('pointerdown',el);ui.document.emit('pointerup',{clientY:600});
    assert.equal(ui.sent.length,0);
    ui.context.targetEl=el;
    vm.runInContext('playCardAnimated(targetEl,{x:400,y:410,screenX:400,screenY:410})',ui.context);
  } else { ui.event('pointerdown',el);ui.document.emit('pointerup',{clientY:600}); }
  assert.equal(ui.sent.length,0);
  ui.context.targetEl=el;vm.runInContext('playCardAnimated(targetEl)',ui.context);
  ui.update([card,card,energy,purge]);
  assert.equal(ui.sent.length,0);
  assert.equal(ui.document.body.querySelectorAll('.card').length,3,'snapshots cannot duplicate the animated card');
  ui.animate();
  assert.equal(ui.sent.length,1);
  assert.equal(ui.sent[0].cardId,card.id);
  if(card===purge)assert.equal(ui.sent[0].x,400);
  vm.runInContext(`onMessage({type:'card_played',playerId:1,cardId:'${card.id}'})`,ui.context);
  ui.update([card,energy,purge]);
  assert.equal(ui.grid.querySelectorAll('.card').length,3);
});

test('a match reset cancels delayed use, and rejected target plays restore all cards and targeting',()=>{
  const ui=setup([purge,energy]);ui.event('pointerdown',ui.card());ui.document.emit('pointerup',{clientY:600});
  ui.context.targetEl=ui.card();vm.runInContext('playCardAnimated(targetEl,{x:-1,y:20})',ui.context);
  ui.animate();assert.equal(ui.sent.length,1);
  vm.runInContext("onMessage({type:'error',message:'目标越界'})",ui.context);
  assert.equal(ui.grid.querySelectorAll('.card').length,2);
  assert.equal(ui.context.battlefield.cardTarget.cardId,'purge');
  ui.context.targetEl=ui.card();vm.runInContext('playCardAnimated(targetEl,{x:20,y:20}); pendingCardPlay=false; renderCards(true)',ui.context);
  ui.animate();assert.equal(ui.sent.length,1,'reset must invalidate the old callback');
});


test('ending a match during animation cancels play even if the hand is unchanged',()=>{
  const ui=setup();ui.event('pointerdown',ui.card());ui.document.emit('pointerup',{clientY:600});
  ui.context.state.status='finished';vm.runInContext('renderCards()',ui.context);
  ui.animate();assert.equal(ui.sent.length,0);
});
